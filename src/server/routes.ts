import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  buildTenantSheetsConfigResponse,
  completeOAuthBridgeLogin,
  completeOAuthCodeCallback,
  createNewSpreadsheetForTenant,
  disconnectTenantGoogleAccount,
  extractSpreadsheetIdFromInput,
  getTenantDatabase,
  GoogleSheetsError,
  initializeCompanySpreadsheetBaseline,
  listAvailableSpreadsheetsForTenant,
  selectExistingSpreadsheetForTenant,
  startCompanyGoogleOAuthFlow,
  TenantDatabaseNotConnectedError,
  testTenantSheetsConnection,
} from './database/databaseManager.ts';
import {
  addCompanyMembership,
  appendPlatformAuditLog,
  createPlatformUser,
  createTenantRecord,
  findPlatformUserByEmail,
  findPlatformUserById,
  getDemoMembershipByRole,
  getMembership,
  getMembershipsForUser,
  getTenantById,
  listMembersForCompany,
  listPlatformAuditLogs,
  listPlatformTenantsMetadataOnly,
  registerAgentCredentialRoute,
  resolveCompanyByCredentialHash,
  setUserRecoveryToken,
  toCompanyObject,
  updateCompanyMembershipRole,
  updatePlatformUserPassword,
  updateTenantRecord,
} from './database/tenantRegistry.ts';
import { ensureSpreadsheetSchema, getSpreadsheetMetadata } from './database/googleSheetsProvider.ts';
import { getValidTenantAccessToken } from './database/tenantConnectionManager.ts';
import {
  hashAgentCredential,
  hashPassword,
  hasRoleCapability,
  RateLimiter,
  sanitizeTextInput,
  signSessionToken,
  SUBSCRIPTION_LIMITS,
  verifyPassword,
  verifySessionToken,
  type PermissionCapability,
} from './security.ts';
import { evaluateAuthorization } from './policyEngine.ts';
import { executeAgentTestTurn, geminiProvider, getAIProvidersStatus } from './aiProvider.ts';
import { AGENT_TEMPLATES, TOOL_CATALOG } from './seedTemplates.ts';
import { executeOrResumeWorkflowGraph } from './workflowEngine.ts';
import type {
  AgentInstructions,
  AgentPermissionsConfig,
  Policy,
  SubscriptionPlan,
  UserRole,
  UserSession,
} from '../shared/types.ts';

interface AuthedRequest extends Request {
  session?: UserSession;
}

const gatewayRateLimiter = new RateLimiter(30, 60_000);
const loginRateLimiter = new RateLimiter(20, 60_000);

function asyncHandler(
  fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<void>
): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as AuthedRequest, res, next)).catch((err) => {
      if (err instanceof TenantDatabaseNotConnectedError) {
        res.status(503).json({
          error: err.message,
          code: err.code,
          connection_status: err.status,
        });
        return;
      }
      if (err instanceof GoogleSheetsError) {
        if (err.code === 'QUOTA_EXCEEDED') {
          res.status(429).json({
            error: err.message,
            code: 'GOOGLE_SHEETS_QUOTA_EXCEEDED',
          });
          return;
        }
        if (err.code === 'AUTH_ERROR') {
          res.status(401).json({
            error: err.message,
            code: 'GOOGLE_AUTH_EXPIRED',
          });
          return;
        }
        if (err.code === 'ACCESS_DENIED' || err.code === 'NOT_FOUND') {
          res.status(403).json({
            error: err.message,
            code: 'GOOGLE_SHEET_INACCESSIBLE',
          });
          return;
        }
        res.status(err.httpStatus || 502).json({
          error: err.message,
          code: err.code,
        });
        return;
      }
      const message = err instanceof Error ? err.message : 'Erro interno do servidor.';
      res.status(500).json({ error: message });
    });
  };
}

function resolveSessionFromRequest(req: AuthedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const payload = verifySessionToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Sessão inválida ou expirada. Inicie sessão novamente.' });
    return;
  }

  const user = findPlatformUserById(payload.userId);
  const membership = getMembership(payload.companyId, payload.userId);
  const tenant = getTenantById(payload.companyId);

  if (!user || !membership || !tenant || membership.status !== 'active') {
    res.status(403).json({ error: 'Conta suspensa ou sem acesso ativo a esta empresa.' });
    return;
  }

  req.session = {
    user_id: user.id,
    email: user.email,
    full_name: user.full_name,
    job_title: user.job_title,
    role: membership.role,
    company_id: tenant.company_id,
    company_name: tenant.company_name,
    subscription_plan: tenant.subscription_plan,
    is_demo_company: tenant.is_demo,
    is_platform_admin: user.is_platform_admin,
  };
  next();
}

function requireCapability(capability: PermissionCapability) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.session) {
      res.status(401).json({ error: 'Não autenticado.' });
      return;
    }
    if (!hasRoleCapability(req.session.role, capability)) {
      res.status(403).json({
        error: `Permissão insuficiente. O perfil "${req.session.role}" não está autorizado para esta operação.`,
      });
      return;
    }
    next();
  };
}

function requirePlatformAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.session?.is_platform_admin) {
    res.status(403).json({
      error: 'Acesso restrito a administradores autorizados da plataforma MANDATO.',
    });
    return;
  }
  next();
}

export function createApiRouter(): express.Router {
  const router = express.Router();

  // ========================
  // 1. AUTENTICAÇÃO & SESSÃO (PLANO DE CONTROLO DA PLATAFORMA)
  // ========================
  router.post(
    '/api/auth/login',
    asyncHandler(async (req, res) => {
      const ipKey = req.ip || 'unknown';
      if (!loginRateLimiter.check(ipKey).allowed) {
        res.status(429).json({ error: 'Demasiadas tentativas de início de sessão. Aguarde um minuto.' });
        return;
      }

      const email = sanitizeTextInput(String(req.body?.email || '')).toLowerCase();
      const password = String(req.body?.password || '');
      if (!email || !password) {
        res.status(400).json({ error: 'Indique o email e a palavra-passe.' });
        return;
      }

      const user = findPlatformUserByEmail(email);
      if (!user || !verifyPassword(password, user.password_hash)) {
        res.status(401).json({ error: 'Credenciais inválidas.' });
        return;
      }

      const activeMemberships = getMembershipsForUser(user.id).filter((m) => m.status === 'active');
      const primary = activeMemberships[0];
      const tenant = primary ? getTenantById(primary.company_id) : null;
      if (!primary || !tenant) {
        res.status(403).json({ error: 'Utilizador sem empresa ativa associada.' });
        return;
      }

      const token = signSessionToken(user.id, tenant.company_id);
      res.json({
        token,
        user: {
          user_id: user.id,
          email: user.email,
          full_name: user.full_name,
          job_title: user.job_title,
          role: primary.role,
          company_id: tenant.company_id,
          company_name: tenant.company_name,
          subscription_plan: tenant.subscription_plan,
          is_demo_company: tenant.is_demo,
          is_platform_admin: user.is_platform_admin,
        },
      });
    })
  );

  router.post(
    '/api/auth/demo-login',
    asyncHandler(async (req, res) => {
      const roleRequested = (req.body?.role as UserRole) || 'OWNER';
      const demo = getDemoMembershipByRole(roleRequested);
      if (!demo) {
        res.status(404).json({ error: 'Utilizador de demonstração não encontrado.' });
        return;
      }

      const token = signSessionToken(demo.user.id, demo.tenant.company_id);
      res.json({
        token,
        user: {
          user_id: demo.user.id,
          email: demo.user.email,
          full_name: demo.user.full_name,
          job_title: demo.user.job_title,
          role: demo.membership.role,
          company_id: demo.tenant.company_id,
          company_name: demo.tenant.company_name,
          subscription_plan: demo.tenant.subscription_plan,
          is_demo_company: demo.tenant.is_demo,
          is_platform_admin: demo.user.is_platform_admin,
        },
      });
    })
  );

  router.post(
    '/api/auth/register',
    asyncHandler(async (req, res) => {
      const fullName = sanitizeTextInput(String(req.body?.full_name || ''), 120);
      const email = sanitizeTextInput(String(req.body?.email || ''), 160).toLowerCase();
      const password = String(req.body?.password || '');
      const companyName = sanitizeTextInput(String(req.body?.company_name || ''), 120);
      const nif = sanitizeTextInput(String(req.body?.nif || ''), 30);

      if (!fullName || !email || !password || !companyName) {
        res.status(400).json({ error: 'Preencha nome completo, email, palavra-passe e nome da empresa.' });
        return;
      }
      if (password.length < 8) {
        res.status(400).json({ error: 'A palavra-passe deve ter pelo menos 8 caracteres.' });
        return;
      }

      if (findPlatformUserByEmail(email)) {
        res.status(409).json({ error: 'Já existe uma conta registada com este endereço de email.' });
        return;
      }

      const slugBase =
        companyName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'empresa';
      const slug = `${slugBase}-${crypto.randomBytes(3).toString('hex')}`;

      const user = createPlatformUser({
        email,
        passwordHash: hashPassword(password),
        fullName,
        jobTitle: 'Administrador Inicial',
      });

      const tenant = createTenantRecord({
        companyName,
        slug,
        nif: nif || '',
        sector: 'Geral',
        subscriptionPlan: 'PROFESSIONAL',
        ownerUserId: user.id,
        isDemo: false,
      });

      addCompanyMembership({
        companyId: tenant.company_id,
        userId: user.id,
        role: 'OWNER',
        status: 'active',
      });

      appendPlatformAuditLog({
        actorUserId: user.id,
        actorEmail: user.email,
        companyId: tenant.company_id,
        eventType: 'company_registered',
        detail: `Nova empresa "${companyName}" registada. Aguarda ligação da conta Google Sheets.`,
      });

      const token = signSessionToken(user.id, tenant.company_id);
      res.status(201).json({
        token,
        user: {
          user_id: user.id,
          email: user.email,
          full_name: user.full_name,
          job_title: user.job_title,
          role: 'OWNER',
          company_id: tenant.company_id,
          company_name: tenant.company_name,
          subscription_plan: tenant.subscription_plan,
          is_demo_company: false,
          is_platform_admin: user.is_platform_admin,
        },
      });
    })
  );

  router.post(
    '/api/auth/recover',
    asyncHandler(async (req, res) => {
      const email = sanitizeTextInput(String(req.body?.email || '')).toLowerCase();
      const newPassword = req.body?.new_password ? String(req.body.new_password) : null;
      const recoveryToken = req.body?.recovery_token ? String(req.body.recovery_token).trim() : null;

      if (!email) {
        res.status(400).json({ error: 'Indique o email da conta.' });
        return;
      }

      const user = findPlatformUserByEmail(email);

      if (recoveryToken && newPassword) {
        const providedHash = crypto.createHash('sha256').update(recoveryToken).digest('hex');
        const notExpired = user?.recovery_expires_at && Date.parse(user.recovery_expires_at) > Date.now();
        if (!user || !user.recovery_token_hash || user.recovery_token_hash !== providedHash || !notExpired) {
          res.status(400).json({ error: 'Código de recuperação inválido ou expirado.' });
          return;
        }
        if (newPassword.length < 8) {
          res.status(400).json({ error: 'A nova palavra-passe deve ter pelo menos 8 caracteres.' });
          return;
        }
        updatePlatformUserPassword(user.id, hashPassword(newPassword));
        res.json({ message: 'Palavra-passe atualizada com sucesso. Pode iniciar sessão.' });
        return;
      }

      if (user) {
        const rawCode = crypto.randomBytes(6).toString('hex').toUpperCase();
        const tokenHash = crypto.createHash('sha256').update(rawCode).digest('hex');
        const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
        setUserRecoveryToken(user.id, tokenHash, expiresAt);

        if (process.env.SMTP_HOST) {
          // Aqui integraria o envio SMTP real quando configurado no servidor
          console.info(`[MANDATO Auth] Pedido de recuperação emitido para ${user.email}`);
        } else {
          console.info(`[MANDATO Auth] SMTP não configurado. Código de recuperação gerado para ${user.email}: ${rawCode}`);
        }
      }

      // Nunca devolver o código secreto na resposta HTTP pública
      res.json({
        message: 'Se o endereço existir no sistema, serão enviadas instruções de recuperação válidas por 15 minutos.',
      });
    })
  );

  router.get('/api/auth/me', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    res.json({ user: req.session });
  });

  // ========================
  // 2. SISTEMA, MODELOS DE AGENTES & ESTADO DA BASE DE DADOS
  // ========================
  router.get('/api/system/status', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    const tenant = getTenantById(req.session!.company_id);
    res.json({
      ai_providers: getAIProvidersStatus(),
      database_mode: 'Google Sheets Multi-Tenant por Empresa',
      sheets_connection: tenant ? buildTenantSheetsConfigResponse(tenant) : null,
      gemini_configured: geminiProvider.isConfigured(),
      subscription_limits: SUBSCRIPTION_LIMITS[req.session!.subscription_plan],
      platform_admin_enabled: Boolean(req.session!.is_platform_admin),
    });
  });

  router.get('/api/templates', resolveSessionFromRequest, (_req: AuthedRequest, res: Response) => {
    res.json({ templates: AGENT_TEMPLATES, tool_catalog: TOOL_CATALOG });
  });

  // ========================
  // 2B. CONFIGURAÇÃO GOOGLE SHEETS POR EMPRESA (DEFINIÇÕES -> BASE DE DADOS)
  // ========================
  router.get('/api/company/sheets/config', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    const tenant = getTenantById(req.session!.company_id);
    if (!tenant) {
      res.status(404).json({ error: 'Empresa não encontrada.' });
      return;
    }
    res.json({ config: buildTenantSheetsConfigResponse(tenant) });
  });

  router.put(
    '/api/company/sheets/email',
    resolveSessionFromRequest,
    requireCapability('manage_database'),
    (req: AuthedRequest, res: Response) => {
      const enteredEmail = sanitizeTextInput(String(req.body?.entered_google_email || ''), 160).toLowerCase();
      if (enteredEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(enteredEmail)) {
        res.status(400).json({ error: 'Indique um endereço de email Google válido.' });
        return;
      }
      const tenant = getTenantById(req.session!.company_id);
      if (!tenant) {
        res.status(404).json({ error: 'Empresa não encontrada.' });
        return;
      }
      const mismatch = Boolean(
        enteredEmail && tenant.verified_google_email && enteredEmail !== tenant.verified_google_email.toLowerCase()
      );
      const updated = updateTenantRecord(req.session!.company_id, {
        entered_google_email: enteredEmail,
        email_mismatch_confirmed: mismatch ? false : tenant.email_mismatch_confirmed,
      });
      res.json({ config: buildTenantSheetsConfigResponse(updated!) });
    }
  );

  router.get(
    '/api/company/sheets/oauth/start',
    resolveSessionFromRequest,
    requireCapability('manage_database'),
    (req: AuthedRequest, res: Response) => {
      const enteredEmail = req.query.email ? sanitizeTextInput(String(req.query.email), 160).toLowerCase() : undefined;
      const flow = startCompanyGoogleOAuthFlow({
        companyId: req.session!.company_id,
        userId: req.session!.user_id,
        enteredGoogleEmail: enteredEmail,
      });
      res.json(flow);
    }
  );

  router.get(
    '/api/company/sheets/oauth/callback',
    asyncHandler(async (req, res) => {
      const state = String(req.query.state || '');
      const code = req.query.code ? String(req.query.code) : undefined;
      const err = req.query.error ? String(req.query.error) : undefined;

      try {
        const result = await completeOAuthCodeCallback({ state, code, error: err });
        const query = new URLSearchParams({
          sheets_oauth: 'success',
          verified_email: result.verifiedEmail,
          mismatch: result.emailMismatchWarning ? '1' : '0',
        });
        res.redirect(`/?${query.toString()}`);
      } catch (e) {
        const reason = e instanceof Error ? e.message : 'Falha na autorização Google.';
        const query = new URLSearchParams({
          sheets_oauth: 'error',
          reason,
        });
        res.redirect(`/?${query.toString()}`);
      }
    })
  );

  router.post(
    '/api/company/sheets/oauth/bridge',
    resolveSessionFromRequest,
    requireCapability('manage_database'),
    asyncHandler(async (req, res) => {
      const state = sanitizeTextInput(String(req.body?.state || ''), 200);
      const accessToken = String(req.body?.access_token || '').trim();
      const enteredEmail = req.body?.entered_google_email
        ? sanitizeTextInput(String(req.body.entered_google_email), 160).toLowerCase()
        : undefined;

      if (!state || !accessToken) {
        res.status(400).json({ error: 'Token OAuth ou estado CSRF em falta.' });
        return;
      }

      const result = await completeOAuthBridgeLogin({
        companyId: req.session!.company_id,
        actorUserId: req.session!.user_id,
        state,
        accessToken,
        enteredGoogleEmail: enteredEmail,
      });

      const tenant = getTenantById(req.session!.company_id)!;
      res.json({
        verified_email: result.verifiedEmail,
        email_mismatch_warning: result.emailMismatchWarning,
        config: buildTenantSheetsConfigResponse(tenant),
      });
    })
  );

  router.post(
    '/api/company/sheets/oauth/confirm-mismatch',
    resolveSessionFromRequest,
    requireCapability('manage_database'),
    (req: AuthedRequest, res: Response) => {
      const tenant = getTenantById(req.session!.company_id);
      if (!tenant) {
        res.status(404).json({ error: 'Empresa não encontrada.' });
        return;
      }
      const updated = updateTenantRecord(req.session!.company_id, {
        entered_google_email: tenant.verified_google_email,
        email_mismatch_confirmed: true,
      });
      res.json({ config: buildTenantSheetsConfigResponse(updated!) });
    }
  );

  router.get(
    '/api/company/sheets/list',
    resolveSessionFromRequest,
    requireCapability('manage_database'),
    asyncHandler(async (req, res) => {
      const files = await listAvailableSpreadsheetsForTenant(req.session!.company_id);
      res.json({ spreadsheets: files });
    })
  );

  router.post(
    '/api/company/sheets/select',
    resolveSessionFromRequest,
    requireCapability('manage_database'),
    asyncHandler(async (req, res) => {
      const rawInput = sanitizeTextInput(String(req.body?.spreadsheet_input || req.body?.spreadsheet_id || ''), 400);
      const spreadsheetId = extractSpreadsheetIdFromInput(rawInput);
      if (!spreadsheetId) {
        res.status(400).json({ error: 'Indique um ID ou URL válido de Google Sheets.' });
        return;
      }

      const initializeIfMissing = Boolean(req.body?.initialize_missing);
      const { tenant, report } = await selectExistingSpreadsheetForTenant({
        companyId: req.session!.company_id,
        actorUserId: req.session!.user_id,
        spreadsheetId,
        initializeIfMissing,
      });

      if (report.valid) {
        // Se a aba CompanySettings ainda estiver vazia, semear configuração inicial sem apagar dados existentes
        const tenantDb = await getTenantDatabase(req.session!.company_id);
        const existingAuths = await tenantDb.policies.listPolicies();
        if (existingAuths.length === 0) {
          await initializeCompanySpreadsheetBaseline(tenant, req.session!.user_id, req.session!.full_name);
        }
      }

      res.json({
        config: buildTenantSheetsConfigResponse(getTenantById(req.session!.company_id)!),
        schema_report: report,
      });
    })
  );

  router.post(
    '/api/company/sheets/create',
    resolveSessionFromRequest,
    requireCapability('manage_database'),
    asyncHandler(async (req, res) => {
      const customTitle = req.body?.title ? sanitizeTextInput(String(req.body.title), 140) : undefined;
      const { tenant, metadata } = await createNewSpreadsheetForTenant({
        companyId: req.session!.company_id,
        actorUserId: req.session!.user_id,
        customTitle,
      });

      await initializeCompanySpreadsheetBaseline(tenant, req.session!.user_id, req.session!.full_name);

      res.status(201).json({
        config: buildTenantSheetsConfigResponse(getTenantById(req.session!.company_id)!),
        spreadsheet: metadata,
      });
    })
  );

  router.post(
    '/api/company/sheets/initialize-schema',
    resolveSessionFromRequest,
    requireCapability('manage_database'),
    asyncHandler(async (req, res) => {
      const { tenant, accessToken } = await getValidTenantAccessToken(req.session!.company_id);
      if (!tenant.spreadsheet_id) {
        res.status(400).json({ error: 'Selecione primeiro uma folha de cálculo.' });
        return;
      }

      const result = await ensureSpreadsheetSchema(accessToken, tenant.spreadsheet_id);
      const meta = await getSpreadsheetMetadata(accessToken, tenant.spreadsheet_id);
      const updated = updateTenantRecord(req.session!.company_id, {
        spreadsheet_name: meta.title,
        spreadsheet_url: meta.spreadsheetUrl,
        schema_valid: result.report.valid,
        missing_worksheets: result.report.missingWorksheets,
        connection_status: result.report.valid ? 'Ligado' : 'Estrutura inválida',
        last_connection_test: new Date().toISOString(),
        last_error: result.report.valid ? null : 'Alguns cabeçalhos existentes diferem do esquema esperado.',
      })!;

      if (result.report.valid) {
        const tenantDb = await getTenantDatabase(req.session!.company_id);
        const existingPolicies = await tenantDb.policies.listPolicies();
        if (existingPolicies.length === 0) {
          await initializeCompanySpreadsheetBaseline(updated, req.session!.user_id, req.session!.full_name);
        }
      }

      res.json({
        config: buildTenantSheetsConfigResponse(getTenantById(req.session!.company_id)!),
        created_tabs: result.createdTabs,
        updated_headers: result.updatedHeaders,
        schema_report: result.report,
      });
    })
  );

  router.post(
    '/api/company/sheets/test',
    resolveSessionFromRequest,
    requireCapability('manage_database'),
    asyncHandler(async (req, res) => {
      const testRes = await testTenantSheetsConnection(req.session!.company_id);
      const tenant = getTenantById(req.session!.company_id)!;
      res.json({
        ...testRes,
        config: buildTenantSheetsConfigResponse(tenant),
      });
    })
  );

  router.post(
    '/api/company/sheets/disconnect',
    resolveSessionFromRequest,
    requireCapability('manage_database'),
    asyncHandler(async (req, res) => {
      await disconnectTenantGoogleAccount(req.session!.company_id, req.session!.user_id);
      const tenant = getTenantById(req.session!.company_id)!;
      res.json({
        disconnected: true,
        config: buildTenantSheetsConfigResponse(tenant),
      });
    })
  );

  // ========================
  // 3. DASHBOARD — VISÃO GERAL (DADOS EXCLUSIVAMENTE DA FOLHA DA EMPRESA)
  // ========================
  router.get(
    '/api/dashboard',
    resolveSessionFromRequest,
    asyncHandler(async (req, res) => {
      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const [agents, authRequests, allApprovals, policies, allAudit] = await Promise.all([
        tenantDb.agents.listAgents(),
        tenantDb.approvals.listAuthorizationRequests(),
        tenantDb.approvals.listApprovalRequests(),
        tenantDb.policies.listPolicies(),
        tenantDb.audit.listAuditLogs(50),
      ]);

      const pendingApprovals = allApprovals.filter((a) => a.status === 'Pendente');
      const totalAgents = agents.filter((a) => a.status !== 'archived').length;
      const activeAgents = agents.filter((a) => a.status === 'active' || a.status === 'running').length;
      const runningAgents = agents.filter((a) => a.status === 'running').length;
      const verifiedActions = authRequests.length;
      const blockedCount = authRequests.filter((r) => r.decision === 'BLOCKED').length;

      const dailyMap = new Map<string, { date: string; allowed: number; pending: number; blocked: number }>();
      for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86_400_000);
        const key = d.toISOString().slice(0, 10);
        const label = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
        dailyMap.set(key, { date: label, allowed: 0, pending: 0, blocked: 0 });
      }
      for (const r of authRequests) {
        const key = String(r.created_at).slice(0, 10);
        const bucket = dailyMap.get(key);
        if (bucket) {
          if (r.decision === 'ALLOWED') bucket.allowed++;
          else if (r.decision === 'REQUIRES_APPROVAL') bucket.pending++;
          else if (r.decision === 'BLOCKED') bucket.blocked++;
        }
      }

      const agentPerformance = agents
        .filter((a) => a.status !== 'archived')
        .map((a) => {
          const agReqs = authRequests.filter((r) => r.agent_id === a.id);
          return {
            id: a.id,
            name: a.name,
            category: a.category,
            status: a.status,
            completed_tasks: a.actions_count + agReqs.filter((r) => r.decision === 'ALLOWED').length,
            authorization_requests: agReqs.length,
            blocked_actions: agReqs.filter((r) => r.decision === 'BLOCKED').length,
          };
        })
        .sort((a, b) => b.completed_tasks - a.completed_tasks);

      const agentsWithoutPolicy = agents.filter(
        (a) => a.status !== 'archived' && (!a.policies || a.policies.length === 0)
      ).length;
      const suspendedCreds = agents.filter((a) => a.security_status === 'credentials_suspended').length;
      const policiesReview = policies.filter((p) => p.status === 'review_required').length;
      const recentAudit = allAudit.slice(0, 10);
      const recentIncidents = recentAudit.filter(
        (l) => l.event_type === 'blocked_action' || l.result === 'BLOCKED'
      ).length;

      res.json({
        kpis: {
          total_agents: totalAgents,
          active_agents: activeAgents,
          running_agents: runningAgents,
          verified_actions: verifiedActions,
          pending_approvals: pendingApprovals.length,
          blocked_actions: blockedCount,
        },
        activity_chart: Array.from(dailyMap.values()),
        agent_performance: agentPerformance,
        pending_approvals: pendingApprovals,
        security_status: {
          agents_without_policies: agentsWithoutPolicy,
          agents_suspended_credentials: suspendedCreds,
          recent_security_incidents: recentIncidents,
          policies_requiring_review: policiesReview,
        },
        recent_activity: recentAudit,
      });
    })
  );

  // ========================
  // 4. FÁBRICA E GESTÃO DE AGENTES
  // ========================
  router.get(
    '/api/agents',
    resolveSessionFromRequest,
    asyncHandler(async (req, res) => {
      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const agents = await tenantDb.agents.listAgents();
      res.json({ agents });
    })
  );

  router.get(
    '/api/agents/:id',
    resolveSessionFromRequest,
    asyncHandler(async (req, res) => {
      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const agent = await tenantDb.agents.getAgentById(req.params.id);
      if (!agent) {
        res.status(404).json({ error: 'Agente não encontrado nesta empresa.' });
        return;
      }
      const [activity, versions] = await Promise.all([
        tenantDb.approvals.listAuthorizationRequests(agent.id),
        tenantDb.agents.listVersions(agent.id),
      ]);
      res.json({ agent, activity: activity.slice(0, 30), versions });
    })
  );

  router.post(
    '/api/agents/generate-instructions',
    resolveSessionFromRequest,
    requireCapability('create_agent'),
    asyncHandler(async (req, res) => {
      const description = sanitizeTextInput(String(req.body?.description || ''), 1500);
      const category = sanitizeTextInput(String(req.body?.category || 'Geral'), 80);
      if (!description) {
        res.status(400).json({ error: 'Descreva o agente pretendido antes de gerar instruções.' });
        return;
      }
      if (!geminiProvider.isConfigured()) {
        res.status(503).json({
          error: 'A chave GEMINI_API_KEY não está configurada no servidor. Configure-a em Settings > Secrets.',
        });
        return;
      }
      try {
        const instructions = await geminiProvider.generateStructuredInstructions(description, category);
        res.json({ instructions });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro ao gerar instruções com Gemini.';
        res.status(502).json({ error: msg });
      }
    })
  );

  router.post(
    '/api/agents',
    resolveSessionFromRequest,
    requireCapability('create_agent'),
    asyncHandler(async (req, res) => {
      const companyId = req.session!.company_id;
      const tenantDb = await getTenantDatabase(companyId);
      const planLimits = SUBSCRIPTION_LIMITS[req.session!.subscription_plan];

      const currentCount = await tenantDb.agents.countNonArchivedAgents();
      if (currentCount >= planLimits.maxAgents) {
        res.status(403).json({
          error: `Limite do plano ${planLimits.label} atingido (${planLimits.maxAgents} agentes). Atualize o plano em Definições.`,
        });
        return;
      }

      const name = sanitizeTextInput(String(req.body?.name || ''), 120);
      const description = sanitizeTextInput(String(req.body?.description || ''), 500);
      const category = sanitizeTextInput(String(req.body?.category || 'Personalizado'), 80);
      const objective = sanitizeTextInput(String(req.body?.objective || ''), 400);
      const origin = req.body?.origin === 'EXTERNAL' ? 'EXTERNAL' : 'MANDATO';
      const provider = sanitizeTextInput(String(req.body?.provider || 'Google Gemini'), 60);
      const model = sanitizeTextInput(String(req.body?.model || 'gemini-4-hydrogen'), 80);
      const externalIdentifier = req.body?.external_identifier
        ? sanitizeTextInput(String(req.body.external_identifier), 120)
        : null;
      const requestedStatus = req.body?.status === 'active' ? 'active' : 'draft';

      if (!name || !description) {
        res.status(400).json({ error: 'Nome e descrição do agente são obrigatórios.' });
        return;
      }

      const policyIds: string[] = Array.isArray(req.body?.policy_ids) ? req.body.policy_ids : [];
      if (requestedStatus === 'active' && policyIds.length === 0) {
        res.status(400).json({
          error: 'Para ativar o agente é obrigatório associar pelo menos uma política de autorização.',
        });
        return;
      }

      const instructions: AgentInstructions = req.body?.instructions || {
        role: name,
        objective: objective || description,
        responsibilities: [],
        behaviour: 'Rigoroso e transparente',
        communication_style: 'Português Europeu formal',
        rules: [],
        restrictions: ['Nunca alterar dados bancários'],
        expected_output: 'Resposta estruturada',
      };

      const permissionsSummary: AgentPermissionsConfig = req.body?.permissions_summary || {
        read_permissions: ['dados_autorizados'],
        write_permissions: [],
        max_auto_financial_limit_eur: 300,
        max_approval_financial_limit_eur: 1000,
        allowed_resources: [],
        restricted_resources: ['bank_accounts'],
        actions_requiring_approval: ['purchase_order'],
        always_blocked_actions: ['bank_details_update', 'sign_contract'],
      };

      const selectedToolsInput: Array<{ tool_key: string; is_enabled: boolean; requires_approval: boolean }> =
        Array.isArray(req.body?.tools) ? req.body.tools : [];

      const created = await tenantDb.agents.createAgent({
        name,
        description,
        category,
        objective: objective || description,
        origin,
        provider,
        model,
        externalIdentifier,
        status: requestedStatus,
        avatarIcon: sanitizeTextInput(String(req.body?.avatar_icon || 'bot'), 40),
        instructions,
        permissionsSummary,
        policyIds,
        selectedTools: selectedToolsInput,
        createdBy: req.session!.user_id,
      });

      registerAgentCredentialRoute(created.keyHash, companyId);

      await tenantDb.audit.appendAuditEvent({
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: origin === 'EXTERNAL' ? 'external_agent_registered' : 'agent_created',
        action: `Criação de agente "${name}" (${origin})`,
        result: 'Sucesso',
        reason: `Estado inicial: ${requestedStatus}. Políticas associadas: ${created.agent.policies?.length ?? 0}.`,
      });

      res.status(201).json({
        agent: created.agent,
        issued_api_key: created.rawApiKey,
      });
    })
  );

  router.patch(
    '/api/agents/:id',
    resolveSessionFromRequest,
    requireCapability('manage_agent'),
    asyncHandler(async (req, res) => {
      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const updated = await tenantDb.agents.updateAgent(req.params.id, {
        name: req.body?.name ? sanitizeTextInput(String(req.body.name), 120) : undefined,
        description: req.body?.description ? sanitizeTextInput(String(req.body.description), 500) : undefined,
        provider: req.body?.provider ? sanitizeTextInput(String(req.body.provider), 60) : undefined,
        model: req.body?.model ? sanitizeTextInput(String(req.body.model), 80) : undefined,
        instructions: req.body?.instructions,
        permissions_summary: req.body?.permissions_summary,
        updatedBy: req.session!.user_id,
      });

      if (!updated) {
        res.status(404).json({ error: 'Agente não encontrado.' });
        return;
      }

      await tenantDb.audit.appendAuditEvent({
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: 'agent_updated',
        action: `Atualização do agente "${updated.name}"`,
        result: 'Sucesso',
        reason: 'Nova versão guardada na folha de cálculo da empresa.',
      });

      res.json({ agent: updated });
    })
  );

  router.patch(
    '/api/agents/:id/status',
    resolveSessionFromRequest,
    requireCapability('manage_agent'),
    asyncHandler(async (req, res) => {
      const newStatus = String(req.body?.status || '');
      if (!['draft', 'active', 'running', 'suspended', 'archived'].includes(newStatus)) {
        res.status(400).json({ error: 'Estado de agente inválido.' });
        return;
      }

      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const existing = await tenantDb.agents.getAgentById(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Agente não encontrado.' });
        return;
      }

      if ((newStatus === 'active' || newStatus === 'running') && (!existing.policies || existing.policies.length === 0)) {
        res.status(400).json({
          error: 'Não é possível ativar um agente sem políticas de autorização atribuídas.',
        });
        return;
      }

      const updated = await tenantDb.agents.updateAgentStatus(
        req.params.id,
        newStatus as 'draft' | 'active' | 'running' | 'suspended' | 'archived'
      );

      await tenantDb.audit.appendAuditEvent({
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: newStatus === 'suspended' ? 'agent_suspended' : 'agent_status_changed',
        action: `Alteração de estado do agente "${existing.name}" para "${newStatus}"`,
        result: 'Sucesso',
        reason: 'Operação executada pela gestão de agentes.',
      });

      res.json({ agent: updated });
    })
  );

  router.post(
    '/api/agents/:id/duplicate',
    resolveSessionFromRequest,
    requireCapability('create_agent'),
    asyncHandler(async (req, res) => {
      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const duplicated = await tenantDb.agents.duplicateAgent(req.params.id, req.session!.user_id);
      if (!duplicated) {
        res.status(404).json({ error: 'Agente não encontrado.' });
        return;
      }
      registerAgentCredentialRoute(duplicated.keyHash, req.session!.company_id);

      await tenantDb.audit.appendAuditEvent({
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: 'agent_created',
        action: `Duplicação para "${duplicated.agent.name}"`,
        result: 'Sucesso',
        reason: 'Rascunho criado com ferramentas e políticas associadas.',
      });

      res.status(201).json({ agent: duplicated.agent });
    })
  );

  router.patch(
    '/api/agents/:id/tools',
    resolveSessionFromRequest,
    requireCapability('manage_agent'),
    asyncHandler(async (req, res) => {
      const toolId = String(req.body?.tool_id || '');
      const isEnabled = Boolean(req.body?.is_enabled);
      const requiresApproval = req.body?.requires_approval !== undefined ? Boolean(req.body.requires_approval) : true;

      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const result = await tenantDb.agents.updateAgentTool(req.params.id, toolId, isEnabled, requiresApproval);
      if (!result) {
        res.status(404).json({ error: 'Ferramenta não encontrada para este agente.' });
        return;
      }

      await tenantDb.audit.appendAuditEvent({
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: 'agent_tool_updated',
        action: `${isEnabled ? 'Ativação' : 'Desativação'} da ferramenta "${result.toolName}"`,
        result: 'Sucesso',
        reason: 'Alteração de configuração de ferramentas. Continua sujeita ao motor de políticas.',
      });

      res.json({ agent: result.agent });
    })
  );

  router.post(
    '/api/agents/:id/credentials/rotate',
    resolveSessionFromRequest,
    requireCapability('manage_agent'),
    asyncHandler(async (req, res) => {
      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const rotated = await tenantDb.agents.rotateCredential(req.params.id);
      if (!rotated) {
        res.status(404).json({ error: 'Agente não encontrado.' });
        return;
      }
      registerAgentCredentialRoute(rotated.keyHash, req.session!.company_id);

      await tenantDb.audit.appendAuditEvent({
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: 'credential_rotated',
        action: `Rotação de credenciais API do agente "${rotated.agent.name}"`,
        result: 'Sucesso',
        reason: `Nova chave prefixo ${rotated.keyPrefix} emitida; chave anterior revogada.`,
      });

      res.json({ api_key: rotated.rawKey, key_prefix: rotated.keyPrefix });
    })
  );

  router.post(
    '/api/agents/:id/credentials/revoke',
    resolveSessionFromRequest,
    requireCapability('manage_agent'),
    asyncHandler(async (req, res) => {
      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const agent = await tenantDb.agents.revokeCredentials(req.params.id);
      if (!agent) {
        res.status(404).json({ error: 'Agente não encontrado.' });
        return;
      }

      await tenantDb.audit.appendAuditEvent({
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: 'credential_revoked',
        action: `Revogação de credenciais do agente "${agent.name}"`,
        result: 'Revogado',
        reason: 'Credenciais suspensas manualmente pela administração.',
      });

      res.json({ status: 'revoked' });
    })
  );

  // ========================
  // 5. TESTAR AGENTE (GEMINI + MOTOR DE AUTORIZAÇÃO)
  // ========================
  router.post(
    '/api/agents/:id/test',
    resolveSessionFromRequest,
    requireCapability('test_agent'),
    asyncHandler(async (req, res) => {
      const companyId = req.session!.company_id;
      const message = sanitizeTextInput(String(req.body?.message || ''), 2000);
      const isSimulation = req.body?.is_simulation !== false;

      if (!message) {
        res.status(400).json({ error: 'Escreva uma mensagem para testar o agente.' });
        return;
      }

      const tenantDb = await getTenantDatabase(companyId);
      const [agent, policies] = await Promise.all([
        tenantDb.agents.getAgentById(req.params.id),
        tenantDb.policies.listPolicies(),
      ]);
      if (!agent) {
        res.status(404).json({ error: 'Agente não encontrado.' });
        return;
      }

      try {
        const result = await executeAgentTestTurn({
          agent,
          tools: agent.tools || [],
          policies,
          userMessage: message,
        });

        let createdAuthId: string | null = null;
        let createdApprovalId: string | null = null;

        if (result.proposedAction && result.authorizationResult) {
          const dec = result.authorizationResult.decision;
          const rec = await tenantDb.approvals.recordAuthorizationAndOptionalApproval({
            agentId: agent.id,
            actionType: result.proposedAction.action_type,
            toolName: result.proposedAction.tool_name,
            description: result.proposedAction.description,
            amount: result.proposedAction.amount,
            currency: 'EUR',
            resourceId: result.proposedAction.resource_id,
            idempotencyKey: `test_${crypto.randomUUID()}`,
            decision: dec,
            reason: result.authorizationResult.reason,
            policyId: result.authorizationResult.matchedPolicy?.id ?? null,
            policyName: result.authorizationResult.matchedPolicy?.name ?? 'Política de Governação',
            riskLevel: result.authorizationResult.riskLevel,
            isSimulation,
            createApproval: !isSimulation && dec === 'REQUIRES_APPROVAL',
          });
          createdAuthId = rec.authorizationId;
          createdApprovalId = rec.approvalRequestId;

          await tenantDb.agents.recordAgentExecution(agent.id);

          await tenantDb.audit.appendAuditEvent({
            actorType: 'agent',
            actorId: agent.id,
            actorName: agent.name,
            eventType:
              dec === 'BLOCKED'
                ? 'blocked_action'
                : isSimulation
                ? 'agent_simulation_test'
                : 'authorization_decision',
            action: `${isSimulation ? '[Simulação] ' : ''}${result.proposedAction.action_type}: ${result.proposedAction.description}`,
            result: dec,
            reason: result.authorizationResult.reason,
            relatedPolicy: result.authorizationResult.matchedPolicy?.name ?? null,
          });
        }

        res.json({
          ...result,
          is_simulation: isSimulation,
          authorization_id: createdAuthId,
          approval_request_id: createdApprovalId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Falha na execução do agente.';
        res.status(502).json({ error: msg });
      }
    })
  );

  // ========================
  // 6. POLÍTICAS E PERMISSÕES
  // ========================
  router.get(
    '/api/policies',
    resolveSessionFromRequest,
    asyncHandler(async (req, res) => {
      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const policies = await tenantDb.policies.listPolicies();
      res.json({ policies });
    })
  );

  router.post(
    '/api/policies',
    resolveSessionFromRequest,
    requireCapability('manage_policies'),
    asyncHandler(async (req, res) => {
      const companyId = req.session!.company_id;
      const name = sanitizeTextInput(String(req.body?.name || ''), 140);
      const description = sanitizeTextInput(String(req.body?.description || ''), 500);
      const actionType = sanitizeTextInput(String(req.body?.action_type || ''), 80).toLowerCase();
      const ruleType = String(req.body?.rule_type || 'require_approval') as Policy['rule_type'];
      const maxAuto =
        req.body?.max_auto_amount !== null &&
        req.body?.max_auto_amount !== undefined &&
        req.body?.max_auto_amount !== ''
          ? Number(req.body.max_auto_amount)
          : null;
      const maxApproval =
        req.body?.max_approval_amount !== null &&
        req.body?.max_approval_amount !== undefined &&
        req.body?.max_approval_amount !== ''
          ? Number(req.body.max_approval_amount)
          : null;
      const isAbsolute = Boolean(req.body?.is_absolute_restriction) || ruleType === 'block_always';

      if (!name || !actionType) {
        res.status(400).json({ error: 'Nome da política e tipo de ação são obrigatórios.' });
        return;
      }

      const tenantDb = await getTenantDatabase(companyId);
      const created = await tenantDb.policies.createPolicy({
        name,
        description: description || `Regra de governação para ${actionType}`,
        actionType,
        ruleType,
        maxAutoAmount: maxAuto,
        maxApprovalAmount: maxApproval,
        conditions: req.body?.conditions || {},
        isAbsoluteRestriction: isAbsolute,
        agentIds: Array.isArray(req.body?.agent_ids) ? req.body.agent_ids : [],
      });

      await tenantDb.audit.appendAuditEvent({
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: 'policy_created',
        action: `Criação da política "${name}"`,
        result: 'Ativa',
        reason: `Ação: ${actionType}, regra: ${ruleType}.`,
        relatedPolicy: name,
      });

      res.status(201).json({ policy: created });
    })
  );

  router.patch(
    '/api/policies/:id',
    resolveSessionFromRequest,
    requireCapability('manage_policies'),
    asyncHandler(async (req, res) => {
      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const existing = await tenantDb.policies.getPolicyById(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Política não encontrada.' });
        return;
      }

      if (existing.action_type === 'bank_details_update' && req.body?.status === 'inactive') {
        res.status(403).json({
          error: 'Política de proteção absoluta de dados bancários não pode ser desativada.',
        });
        return;
      }

      const nextStatus = req.body?.status ? (String(req.body.status) as Policy['status']) : existing.status;
      const maxAuto =
        req.body?.max_auto_amount !== undefined ? Number(req.body.max_auto_amount) : existing.max_auto_amount;
      const maxApproval =
        req.body?.max_approval_amount !== undefined
          ? Number(req.body.max_approval_amount)
          : existing.max_approval_amount;

      const updated = await tenantDb.policies.updatePolicy(req.params.id, {
        status: nextStatus,
        maxAutoAmount: maxAuto,
        maxApprovalAmount: maxApproval,
      });

      await tenantDb.audit.appendAuditEvent({
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: 'policy_modified',
        action: `Alteração da política "${existing.name}"`,
        result: nextStatus,
        reason: `Limites atualizados (auto: €${maxAuto ?? '—'}, aprovação: €${maxApproval ?? '—'}).`,
        relatedPolicy: existing.name,
      });

      res.json({ policy: updated });
    })
  );

  // ========================
  // 7. PEDIDOS DE APROVAÇÃO
  // ========================
  router.get(
    '/api/approvals',
    resolveSessionFromRequest,
    asyncHandler(async (req, res) => {
      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const approvals = await tenantDb.approvals.listApprovalRequests();
      res.json({ approvals });
    })
  );

  router.post(
    '/api/approvals/:id/decide',
    resolveSessionFromRequest,
    requireCapability('approve_requests'),
    asyncHandler(async (req, res) => {
      const companyId = req.session!.company_id;
      const decision = String(req.body?.decision || '');
      const justification = sanitizeTextInput(String(req.body?.justification || ''), 600);

      if (!['Aprovado', 'Rejeitado', 'Informacao_Solicitada'].includes(decision)) {
        res.status(400).json({ error: 'Decisão inválida.' });
        return;
      }
      if (!justification) {
        res.status(400).json({ error: 'A justificação é obrigatória para auditoria da decisão.' });
        return;
      }

      const tenantDb = await getTenantDatabase(companyId);
      const approval = await tenantDb.approvals.getApprovalById(req.params.id);
      if (!approval) {
        res.status(404).json({ error: 'Pedido de aprovação não encontrado.' });
        return;
      }
      if (approval.status === 'Expirado') {
        await tenantDb.approvals.markApprovalExpired(approval.id);
        res.status(409).json({ error: 'Este pedido de aprovação expirou e não pode ser decidido.' });
        return;
      }
      if (approval.status !== 'Pendente') {
        res.status(409).json({ error: `Este pedido já se encontra no estado "${approval.status}".` });
        return;
      }

      if (req.session!.user_id === approval.agent_id) {
        res.status(403).json({ error: 'Auto-aprovação proibida: um agente não pode aprovar o próprio pedido.' });
        return;
      }

      if (
        ['bank_details_update', 'change_bank_details', 'modify_own_policy', 'sign_contract', 'execute_payment_direct'].includes(
          approval.requested_action
        )
      ) {
        res.status(403).json({
          error: 'Restrição absoluta de segurança: uma aprovação humana não pode anular esta proibição.',
        });
        return;
      }

      const nextStatus = await tenantDb.approvals.applyApprovalDecision({
        approvalId: approval.id,
        approverId: req.session!.user_id,
        approverName: req.session!.full_name,
        decision: decision as 'Aprovado' | 'Rejeitado' | 'Informacao_Solicitada',
        justification,
        policyApplied: approval.policy_name,
        existingInfoNote: approval.info_requested_note,
      });

      await tenantDb.audit.appendAuditEvent({
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: decision === 'Aprovado' ? 'approval' : decision === 'Rejeitado' ? 'rejection' : 'info_requested',
        action: `${decision}: ${approval.description}`,
        result: nextStatus,
        reason: `${justification} (Registo de autorização apenas — nenhuma operação financeira automática foi executada.)`,
        relatedPolicy: approval.policy_name,
      });

      // Se associado a uma execução de fluxo em pausa e decidido (Aprovado ou Rejeitado), retomar grafo do fluxo
      let workflowResult: { execution_id: string; status: string } | null = null;
      if (approval.workflow_execution_id && (decision === 'Aprovado' || decision === 'Rejeitado')) {
        const exec = await tenantDb.workflows.getExecutionById(approval.workflow_execution_id);
        if (exec && exec.status === 'awaiting_approval' && exec.paused_node_id) {
          const workflow = await tenantDb.workflows.getWorkflowById(exec.workflow_id);
          if (workflow && workflow.status === 'active') {
            const [agents, policies] = await Promise.all([
              tenantDb.agents.listAgents(),
              tenantDb.policies.listPolicies(),
            ]);
            const resumed = await executeOrResumeWorkflowGraph({
              tenantDb,
              workflow,
              agents,
              policies,
              actorUserId: req.session!.user_id,
              actorName: req.session!.full_name,
              overrideAmount: approval.financial_value,
              inputSummary: exec.input_summary,
              executionId: exec.id,
              resumeFromNodeId: exec.paused_node_id,
              resumeBranchDecision: decision,
              initialStepsLog: exec.steps_log,
            });
            workflowResult = { execution_id: resumed.executionId, status: resumed.status };
          }
        }
      }

      res.json({
        status: nextStatus,
        workflow_resumed: workflowResult,
        note: 'Decisão registada em auditoria. Nenhuma transação financeira real foi executada automaticamente.',
      });
    })
  );

  // ========================
  // 8. FLUXOS DE TRABALHO (WORKFLOW BUILDER COM GRAFO DIRIGIDO)
  // ========================
  router.get(
    '/api/workflows',
    resolveSessionFromRequest,
    asyncHandler(async (req, res) => {
      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const [workflows, executions] = await Promise.all([
        tenantDb.workflows.listWorkflows(),
        tenantDb.workflows.listExecutions(),
      ]);
      res.json({ workflows, executions });
    })
  );

  router.post(
    '/api/workflows',
    resolveSessionFromRequest,
    requireCapability('manage_workflows'),
    asyncHandler(async (req, res) => {
      const limits = SUBSCRIPTION_LIMITS[req.session!.subscription_plan];
      if (!limits.workflowsEnabled) {
        res.status(403).json({ error: 'O construtor de fluxos requer o plano Professional ou Business.' });
        return;
      }

      const name = sanitizeTextInput(String(req.body?.name || ''), 140);
      const description = sanitizeTextInput(String(req.body?.description || ''), 500);
      const status = req.body?.status === 'active' ? 'active' : 'draft';
      const nodes = Array.isArray(req.body?.nodes) ? req.body.nodes : [];
      const edges = Array.isArray(req.body?.edges) ? req.body.edges : [];

      if (!name) {
        res.status(400).json({ error: 'O nome do fluxo de trabalho é obrigatório.' });
        return;
      }

      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const wfId = await tenantDb.workflows.createWorkflow({
        name,
        description: description || 'Fluxo governado MANDATO',
        status,
        nodes,
        edges,
      });

      await tenantDb.audit.appendAuditEvent({
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: 'workflow_created',
        action: `Criação do fluxo "${name}"`,
        result: status,
        reason: `Fluxo guardado com ${nodes.length} nós e ${edges.length} ligações.`,
      });

      res.status(201).json({ id: wfId });
    })
  );

  router.patch(
    '/api/workflows/:id/status',
    resolveSessionFromRequest,
    requireCapability('manage_workflows'),
    asyncHandler(async (req, res) => {
      const status = String(req.body?.status || '') as 'draft' | 'active' | 'suspended';
      if (!['draft', 'active', 'suspended'].includes(status)) {
        res.status(400).json({ error: 'Estado inválido.' });
        return;
      }
      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const ok = await tenantDb.workflows.updateWorkflowStatus(req.params.id, status);
      if (!ok) {
        res.status(404).json({ error: 'Fluxo não encontrado.' });
        return;
      }
      res.json({ status });
    })
  );

  router.post(
    '/api/workflows/:id/execute',
    resolveSessionFromRequest,
    requireCapability('manage_workflows'),
    asyncHandler(async (req, res) => {
      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const workflow = await tenantDb.workflows.getWorkflowById(req.params.id);
      if (!workflow) {
        res.status(404).json({ error: 'Fluxo não encontrado.' });
        return;
      }
      if (workflow.status !== 'active') {
        res.status(400).json({
          error:
            workflow.status === 'suspended'
              ? 'Este fluxo encontra-se suspenso e não pode ser executado.'
              : 'Apenas fluxos no estado "active" podem ser executados.',
        });
        return;
      }

      const [agents, policies] = await Promise.all([
        tenantDb.agents.listAgents(),
        tenantDb.policies.listPolicies(),
      ]);

      const overrideAmount =
        req.body?.amount !== undefined && req.body?.amount !== '' ? Number(req.body.amount) : null;
      const inputSummary = sanitizeTextInput(
        String(req.body?.input_summary || 'Execução manual de fluxo operacional'),
        240
      );

      const execRes = await executeOrResumeWorkflowGraph({
        tenantDb,
        workflow,
        agents,
        policies,
        actorUserId: req.session!.user_id,
        actorName: req.session!.full_name,
        overrideAmount,
        inputSummary,
      });

      res.json({
        execution_id: execRes.executionId,
        status: execRes.status,
        approval_request_id: execRes.approvalRequestId,
        steps_log: execRes.stepsLog,
      });
    })
  );

  // ========================
  // 9. INTEGRAÇÕES
  // ========================
  router.get(
    '/api/integrations',
    resolveSessionFromRequest,
    asyncHandler(async (req, res) => {
      const tenantDb = await getTenantDatabase(req.session!.company_id);
      await tenantDb.settings.ensureDefaultIntegrations();
      const integrations = await tenantDb.settings.listIntegrations();
      res.json({ integrations });
    })
  );

  // ========================
  // 10. HISTÓRICO E AUDITORIA (APPEND-ONLY)
  // ========================
  router.get(
    '/api/audit-logs',
    resolveSessionFromRequest,
    asyncHandler(async (req, res) => {
      const search = String(req.query.search || '').trim().toLowerCase();
      const eventType = String(req.query.event_type || '').trim();
      const actor = String(req.query.actor || '').trim().toLowerCase();
      const fromDate = String(req.query.from || '').trim();
      const toDate = String(req.query.to || '').trim();

      const tenantDb = await getTenantDatabase(req.session!.company_id);
      let rows = await tenantDb.audit.listAuditLogs(300);

      rows = rows.filter((r) => {
        if (eventType && r.event_type !== eventType) return false;
        if (actor && !r.actor_name.toLowerCase().includes(actor)) return false;
        if (fromDate && r.created_at.slice(0, 10) < fromDate) return false;
        if (toDate && r.created_at.slice(0, 10) > toDate) return false;
        if (search) {
          const hay = `${r.actor_name} ${r.action} ${r.reason} ${r.result} ${r.related_policy || ''}`.toLowerCase();
          if (!hay.includes(search)) return false;
        }
        return true;
      });

      res.json({ logs: rows });
    })
  );

  router.get(
    '/api/audit-logs/export.csv',
    resolveSessionFromRequest,
    requireCapability('export_audit'),
    asyncHandler(async (req, res) => {
      const tenantDb = await getTenantDatabase(req.session!.company_id);
      const rows = await tenantDb.audit.listAuditLogs(1000);

      const escapeCsv = (val: unknown) => `"${String(val ?? '').replace(/"/g, '""')}"`;
      const header = ['ID', 'DataHora', 'Ator', 'TipoEvento', 'Acao', 'Resultado', 'Motivo', 'Politica'].join(',');
      const lines = rows.map((r) =>
        [
          escapeCsv(r.id),
          escapeCsv(r.created_at),
          escapeCsv(r.actor_name),
          escapeCsv(r.event_type),
          escapeCsv(r.action),
          escapeCsv(r.result),
          escapeCsv(r.reason),
          escapeCsv(r.related_policy || ''),
        ].join(',')
      );

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="mandato_auditoria.csv"');
      res.send([header, ...lines].join('\n'));
    })
  );

  // ========================
  // 11. UTILIZADORES & DEFINIÇÕES DA EMPRESA
  // ========================
  router.get('/api/users', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    const members = listMembersForCompany(req.session!.company_id);
    res.json({ members });
  });

  router.post(
    '/api/users',
    resolveSessionFromRequest,
    requireCapability('manage_users'),
    asyncHandler(async (req, res) => {
      const companyId = req.session!.company_id;
      const limits = SUBSCRIPTION_LIMITS[req.session!.subscription_plan];
      const existingMembers = listMembersForCompany(companyId);
      if (existingMembers.length >= limits.maxUsers) {
        res.status(403).json({
          error: `Limite de utilizadores do plano ${limits.label} atingido (${limits.maxUsers}).`,
        });
        return;
      }

      const fullName = sanitizeTextInput(String(req.body?.full_name || ''), 120);
      const email = sanitizeTextInput(String(req.body?.email || ''), 160).toLowerCase();
      const jobTitle = sanitizeTextInput(String(req.body?.job_title || ''), 100);
      const role = String(req.body?.role || 'VIEWER') as UserRole;
      const tempPassword = String(req.body?.password || 'MandatoTemp2026!');

      if (!fullName || !email || !['OWNER', 'ADMIN', 'APPROVER', 'OPERATOR', 'VIEWER'].includes(role)) {
        res.status(400).json({ error: 'Dados do utilizador inválidos.' });
        return;
      }

      let user = findPlatformUserByEmail(email);
      if (!user) {
        user = createPlatformUser({
          email,
          passwordHash: hashPassword(tempPassword),
          fullName,
          jobTitle,
        });
      }

      if (getMembership(companyId, user.id)) {
        res.status(409).json({ error: 'Este utilizador já pertence à empresa.' });
        return;
      }

      const mem = addCompanyMembership({
        companyId,
        userId: user.id,
        role,
        status: 'active',
      });

      // Sincronizar na folha Google Sheets da empresa se já estiver ligada
      const tenant = getTenantById(companyId);
      if (tenant?.connection_status === 'Ligado' && tenant.spreadsheet_id) {
        const tenantDb = await getTenantDatabase(companyId);
        await tenantDb.settings.syncUserAndMemberRow({
          memberId: mem.id,
          userId: user.id,
          email: user.email,
          fullName: user.full_name,
          jobTitle: user.job_title,
          role,
          status: mem.status,
          createdAt: mem.created_at,
        });
        await tenantDb.audit.appendAuditEvent({
          actorType: 'user',
          actorId: req.session!.user_id,
          actorName: req.session!.full_name,
          eventType: 'user_permission_changed',
          action: `Adição de utilizador ${fullName} (${email}) com perfil ${role}`,
          result: 'Sucesso',
          reason: 'Atribuição inicial de papel RBAC.',
        });
      }

      res.status(201).json({ status: 'created' });
    })
  );

  router.patch(
    '/api/users/:memberId/role',
    resolveSessionFromRequest,
    requireCapability('manage_users'),
    asyncHandler(async (req, res) => {
      const companyId = req.session!.company_id;
      const role = String(req.body?.role || '') as UserRole;
      if (!['OWNER', 'ADMIN', 'APPROVER', 'OPERATOR', 'VIEWER'].includes(role)) {
        res.status(400).json({ error: 'Perfil RBAC inválido.' });
        return;
      }

      const updated = updateCompanyMembershipRole(companyId, req.params.memberId, role);
      if (!updated) {
        res.status(404).json({ error: 'Membro não encontrado.' });
        return;
      }

      const tenant = getTenantById(companyId);
      if (tenant?.connection_status === 'Ligado' && tenant.spreadsheet_id) {
        const tenantDb = await getTenantDatabase(companyId);
        const user = findPlatformUserById(updated.user_id);
        if (user) {
          await tenantDb.settings.syncUserAndMemberRow({
            memberId: updated.id,
            userId: user.id,
            email: user.email,
            fullName: user.full_name,
            jobTitle: user.job_title,
            role,
            status: updated.status,
            createdAt: updated.created_at,
          });
        }
        await tenantDb.audit.appendAuditEvent({
          actorType: 'user',
          actorId: req.session!.user_id,
          actorName: req.session!.full_name,
          eventType: 'user_permission_changed',
          action: `Alteração do perfil de ${updated.full_name} para ${role}`,
          result: 'Sucesso',
          reason: 'Atualização de permissões RBAC pela direção.',
        });
      }

      res.json({ role });
    })
  );

  router.get('/api/company', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    const tenant = getTenantById(req.session!.company_id);
    if (!tenant) {
      res.status(404).json({ error: 'Empresa não encontrada.' });
      return;
    }
    res.json({ company: toCompanyObject(tenant), plans: SUBSCRIPTION_LIMITS });
  });

  router.patch(
    '/api/company',
    resolveSessionFromRequest,
    requireCapability('manage_settings'),
    asyncHandler(async (req, res) => {
      const companyId = req.session!.company_id;
      const name = sanitizeTextInput(String(req.body?.name || ''), 120);
      const sector = sanitizeTextInput(String(req.body?.sector || ''), 120);
      const nif = sanitizeTextInput(String(req.body?.nif || ''), 30);
      const plan = String(req.body?.subscription_plan || '') as SubscriptionPlan;

      const patch: Record<string, unknown> = {};
      if (name) patch.company_name = name;
      if (sector) patch.sector = sector;
      if (nif) patch.nif = nif;
      if (['STARTER', 'PROFESSIONAL', 'BUSINESS'].includes(plan)) {
        patch.subscription_plan = plan;
        patch.retention_days = SUBSCRIPTION_LIMITS[plan].retentionDays;
      }

      const updatedTenant = updateTenantRecord(companyId, patch);
      if (!updatedTenant) {
        res.status(404).json({ error: 'Empresa não encontrada.' });
        return;
      }

      if (updatedTenant.connection_status === 'Ligado' && updatedTenant.spreadsheet_id) {
        const tenantDb = await getTenantDatabase(companyId);
        await tenantDb.settings.upsertCompanySettings({
          name: updatedTenant.company_name,
          slug: updatedTenant.slug,
          nif: updatedTenant.nif,
          sector: updatedTenant.sector,
          subscription_plan: updatedTenant.subscription_plan,
          is_demo: updatedTenant.is_demo,
          retention_days: updatedTenant.retention_days,
          created_at: updatedTenant.created_at,
          updated_at: updatedTenant.updated_at,
        });
      }

      res.json({ company: toCompanyObject(updatedTenant) });
    })
  );

  // ========================
  // 11B. ADMINISTRAÇÃO DA PLATAFORMA (METADADOS DE LIGAÇÃO APENAS — ZERO CONTEÚDO OPERACIONAL)
  // ========================
  router.get(
    '/api/platform/tenants',
    resolveSessionFromRequest,
    requirePlatformAdmin,
    (req: AuthedRequest, res: Response) => {
      appendPlatformAuditLog({
        actorUserId: req.session!.user_id,
        actorEmail: req.session!.email,
        companyId: null,
        eventType: 'platform_admin_viewed_tenants',
        detail: 'Consulta de metadados de ligações multi-tenant (sem acesso a conteúdo empresarial).',
      });
      res.json({
        tenants: listPlatformTenantsMetadataOnly(),
        platform_audit_logs: listPlatformAuditLogs().slice(0, 40),
      });
    }
  );

  // ========================
  // 12. API GATEWAY CENTRAL DE AUTORIZAÇÃO — POST /api/v1/authorize
  // ========================
  router.post(
    '/api/v1/authorize',
    asyncHandler(async (req, res) => {
      const authHeader = req.headers.authorization || '';
      const bearerSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const headerSecret = String(req.headers['x-agent-key'] || '').trim();
      const rawCredential = bearerSecret || headerSecret;

      if (!rawCredential) {
        res.status(401).json({
          error: 'Credencial de agente em falta. Envie Authorization: Bearer <chave_agente>.',
        });
        return;
      }

      const hashed = hashAgentCredential(rawCredential);
      const resolvedCompanyId = resolveCompanyByCredentialHash(hashed);
      if (!resolvedCompanyId) {
        res.status(401).json({ error: 'Credencial de agente inválida, revogada ou suspensa.' });
        return;
      }

      // Obter base de dados isolada da empresa proprietária da credencial (nunca confiar em company_id do payload!)
      const tenantDb = await getTenantDatabase(resolvedCompanyId);
      const credRow = await tenantDb.agents.findCredentialByHash(hashed);
      if (!credRow || credRow.status !== 'active') {
        res.status(401).json({ error: 'Credencial de agente inválida, revogada ou suspensa.' });
        return;
      }

      const resolvedAgentId = credRow.agent_id;
      const rate = gatewayRateLimiter.check(resolvedAgentId);
      if (!rate.allowed) {
        res.status(429).json({
          error: 'Limite de pedidos por minuto excedido para este agente.',
          retry_after_seconds: rate.retryAfterSeconds,
        });
        return;
      }

      const actionType = sanitizeTextInput(String(req.body?.action_type || ''), 80);
      const description = sanitizeTextInput(String(req.body?.description || ''), 500);
      const amount =
        req.body?.amount !== undefined && req.body?.amount !== null ? Number(req.body.amount) : null;
      const currency = sanitizeTextInput(String(req.body?.currency || 'EUR'), 10);
      const resourceId = req.body?.resource_id ? sanitizeTextInput(String(req.body.resource_id), 120) : null;
      const toolName = req.body?.tool_name ? sanitizeTextInput(String(req.body.tool_name), 80) : null;
      const idempotencyKey = req.body?.idempotency_key
        ? sanitizeTextInput(String(req.body.idempotency_key), 120)
        : null;

      if (!actionType || !description) {
        res.status(400).json({ error: 'Campos obrigatórios: action_type e description.' });
        return;
      }

      if (req.body?.agent_id && String(req.body.agent_id) !== resolvedAgentId) {
        res.status(403).json({ error: 'O agent_id indicado não corresponde à credencial autenticada.' });
        return;
      }

      if (idempotencyKey) {
        const existingIdem = await tenantDb.approvals.findIdempotencyRecord(idempotencyKey);
        if (existingIdem) {
          if (existingIdem.decision === 'BLOCKED') {
            res.status(403).json({ ...existingIdem.response, idempotent_replay: true });
            return;
          }
          res.json({ ...existingIdem.response, idempotent_replay: true });
          return;
        }
      }

      const [agent, policies] = await Promise.all([
        tenantDb.agents.getAgentById(resolvedAgentId),
        tenantDb.policies.listPolicies(),
      ]);
      if (!agent) {
        res.status(404).json({ error: 'Agente não encontrado.' });
        return;
      }

      const evalResult = evaluateAuthorization({
        agent,
        agentTools: agent.tools || [],
        policies,
        request: {
          action_type: actionType,
          tool_name: toolName,
          description,
          amount,
          currency,
          resource_id: resourceId,
          target_company_id: req.body?.company_id ? String(req.body.company_id) : null,
        },
      });

      const recorded = await tenantDb.approvals.recordAuthorizationAndOptionalApproval({
        agentId: resolvedAgentId,
        actionType,
        toolName,
        description,
        amount,
        currency,
        resourceId,
        idempotencyKey,
        decision: evalResult.decision,
        reason: evalResult.reason,
        policyId: evalResult.matchedPolicy?.id ?? null,
        policyName: evalResult.matchedPolicy?.name ?? 'Política Empresarial',
        riskLevel: evalResult.riskLevel,
        isSimulation: false,
        createApproval: evalResult.decision === 'REQUIRES_APPROVAL',
      });

      await tenantDb.agents.recordAgentExecution(resolvedAgentId, credRow.id);

      await tenantDb.audit.appendAuditEvent({
        actorType: 'agent',
        actorId: resolvedAgentId,
        actorName: agent.name,
        eventType: evalResult.decision === 'BLOCKED' ? 'blocked_action' : 'authorization_decision',
        action: `API Gateway: ${actionType} (${description})`,
        result: evalResult.decision,
        reason: evalResult.reason,
        relatedPolicy: evalResult.matchedPolicy?.name ?? null,
      });

      if (evalResult.decision === 'ALLOWED') {
        res.json({ decision: 'ALLOWED', authorization_id: recorded.authorizationId });
        return;
      }
      if (evalResult.decision === 'REQUIRES_APPROVAL') {
        res.json({ decision: 'REQUIRES_APPROVAL', approval_request_id: recorded.approvalRequestId });
        return;
      }
      res.status(403).json({
        decision: 'BLOCKED',
        reason: evalResult.reason,
      });
    })
  );

  return router;
}
