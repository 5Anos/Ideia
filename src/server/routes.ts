import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { db, isSupabaseConfigured, seedIntegrationsForCompany } from './db.ts';
import {
  generateAgentCredential,
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
import {
  deleteDriveDatabaseFile,
  findOrCreateMandatoFolder,
  listMandatoDriveDatabaseFiles,
  restoreCompanySnapshotFromGoogleDrive,
  syncCompanySnapshotToGoogleDrive,
  verifyGoogleDriveAccount,
} from './googleDriveSync.ts';
import { TOOL_CATALOG } from './seedTemplates.ts';
import type {
  Agent,
  AgentInstructions,
  AgentPermissionsConfig,
  AgentTool,
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

function writeAuditLog(params: {
  companyId: string;
  actorType: 'user' | 'agent' | 'system';
  actorId: string;
  actorName: string;
  eventType: string;
  action: string;
  result: string;
  reason: string;
  relatedPolicy?: string | null;
  metadata?: Record<string, unknown>;
  isDemo?: boolean;
}): void {
  db.prepare(`
    INSERT INTO audit_logs (
      id, company_id, actor_type, actor_id, actor_name, event_type,
      action, result, reason, related_policy, metadata, is_demo, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    params.companyId,
    params.actorType,
    params.actorId,
    params.actorName,
    params.eventType,
    params.action,
    params.result,
    params.reason,
    params.relatedPolicy ?? null,
    JSON.stringify(params.metadata ?? {}),
    params.isDemo ? 1 : 0,
    new Date().toISOString()
  );
}

function hydrateAgentRow(row: Record<string, unknown>): Agent {
  const agentId = String(row.id);
  const companyId = String(row.company_id);

  const toolsRows = db
    .prepare('SELECT * FROM agent_tools WHERE agent_id = ? AND company_id = ? ORDER BY tool_name ASC')
    .all(agentId, companyId) as Array<Record<string, unknown>>;

  const policyRows = db
    .prepare(`
      SELECT p.* FROM policies p
      INNER JOIN policy_assignments pa ON pa.policy_id = p.id
      WHERE pa.agent_id = ? AND pa.company_id = ?
    `)
    .all(agentId, companyId) as Array<Record<string, unknown>>;

  const credRow = db
    .prepare('SELECT key_prefix, status FROM agent_credentials WHERE agent_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(agentId, companyId) as { key_prefix: string; status: 'active' | 'revoked' | 'suspended' } | undefined;

  return {
    id: agentId,
    company_id: companyId,
    name: String(row.name),
    description: String(row.description),
    category: String(row.category),
    objective: String(row.objective),
    origin: row.origin as Agent['origin'],
    provider: String(row.provider),
    model: String(row.model),
    external_identifier: row.external_identifier ? String(row.external_identifier) : null,
    status: row.status as Agent['status'],
    security_status: row.security_status as Agent['security_status'],
    avatar_icon: String(row.avatar_icon || 'bot'),
    instructions: JSON.parse(String(row.instructions || '{}')) as AgentInstructions,
    permissions_summary: JSON.parse(String(row.permissions_summary || '{}')) as AgentPermissionsConfig,
    actions_count: Number(row.actions_count || 0),
    last_activity_at: row.last_activity_at ? String(row.last_activity_at) : null,
    is_demo: Boolean(row.is_demo),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    tools: toolsRows.map((t) => ({
      id: String(t.id),
      agent_id: String(t.agent_id),
      tool_key: String(t.tool_key),
      tool_name: String(t.tool_name),
      category: String(t.category),
      risk_level: t.risk_level as AgentTool['risk_level'],
      is_enabled: Boolean(t.is_enabled),
      requires_approval: Boolean(t.requires_approval),
    })),
    policies: policyRows.map(hydratePolicyRow),
    credential_prefix: credRow?.key_prefix ?? null,
    credential_status: credRow?.status ?? null,
  };
}

function hydratePolicyRow(row: Record<string, unknown>): Policy {
  return {
    id: String(row.id),
    company_id: String(row.company_id),
    name: String(row.name),
    description: String(row.description),
    action_type: String(row.action_type),
    rule_type: row.rule_type as Policy['rule_type'],
    max_auto_amount: row.max_auto_amount !== null && row.max_auto_amount !== undefined ? Number(row.max_auto_amount) : null,
    max_approval_amount:
      row.max_approval_amount !== null && row.max_approval_amount !== undefined ? Number(row.max_approval_amount) : null,
    currency: String(row.currency || 'EUR'),
    conditions: JSON.parse(String(row.conditions || '{}')),
    is_absolute_restriction: Boolean(row.is_absolute_restriction),
    status: row.status as Policy['status'],
    is_demo: Boolean(row.is_demo),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
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

  const row = db
    .prepare(`
      SELECT p.id as user_id, p.email, p.full_name, p.job_title,
             cm.role, cm.status as member_status,
             c.id as company_id, c.name as company_name, c.subscription_plan, c.is_demo
      FROM profiles p
      INNER JOIN company_members cm ON cm.user_id = p.id
      INNER JOIN companies c ON c.id = cm.company_id
      WHERE p.id = ? AND c.id = ?
    `)
    .get(payload.userId, payload.companyId) as Record<string, unknown> | undefined;

  if (!row || row.member_status !== 'active') {
    res.status(403).json({ error: 'Conta suspensa ou sem acesso ativo a esta empresa.' });
    return;
  }

  req.session = {
    user_id: String(row.user_id),
    email: String(row.email),
    full_name: String(row.full_name),
    job_title: String(row.job_title || ''),
    role: row.role as UserRole,
    company_id: String(row.company_id),
    company_name: String(row.company_name),
    subscription_plan: row.subscription_plan as SubscriptionPlan,
    is_demo_company: Boolean(row.is_demo),
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

export function createApiRouter(): express.Router {
  const router = express.Router();

  // ========================
  // 1. AUTENTICAÇÃO & SESSÃO
  // ========================
  router.post('/api/auth/login', (req: Request, res: Response) => {
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

    const profile = db
      .prepare('SELECT * FROM profiles WHERE lower(email) = ?')
      .get(email) as Record<string, unknown> | undefined;

    if (!profile || !verifyPassword(password, String(profile.password_hash))) {
      res.status(401).json({ error: 'Credenciais inválidas.' });
      return;
    }

    const membership = db
      .prepare(`
        SELECT cm.role, cm.status, c.id as company_id, c.name as company_name, c.subscription_plan, c.is_demo
        FROM company_members cm
        INNER JOIN companies c ON c.id = cm.company_id
        WHERE cm.user_id = ? AND cm.status = 'active'
        LIMIT 1
      `)
      .get(String(profile.id)) as Record<string, unknown> | undefined;

    if (!membership) {
      res.status(403).json({ error: 'Utilizador sem empresa ativa associada.' });
      return;
    }

    const token = signSessionToken(String(profile.id), String(membership.company_id));
    res.json({
      token,
      user: {
        user_id: String(profile.id),
        email: String(profile.email),
        full_name: String(profile.full_name),
        job_title: String(profile.job_title || ''),
        role: membership.role,
        company_id: String(membership.company_id),
        company_name: String(membership.company_name),
        subscription_plan: membership.subscription_plan,
        is_demo_company: Boolean(membership.is_demo),
      },
    });
  });

  router.post('/api/auth/demo-login', (req: Request, res: Response) => {
    const roleRequested = (req.body?.role as UserRole) || 'OWNER';
    const membership = db
      .prepare(`
        SELECT p.id as user_id, p.email, p.full_name, p.job_title,
               cm.role, c.id as company_id, c.name as company_name, c.subscription_plan, c.is_demo
        FROM company_members cm
        INNER JOIN profiles p ON p.id = cm.user_id
        INNER JOIN companies c ON c.id = cm.company_id
        WHERE c.slug = 'empresa-demonstracao' AND cm.role = ? AND cm.status = 'active'
        LIMIT 1
      `)
      .get(roleRequested) as Record<string, unknown> | undefined;

    if (!membership) {
      res.status(404).json({ error: 'Utilizador de demonstração não encontrado.' });
      return;
    }

    const token = signSessionToken(String(membership.user_id), String(membership.company_id));
    res.json({
      token,
      user: {
        user_id: String(membership.user_id),
        email: String(membership.email),
        full_name: String(membership.full_name),
        job_title: String(membership.job_title || ''),
        role: membership.role,
        company_id: String(membership.company_id),
        company_name: String(membership.company_name),
        subscription_plan: membership.subscription_plan,
        is_demo_company: Boolean(membership.is_demo),
      },
    });
  });

  router.post('/api/auth/register', (req: Request, res: Response) => {
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

    const exists = db.prepare('SELECT id FROM profiles WHERE lower(email) = ?').get(email);
    if (exists) {
      res.status(409).json({ error: 'Já existe uma conta registada com este endereço de email.' });
      return;
    }

    const now = new Date().toISOString();
    const companyId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const slugBase = companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'empresa';
    const slug = `${slugBase}-${crypto.randomBytes(3).toString('hex')}`;
    const initials = fullName
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() || '')
      .join('');

    db.transaction(() => {
      db.prepare(`
        INSERT INTO companies (id, name, slug, nif, sector, subscription_plan, is_demo, retention_days, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'Geral', 'PROFESSIONAL', 0, 365, ?, ?)
      `).run(companyId, companyName, slug, nif || null, now, now);

      db.prepare(`
        INSERT INTO profiles (id, email, password_hash, full_name, job_title, avatar_initials, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'Administrador Inicial', ?, ?, ?)
      `).run(userId, email, hashPassword(password), fullName, initials || 'AD', now, now);

      db.prepare(`
        INSERT INTO company_members (id, company_id, user_id, role, status, created_at, updated_at)
        VALUES (?, ?, ?, 'OWNER', 'active', ?, ?)
      `).run(crypto.randomUUID(), companyId, userId, now, now);

      // Política de proteção bancária obrigatória criada por omissão para novas empresas
      db.prepare(`
        INSERT INTO policies (
          id, company_id, name, description, action_type, rule_type,
          currency, is_absolute_restriction, status, is_demo, created_at, updated_at
        ) VALUES (?, ?, 'Proteção Absoluta de Dados Bancários', 'Proibição absoluta de alteração de IBAN por agentes.', 'bank_details_update', 'block_always', 'EUR', 1, 'active', 0, ?, ?)
      `).run(crypto.randomUUID(), companyId, now, now);

      seedIntegrationsForCompany(companyId);

      writeAuditLog({
        companyId,
        actorType: 'user',
        actorId: userId,
        actorName: fullName,
        eventType: 'company_created',
        action: `Registo da empresa ${companyName}`,
        result: 'Sucesso',
        reason: 'Conta empresarial criada com isolamento multi-tenant e proteção bancária ativa.',
      });
    })();

    const token = signSessionToken(userId, companyId);
    res.status(201).json({
      token,
      user: {
        user_id: userId,
        email,
        full_name: fullName,
        job_title: 'Administrador Inicial',
        role: 'OWNER',
        company_id: companyId,
        company_name: companyName,
        subscription_plan: 'PROFESSIONAL',
        is_demo_company: false,
      },
    });
  });

  router.post('/api/auth/recover', (req: Request, res: Response) => {
    const email = sanitizeTextInput(String(req.body?.email || '')).toLowerCase();
    const newPassword = req.body?.new_password ? String(req.body.new_password) : null;
    const recoveryToken = req.body?.recovery_token ? String(req.body.recovery_token) : null;

    if (!email) {
      res.status(400).json({ error: 'Indique o email da conta.' });
      return;
    }

    const user = db.prepare('SELECT * FROM profiles WHERE lower(email) = ?').get(email) as
      | Record<string, unknown>
      | undefined;

    if (recoveryToken && newPassword) {
      if (!user || user.recovery_token !== recoveryToken) {
        res.status(400).json({ error: 'Código de recuperação inválido.' });
        return;
      }
      if (newPassword.length < 8) {
        res.status(400).json({ error: 'A nova palavra-passe deve ter pelo menos 8 caracteres.' });
        return;
      }
      db.prepare('UPDATE profiles SET password_hash = ?, recovery_token = NULL, updated_at = ? WHERE id = ?').run(
        hashPassword(newPassword),
        new Date().toISOString(),
        String(user.id)
      );
      res.json({ message: 'Palavra-passe atualizada com sucesso. Pode iniciar sessão.' });
      return;
    }

    if (user) {
      const code = crypto.randomBytes(4).toString('hex').toUpperCase();
      db.prepare('UPDATE profiles SET recovery_token = ? WHERE id = ?').run(code, String(user.id));
      const emailConfigured = Boolean(process.env.SMTP_HOST);
      res.json({
        message: emailConfigured
          ? 'Enviámos instruções de recuperação para o seu email.'
          : `SMTP externo não configurado neste ambiente. Código de recuperação local para teste: ${code}`,
        dev_recovery_code: emailConfigured ? undefined : code,
      });
      return;
    }

    res.json({ message: 'Se o endereço existir, receberá instruções de recuperação.' });
  });

  router.get('/api/auth/me', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    res.json({ user: req.session });
  });

  // ========================
  // 2. SISTEMA & MODELOS DE IA
  // ========================
  router.get('/api/system/status', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    res.json({
      ai_providers: getAIProvidersStatus(),
      supabase_configured: isSupabaseConfigured(),
      database_mode: isSupabaseConfigured() ? 'Supabase PostgreSQL' : 'SQLite Local Persistente (.data/mandato.db)',
      gemini_configured: geminiProvider.isConfigured(),
      subscription_limits: SUBSCRIPTION_LIMITS[req.session!.subscription_plan],
    });
  });

  router.get('/api/templates', resolveSessionFromRequest, (_req: AuthedRequest, res: Response) => {
    const rows = db.prepare('SELECT * FROM agent_templates ORDER BY name ASC').all() as Array<Record<string, unknown>>;
    const templates = rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      category: String(r.category),
      description: String(r.description),
      objective: String(r.objective),
      suggested_instructions: JSON.parse(String(r.suggested_instructions)),
      suggested_tools: JSON.parse(String(r.suggested_tools)),
      suggested_permissions: JSON.parse(String(r.suggested_permissions)),
      recommended_restrictions: JSON.parse(String(r.recommended_restrictions)),
    }));
    res.json({ templates, tool_catalog: TOOL_CATALOG });
  });

  // ========================
  // 3. DASHBOARD — VISÃO GERAL
  // ========================
  router.get('/api/dashboard', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    const companyId = req.session!.company_id;
    const agents = db
      .prepare('SELECT * FROM agents WHERE company_id = ?')
      .all(companyId) as Array<Record<string, unknown>>;
    const authRequests = db
      .prepare(`
        SELECT ar.*, a.name as agent_name
        FROM authorization_requests ar
        LEFT JOIN agents a ON a.id = ar.agent_id
        WHERE ar.company_id = ?
        ORDER BY ar.created_at DESC
      `)
      .all(companyId) as Array<Record<string, unknown>>;
    const pendingApprovals = db
      .prepare(`
        SELECT apr.*, a.name as agent_name
        FROM approval_requests apr
        LEFT JOIN agents a ON a.id = apr.agent_id
        WHERE apr.company_id = ? AND apr.status = 'Pendente'
        ORDER BY apr.created_at DESC
      `)
      .all(companyId) as Array<Record<string, unknown>>;
    const policies = db
      .prepare('SELECT * FROM policies WHERE company_id = ?')
      .all(companyId) as Array<Record<string, unknown>>;
    const recentAudit = db
      .prepare('SELECT * FROM audit_logs WHERE company_id = ? ORDER BY created_at DESC LIMIT 10')
      .all(companyId) as Array<Record<string, unknown>>;

    const totalAgents = agents.filter((a) => a.status !== 'archived').length;
    const activeAgents = agents.filter((a) => a.status === 'active' || a.status === 'running').length;
    const runningAgents = agents.filter((a) => a.status === 'running').length;
    const verifiedActions = authRequests.length;
    const pendingCount = pendingApprovals.length;
    const blockedCount = authRequests.filter((r) => r.decision === 'BLOCKED').length;

    // Agrupamento diário dos últimos 7 dias
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

    // Desempenho por agente
    const agentPerformance = agents
      .filter((a) => a.status !== 'archived')
      .map((a) => {
        const agReqs = authRequests.filter((r) => r.agent_id === a.id);
        return {
          id: String(a.id),
          name: String(a.name),
          category: String(a.category),
          status: String(a.status),
          completed_tasks: Number(a.actions_count || 0) + agReqs.filter((r) => r.decision === 'ALLOWED').length,
          authorization_requests: agReqs.length,
          blocked_actions: agReqs.filter((r) => r.decision === 'BLOCKED').length,
        };
      })
      .sort((a, b) => b.completed_tasks - a.completed_tasks);

    // Estado de segurança
    const agentsWithoutPolicy = agents.filter((a) => {
      const cnt = db
        .prepare('SELECT COUNT(*) as c FROM policy_assignments WHERE agent_id = ? AND company_id = ?')
        .get(String(a.id), companyId) as { c: number };
      return cnt.c === 0 && a.status !== 'archived';
    }).length;
    const suspendedCreds = agents.filter((a) => a.security_status === 'credentials_suspended').length;
    const policiesReview = policies.filter((p) => p.status === 'review_required').length;
    const recentIncidents = recentAudit.filter(
      (l) => l.event_type === 'blocked_action' || l.result === 'BLOCKED'
    ).length;

    res.json({
      kpis: {
        total_agents: totalAgents,
        active_agents: activeAgents,
        running_agents: runningAgents,
        verified_actions: verifiedActions,
        pending_approvals: pendingCount,
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
  });

  // ========================
  // 4. FÁBRICA E GESTÃO DE AGENTES
  // ========================
  router.get('/api/agents', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    const rows = db
      .prepare('SELECT * FROM agents WHERE company_id = ? ORDER BY created_at DESC')
      .all(req.session!.company_id) as Array<Record<string, unknown>>;
    res.json({ agents: rows.map(hydrateAgentRow) });
  });

  router.get('/api/agents/:id', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    const row = db
      .prepare('SELECT * FROM agents WHERE id = ? AND company_id = ?')
      .get(req.params.id, req.session!.company_id) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'Agente não encontrado nesta empresa.' });
      return;
    }
    const agent = hydrateAgentRow(row);
    const activity = db
      .prepare('SELECT * FROM authorization_requests WHERE agent_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT 30')
      .all(agent.id, req.session!.company_id);
    const versions = db
      .prepare('SELECT * FROM agent_versions WHERE agent_id = ? AND company_id = ? ORDER BY version_number DESC')
      .all(agent.id, req.session!.company_id);
    res.json({ agent, activity, versions });
  });

  router.post(
    '/api/agents/generate-instructions',
    resolveSessionFromRequest,
    requireCapability('create_agent'),
    async (req: AuthedRequest, res: Response) => {
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
    }
  );

  router.post(
    '/api/agents',
    resolveSessionFromRequest,
    requireCapability('create_agent'),
    (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
      const planLimits = SUBSCRIPTION_LIMITS[req.session!.subscription_plan];
      const currentCount = (
        db
          .prepare("SELECT COUNT(*) as c FROM agents WHERE company_id = ? AND status != 'archived'")
          .get(companyId) as { c: number }
      ).c;

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

      const now = new Date().toISOString();
      const agentId = crypto.randomUUID();
      const cred = generateAgentCredential(origin === 'EXTERNAL' ? 'mdt_ext' : 'mdt_live');
      const secStatus = policyIds.length > 0 ? 'protected' : 'needs_policy';

      db.transaction(() => {
        db.prepare(`
          INSERT INTO agents (
            id, company_id, name, description, category, objective, origin,
            provider, model, external_identifier, status, security_status,
            avatar_icon, instructions, permissions_summary, actions_count,
            last_activity_at, is_demo, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, ?, ?)
        `).run(
          agentId,
          companyId,
          name,
          description,
          category,
          objective || description,
          origin,
          provider,
          model,
          externalIdentifier,
          requestedStatus,
          secStatus,
          sanitizeTextInput(String(req.body?.avatar_icon || 'bot'), 40),
          JSON.stringify(instructions),
          JSON.stringify(permissionsSummary),
          req.session!.user_id,
          now,
          now
        );

        db.prepare(`
          INSERT INTO agent_versions (id, company_id, agent_id, version_number, instructions, model, provider, created_by, created_at)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), companyId, agentId, JSON.stringify(instructions), model, provider, req.session!.user_id, now);

        db.prepare(`
          INSERT INTO agent_credentials (id, company_id, agent_id, key_prefix, key_hash, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?)
        `).run(crypto.randomUUID(), companyId, agentId, cred.keyPrefix, cred.keyHash, now);

        const insertTool = db.prepare(`
          INSERT INTO agent_tools (id, company_id, agent_id, tool_key, tool_name, category, risk_level, is_enabled, requires_approval, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const selectionMap = new Map(selectedToolsInput.map((t) => [t.tool_key, t]));
        for (const catTool of TOOL_CATALOG) {
          const picked = selectionMap.get(catTool.tool_key);
          // Ferramentas perigosas ficam desativadas por omissão salvo escolha explícita
          const enabled = picked ? Boolean(picked.is_enabled) : false;
          const reqApproval = picked ? Boolean(picked.requires_approval) : catTool.default_requires_approval;
          insertTool.run(
            crypto.randomUUID(),
            companyId,
            agentId,
            catTool.tool_key,
            catTool.tool_name,
            catTool.category,
            catTool.risk_level,
            enabled ? 1 : 0,
            reqApproval ? 1 : 0,
            now
          );
        }

        const insertAssign = db.prepare(`
          INSERT OR IGNORE INTO policy_assignments (id, company_id, policy_id, agent_id, created_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const pid of policyIds) {
          const validPol = db
            .prepare('SELECT id FROM policies WHERE id = ? AND company_id = ?')
            .get(pid, companyId);
          if (validPol) {
            insertAssign.run(crypto.randomUUID(), companyId, pid, agentId, now);
          }
        }

        writeAuditLog({
          companyId,
          actorType: 'user',
          actorId: req.session!.user_id,
          actorName: req.session!.full_name,
          eventType: origin === 'EXTERNAL' ? 'external_agent_registered' : 'agent_created',
          action: `Criação de agente "${name}" (${origin})`,
          result: 'Sucesso',
          reason: `Estado inicial: ${requestedStatus}. Políticas associadas: ${policyIds.length}.`,
        });
      })();

      const created = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown>;
      res.status(201).json({
        agent: hydrateAgentRow(created),
        issued_api_key: cred.rawKey,
      });
    }
  );

  router.patch(
    '/api/agents/:id',
    resolveSessionFromRequest,
    requireCapability('manage_agent'),
    (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
      const existing = db
        .prepare('SELECT * FROM agents WHERE id = ? AND company_id = ?')
        .get(req.params.id, companyId) as Record<string, unknown> | undefined;
      if (!existing) {
        res.status(404).json({ error: 'Agente não encontrado.' });
        return;
      }

      const name = req.body?.name ? sanitizeTextInput(String(req.body.name), 120) : String(existing.name);
      const description = req.body?.description
        ? sanitizeTextInput(String(req.body.description), 500)
        : String(existing.description);
      const provider = req.body?.provider ? sanitizeTextInput(String(req.body.provider), 60) : String(existing.provider);
      const model = req.body?.model ? sanitizeTextInput(String(req.body.model), 80) : String(existing.model);
      const instructions = req.body?.instructions ? JSON.stringify(req.body.instructions) : String(existing.instructions);
      const permissions = req.body?.permissions_summary
        ? JSON.stringify(req.body.permissions_summary)
        : String(existing.permissions_summary);
      const now = new Date().toISOString();

      db.prepare(`
        UPDATE agents
        SET name = ?, description = ?, provider = ?, model = ?, instructions = ?, permissions_summary = ?, updated_at = ?
        WHERE id = ? AND company_id = ?
      `).run(name, description, provider, model, instructions, permissions, now, req.params.id, companyId);

      const maxVer = (
        db.prepare('SELECT MAX(version_number) as v FROM agent_versions WHERE agent_id = ?').get(req.params.id) as {
          v: number | null;
        }
      ).v ?? 0;

      db.prepare(`
        INSERT INTO agent_versions (id, company_id, agent_id, version_number, instructions, model, provider, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), companyId, req.params.id, maxVer + 1, instructions, model, provider, req.session!.user_id, now);

      writeAuditLog({
        companyId,
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: 'agent_updated',
        action: `Atualização do agente "${name}"`,
        result: 'Sucesso',
        reason: `Nova versão v${maxVer + 1} guardada.`,
      });

      const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown>;
      res.json({ agent: hydrateAgentRow(updated) });
    }
  );

  router.patch(
    '/api/agents/:id/status',
    resolveSessionFromRequest,
    requireCapability('manage_agent'),
    (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
      const newStatus = String(req.body?.status || '');
      if (!['draft', 'active', 'running', 'suspended', 'archived'].includes(newStatus)) {
        res.status(400).json({ error: 'Estado de agente inválido.' });
        return;
      }

      const existing = db
        .prepare('SELECT * FROM agents WHERE id = ? AND company_id = ?')
        .get(req.params.id, companyId) as Record<string, unknown> | undefined;
      if (!existing) {
        res.status(404).json({ error: 'Agente não encontrado.' });
        return;
      }

      if (newStatus === 'active' || newStatus === 'running') {
        const polCount = (
          db
            .prepare('SELECT COUNT(*) as c FROM policy_assignments WHERE agent_id = ? AND company_id = ?')
            .get(req.params.id, companyId) as { c: number }
        ).c;
        if (polCount === 0) {
          res.status(400).json({
            error: 'Não é possível ativar um agente sem políticas de autorização atribuídas.',
          });
          return;
        }
      }

      db.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ? AND company_id = ?').run(
        newStatus,
        new Date().toISOString(),
        req.params.id,
        companyId
      );

      writeAuditLog({
        companyId,
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: newStatus === 'suspended' ? 'agent_suspended' : 'agent_status_changed',
        action: `Alteração de estado do agente "${existing.name}" para "${newStatus}"`,
        result: 'Sucesso',
        reason: 'Operação executada pela gestão de agentes.',
      });

      const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown>;
      res.json({ agent: hydrateAgentRow(updated) });
    }
  );

  router.post(
    '/api/agents/:id/duplicate',
    resolveSessionFromRequest,
    requireCapability('create_agent'),
    (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
      const sourceRow = db
        .prepare('SELECT * FROM agents WHERE id = ? AND company_id = ?')
        .get(req.params.id, companyId) as Record<string, unknown> | undefined;
      if (!sourceRow) {
        res.status(404).json({ error: 'Agente não encontrado.' });
        return;
      }

      const newId = crypto.randomUUID();
      const now = new Date().toISOString();
      const copyName = `${sourceRow.name} (Cópia)`;
      const cred = generateAgentCredential('mdt_live');

      db.transaction(() => {
        db.prepare(`
          INSERT INTO agents (
            id, company_id, name, description, category, objective, origin,
            provider, model, external_identifier, status, security_status,
            avatar_icon, instructions, permissions_summary, actions_count,
            last_activity_at, is_demo, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'draft', ?, ?, ?, ?, 0, NULL, 0, ?, ?, ?)
        `).run(
          newId,
          companyId,
          copyName,
          sourceRow.description,
          sourceRow.category,
          sourceRow.objective,
          sourceRow.origin,
          sourceRow.provider,
          sourceRow.model,
          sourceRow.security_status,
          sourceRow.avatar_icon,
          sourceRow.instructions,
          sourceRow.permissions_summary,
          req.session!.user_id,
          now,
          now
        );

        db.prepare(`
          INSERT INTO agent_credentials (id, company_id, agent_id, key_prefix, key_hash, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?)
        `).run(crypto.randomUUID(), companyId, newId, cred.keyPrefix, cred.keyHash, now);

        const tools = db
          .prepare('SELECT * FROM agent_tools WHERE agent_id = ? AND company_id = ?')
          .all(req.params.id, companyId) as Array<Record<string, unknown>>;
        const insTool = db.prepare(`
          INSERT INTO agent_tools (id, company_id, agent_id, tool_key, tool_name, category, risk_level, is_enabled, requires_approval, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const t of tools) {
          insTool.run(crypto.randomUUID(), companyId, newId, t.tool_key, t.tool_name, t.category, t.risk_level, t.is_enabled, t.requires_approval, now);
        }

        const pols = db
          .prepare('SELECT policy_id FROM policy_assignments WHERE agent_id = ? AND company_id = ?')
          .all(req.params.id, companyId) as Array<{ policy_id: string }>;
        const insPol = db.prepare(`
          INSERT INTO policy_assignments (id, company_id, policy_id, agent_id, created_at) VALUES (?, ?, ?, ?, ?)
        `);
        for (const p of pols) {
          insPol.run(crypto.randomUUID(), companyId, p.policy_id, newId, now);
        }

        writeAuditLog({
          companyId,
          actorType: 'user',
          actorId: req.session!.user_id,
          actorName: req.session!.full_name,
          eventType: 'agent_created',
          action: `Duplicação do agente "${sourceRow.name}"`,
          result: 'Sucesso',
          reason: `Criado rascunho "${copyName}".`,
        });
      })();

      const created = db.prepare('SELECT * FROM agents WHERE id = ?').get(newId) as Record<string, unknown>;
      res.status(201).json({ agent: hydrateAgentRow(created) });
    }
  );

  router.patch(
    '/api/agents/:id/tools',
    resolveSessionFromRequest,
    requireCapability('manage_agent'),
    (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
      const toolId = String(req.body?.tool_id || '');
      const isEnabled = Boolean(req.body?.is_enabled);
      const requiresApproval = req.body?.requires_approval !== undefined ? Boolean(req.body.requires_approval) : true;

      const tool = db
        .prepare('SELECT * FROM agent_tools WHERE id = ? AND agent_id = ? AND company_id = ?')
        .get(toolId, req.params.id, companyId) as Record<string, unknown> | undefined;
      if (!tool) {
        res.status(404).json({ error: 'Ferramenta não encontrada para este agente.' });
        return;
      }

      db.prepare('UPDATE agent_tools SET is_enabled = ?, requires_approval = ? WHERE id = ? AND company_id = ?').run(
        isEnabled ? 1 : 0,
        requiresApproval ? 1 : 0,
        toolId,
        companyId
      );

      writeAuditLog({
        companyId,
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: 'agent_tool_updated',
        action: `${isEnabled ? 'Ativação' : 'Desativação'} da ferramenta "${tool.tool_name}"`,
        result: 'Sucesso',
        reason: 'Alteração de configuração de ferramentas. Continua sujeita ao motor de políticas.',
      });

      const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown>;
      res.json({ agent: hydrateAgentRow(updated) });
    }
  );

  router.post(
    '/api/agents/:id/credentials/rotate',
    resolveSessionFromRequest,
    requireCapability('manage_agent'),
    (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
      const agent = db
        .prepare('SELECT * FROM agents WHERE id = ? AND company_id = ?')
        .get(req.params.id, companyId) as Record<string, unknown> | undefined;
      if (!agent) {
        res.status(404).json({ error: 'Agente não encontrado.' });
        return;
      }

      const cred = generateAgentCredential(agent.origin === 'EXTERNAL' ? 'mdt_ext' : 'mdt_live');
      const now = new Date().toISOString();

      db.transaction(() => {
        db.prepare("UPDATE agent_credentials SET status = 'revoked' WHERE agent_id = ? AND company_id = ?").run(
          req.params.id,
          companyId
        );
        db.prepare(`
          INSERT INTO agent_credentials (id, company_id, agent_id, key_prefix, key_hash, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?)
        `).run(crypto.randomUUID(), companyId, req.params.id, cred.keyPrefix, cred.keyHash, now);

        db.prepare("UPDATE agents SET security_status = 'protected', updated_at = ? WHERE id = ?").run(now, req.params.id);

        writeAuditLog({
          companyId,
          actorType: 'user',
          actorId: req.session!.user_id,
          actorName: req.session!.full_name,
          eventType: 'credential_rotated',
          action: `Rotação de credenciais API do agente "${agent.name}"`,
          result: 'Sucesso',
          reason: `Nova chave prefixo ${cred.keyPrefix} emitida; chave anterior revogada.`,
        });
      })();

      res.json({ api_key: cred.rawKey, key_prefix: cred.keyPrefix });
    }
  );

  router.post(
    '/api/agents/:id/credentials/revoke',
    resolveSessionFromRequest,
    requireCapability('manage_agent'),
    (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
      const agent = db
        .prepare('SELECT * FROM agents WHERE id = ? AND company_id = ?')
        .get(req.params.id, companyId) as Record<string, unknown> | undefined;
      if (!agent) {
        res.status(404).json({ error: 'Agente não encontrado.' });
        return;
      }

      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare("UPDATE agent_credentials SET status = 'revoked' WHERE agent_id = ? AND company_id = ?").run(
          req.params.id,
          companyId
        );
        db.prepare("UPDATE agents SET security_status = 'credentials_suspended', updated_at = ? WHERE id = ?").run(
          now,
          req.params.id
        );
        writeAuditLog({
          companyId,
          actorType: 'user',
          actorId: req.session!.user_id,
          actorName: req.session!.full_name,
          eventType: 'credential_revoked',
          action: `Revogação de credenciais do agente "${agent.name}"`,
          result: 'Revogado',
          reason: 'Credenciais suspensas manualmente pela administração.',
        });
      })();

      res.json({ status: 'revoked' });
    }
  );

  // ========================
  // 5. TESTAR AGENTE (GEMINI + MOTOR DE AUTORIZAÇÃO)
  // ========================
  router.post(
    '/api/agents/:id/test',
    resolveSessionFromRequest,
    requireCapability('test_agent'),
    async (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
      const message = sanitizeTextInput(String(req.body?.message || ''), 2000);
      const isSimulation = req.body?.is_simulation !== false;

      if (!message) {
        res.status(400).json({ error: 'Escreva uma mensagem para testar o agente.' });
        return;
      }

      const row = db
        .prepare('SELECT * FROM agents WHERE id = ? AND company_id = ?')
        .get(req.params.id, companyId) as Record<string, unknown> | undefined;
      if (!row) {
        res.status(404).json({ error: 'Agente não encontrado.' });
        return;
      }

      const agent = hydrateAgentRow(row);
      const policies = (
        db.prepare('SELECT * FROM policies WHERE company_id = ?').all(companyId) as Array<Record<string, unknown>>
      ).map(hydratePolicyRow);

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
          const now = new Date().toISOString();
          createdAuthId = crypto.randomUUID();
          const dec = result.authorizationResult.decision;

          db.prepare(`
            INSERT INTO authorization_requests (
              id, company_id, agent_id, action_type, tool_name, description,
              amount, currency, resource_id, idempotency_key, decision, reason,
              policy_id, is_simulation, is_demo, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, 0, ?)
          `).run(
            createdAuthId,
            companyId,
            agent.id,
            result.proposedAction.action_type,
            result.proposedAction.tool_name,
            result.proposedAction.description,
            result.proposedAction.amount,
            result.proposedAction.resource_id,
            `test_${createdAuthId}`,
            dec,
            result.authorizationResult.reason,
            result.authorizationResult.matchedPolicy?.id ?? null,
            isSimulation ? 1 : 0,
            now
          );

          db.prepare('UPDATE agents SET actions_count = actions_count + 1, last_activity_at = ? WHERE id = ?').run(
            now,
            agent.id
          );

          // Em modo operação governada (não simulação), pedidos REQUIRES_APPROVAL vão para a fila real de aprovações
          if (!isSimulation && dec === 'REQUIRES_APPROVAL') {
            createdApprovalId = crypto.randomUUID();
            db.prepare(`
              INSERT INTO approval_requests (
                id, company_id, authorization_request_id, agent_id, requested_action,
                description, financial_value, currency, policy_name, risk_level,
                status, is_demo, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, 'Pendente', 0, ?, ?)
            `).run(
              createdApprovalId,
              companyId,
              createdAuthId,
              agent.id,
              result.proposedAction.action_type,
              result.proposedAction.description,
              result.proposedAction.amount,
              result.authorizationResult.matchedPolicy?.name || 'Política de Governação',
              result.authorizationResult.riskLevel,
              now,
              now
            );
          }

          writeAuditLog({
            companyId,
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
    }
  );

  // ========================
  // 6. POLÍTICAS E PERMISSÕES
  // ========================
  router.get('/api/policies', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    const rows = db
      .prepare('SELECT * FROM policies WHERE company_id = ? ORDER BY created_at DESC')
      .all(req.session!.company_id) as Array<Record<string, unknown>>;
    const policies = rows.map((r) => {
      const pol = hydratePolicyRow(r);
      const assigned = db
        .prepare('SELECT agent_id FROM policy_assignments WHERE policy_id = ? AND company_id = ?')
        .all(pol.id, req.session!.company_id) as Array<{ agent_id: string }>;
      return { ...pol, assigned_agent_ids: assigned.map((a) => a.agent_id) };
    });
    res.json({ policies });
  });

  router.post(
    '/api/policies',
    resolveSessionFromRequest,
    requireCapability('manage_policies'),
    (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
      const name = sanitizeTextInput(String(req.body?.name || ''), 140);
      const description = sanitizeTextInput(String(req.body?.description || ''), 500);
      const actionType = sanitizeTextInput(String(req.body?.action_type || ''), 80).toLowerCase();
      const ruleType = String(req.body?.rule_type || 'require_approval');
      const maxAuto = req.body?.max_auto_amount !== null && req.body?.max_auto_amount !== undefined && req.body?.max_auto_amount !== ''
        ? Number(req.body.max_auto_amount)
        : null;
      const maxApproval = req.body?.max_approval_amount !== null && req.body?.max_approval_amount !== undefined && req.body?.max_approval_amount !== ''
        ? Number(req.body.max_approval_amount)
        : null;
      const isAbsolute = Boolean(req.body?.is_absolute_restriction) || ruleType === 'block_always';

      if (!name || !actionType) {
        res.status(400).json({ error: 'Nome da política e tipo de ação são obrigatórios.' });
        return;
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO policies (
          id, company_id, name, description, action_type, rule_type,
          max_auto_amount, max_approval_amount, currency, conditions,
          is_absolute_restriction, status, is_demo, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, 'active', 0, ?, ?)
      `).run(
        id,
        companyId,
        name,
        description || `Regra de governação para ${actionType}`,
        actionType,
        ruleType,
        maxAuto,
        maxApproval,
        JSON.stringify(req.body?.conditions || {}),
        isAbsolute ? 1 : 0,
        now,
        now
      );

      const agentIds: string[] = Array.isArray(req.body?.agent_ids) ? req.body.agent_ids : [];
      const assign = db.prepare(`
        INSERT OR IGNORE INTO policy_assignments (id, company_id, policy_id, agent_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const agId of agentIds) {
        assign.run(crypto.randomUUID(), companyId, id, agId, now);
        db.prepare("UPDATE agents SET security_status = 'protected' WHERE id = ? AND company_id = ?").run(agId, companyId);
      }

      writeAuditLog({
        companyId,
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: 'policy_created',
        action: `Criação da política "${name}"`,
        result: 'Ativa',
        reason: `Ação: ${actionType}, regra: ${ruleType}.`,
        relatedPolicy: name,
      });

      const created = db.prepare('SELECT * FROM policies WHERE id = ?').get(id) as Record<string, unknown>;
      res.status(201).json({ policy: hydratePolicyRow(created) });
    }
  );

  router.patch(
    '/api/policies/:id',
    resolveSessionFromRequest,
    requireCapability('manage_policies'),
    (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
      const existing = db
        .prepare('SELECT * FROM policies WHERE id = ? AND company_id = ?')
        .get(req.params.id, companyId) as Record<string, unknown> | undefined;
      if (!existing) {
        res.status(404).json({ error: 'Política não encontrada.' });
        return;
      }

      // Impedir desativação de restrição absoluta crítica de dados bancários
      if (existing.action_type === 'bank_details_update' && req.body?.status === 'inactive') {
        res.status(403).json({
          error: 'Política de proteção absoluta de dados bancários não pode ser desativada.',
        });
        return;
      }

      const status = req.body?.status ? String(req.body.status) : String(existing.status);
      const maxAuto =
        req.body?.max_auto_amount !== undefined ? Number(req.body.max_auto_amount) : existing.max_auto_amount;
      const maxApproval =
        req.body?.max_approval_amount !== undefined
          ? Number(req.body.max_approval_amount)
          : existing.max_approval_amount;

      db.prepare(`
        UPDATE policies SET status = ?, max_auto_amount = ?, max_approval_amount = ?, updated_at = ?
        WHERE id = ? AND company_id = ?
      `).run(status, maxAuto, maxApproval, new Date().toISOString(), req.params.id, companyId);

      writeAuditLog({
        companyId,
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: 'policy_modified',
        action: `Alteração da política "${existing.name}"`,
        result: status,
        reason: `Limites atualizados (auto: €${maxAuto ?? '—'}, aprovação: €${maxApproval ?? '—'}).`,
        relatedPolicy: String(existing.name),
      });

      const updated = db.prepare('SELECT * FROM policies WHERE id = ?').get(req.params.id) as Record<string, unknown>;
      res.json({ policy: hydratePolicyRow(updated) });
    }
  );

  // ========================
  // 7. PEDIDOS DE APROVAÇÃO
  // ========================
  router.get('/api/approvals', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    const rows = db
      .prepare(`
        SELECT apr.*, a.name as agent_name
        FROM approval_requests apr
        LEFT JOIN agents a ON a.id = apr.agent_id
        WHERE apr.company_id = ?
        ORDER BY apr.created_at DESC
      `)
      .all(req.session!.company_id) as Array<Record<string, unknown>>;

    const enriched = rows.map((r) => {
      const decisions = db
        .prepare('SELECT * FROM approval_decisions WHERE approval_request_id = ? AND company_id = ? ORDER BY created_at DESC')
        .all(String(r.id), req.session!.company_id);
      return { ...r, is_demo: Boolean(r.is_demo), decision_history: decisions };
    });
    res.json({ approvals: enriched });
  });

  router.post(
    '/api/approvals/:id/decide',
    resolveSessionFromRequest,
    requireCapability('approve_requests'),
    (req: AuthedRequest, res: Response) => {
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

      const approval = db
        .prepare('SELECT * FROM approval_requests WHERE id = ? AND company_id = ?')
        .get(req.params.id, companyId) as Record<string, unknown> | undefined;
      if (!approval) {
        res.status(404).json({ error: 'Pedido de aprovação não encontrado.' });
        return;
      }
      if (approval.status !== 'Pendente') {
        res.status(409).json({ error: `Este pedido já se encontra no estado "${approval.status}".` });
        return;
      }

      // Nunca permitir aprovação humana de ações de restrição absoluta
      if (['bank_details_update', 'change_bank_details', 'modify_own_policy', 'sign_contract'].includes(String(approval.requested_action))) {
        res.status(403).json({
          error: 'Restrição absoluta de segurança: uma aprovação humana não pode anular esta proibição.',
        });
        return;
      }

      const now = new Date().toISOString();
      const nextStatus =
        decision === 'Aprovado'
          ? 'Aprovado'
          : decision === 'Rejeitado'
          ? 'Rejeitado'
          : 'Pendente';

      db.transaction(() => {
        db.prepare(`
          UPDATE approval_requests
          SET status = ?, info_requested_note = ?, updated_at = ?
          WHERE id = ? AND company_id = ?
        `).run(
          nextStatus,
          decision === 'Informacao_Solicitada' ? justification : approval.info_requested_note ?? null,
          now,
          req.params.id,
          companyId
        );

        db.prepare(`
          INSERT INTO approval_decisions (
            id, company_id, approval_request_id, approver_id, approver_name,
            decision, justification, policy_applied, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(),
          companyId,
          req.params.id,
          req.session!.user_id,
          req.session!.full_name,
          decision,
          justification,
          String(approval.policy_name),
          now
        );

        writeAuditLog({
          companyId,
          actorType: 'user',
          actorId: req.session!.user_id,
          actorName: req.session!.full_name,
          eventType: decision === 'Aprovado' ? 'approval' : decision === 'Rejeitado' ? 'rejection' : 'info_requested',
          action: `${decision}: ${approval.description}`,
          result: nextStatus,
          reason: `${justification} (Registo de autorização apenas — nenhuma operação financeira automática foi executada.)`,
          relatedPolicy: String(approval.policy_name),
        });
      })();

      res.json({
        status: nextStatus,
        note: 'Decisão registada em auditoria. Nenhuma transação financeira real foi executada automaticamente.',
      });
    }
  );

  // ========================
  // 8. FLUXOS DE TRABALHO (WORKFLOW BUILDER)
  // ========================
  router.get('/api/workflows', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    const companyId = req.session!.company_id;
    const wfs = db
      .prepare('SELECT * FROM workflows WHERE company_id = ? ORDER BY created_at DESC')
      .all(companyId) as Array<Record<string, unknown>>;
    const hydrated = wfs.map((w) => {
      const nodes = (
        db.prepare('SELECT * FROM workflow_nodes WHERE workflow_id = ? AND company_id = ? ORDER BY position_x ASC').all(String(w.id), companyId) as Array<Record<string, unknown>>
      ).map((n) => ({ ...n, config: JSON.parse(String(n.config || '{}')) }));
      const edges = db
        .prepare('SELECT * FROM workflow_edges WHERE workflow_id = ? AND company_id = ?')
        .all(String(w.id), companyId);
      return { ...w, is_demo: Boolean(w.is_demo), nodes, edges };
    });

    const executions = (
      db
        .prepare(`
          SELECT we.*, wf.name as workflow_name
          FROM workflow_executions we
          INNER JOIN workflows wf ON wf.id = we.workflow_id
          WHERE we.company_id = ?
          ORDER BY we.created_at DESC
          LIMIT 25
        `)
        .all(companyId) as Array<Record<string, unknown>>
    ).map((ex) => ({ ...ex, steps_log: JSON.parse(String(ex.steps_log || '[]')) }));

    res.json({ workflows: hydrated, executions });
  });

  router.post(
    '/api/workflows',
    resolveSessionFromRequest,
    requireCapability('manage_workflows'),
    (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
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

      const wfId = crypto.randomUUID();
      const now = new Date().toISOString();
      const idMap = new Map<string, string>();

      db.transaction(() => {
        db.prepare(`
          INSERT INTO workflows (id, company_id, name, description, status, is_demo, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        `).run(wfId, companyId, name, description || 'Fluxo sequencial governado', status, now, now);

        const insNode = db.prepare(`
          INSERT INTO workflow_nodes (id, company_id, workflow_id, node_type, label, agent_id, config, position_x, position_y, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          const realId = crypto.randomUUID();
          idMap.set(String(n.id || i), realId);
          insNode.run(
            realId,
            companyId,
            wfId,
            String(n.node_type || 'agent_task'),
            sanitizeTextInput(String(n.label || `Passo ${i + 1}`), 120),
            n.agent_id || null,
            JSON.stringify(n.config || {}),
            Number(n.position_x ?? i * 220 + 40),
            Number(n.position_y ?? 140),
            now
          );
        }

        const insEdge = db.prepare(`
          INSERT INTO workflow_edges (id, company_id, workflow_id, source_node_id, target_node_id, condition_label, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const e of edges) {
          const src = idMap.get(String(e.source_node_id));
          const dst = idMap.get(String(e.target_node_id));
          if (src && dst) {
            insEdge.run(crypto.randomUUID(), companyId, wfId, src, dst, e.condition_label || null, now);
          }
        }

        writeAuditLog({
          companyId,
          actorType: 'user',
          actorId: req.session!.user_id,
          actorName: req.session!.full_name,
          eventType: 'workflow_created',
          action: `Criação do fluxo "${name}"`,
          result: status,
          reason: `Fluxo guardado com ${nodes.length} nós.`,
        });
      })();

      res.status(201).json({ id: wfId });
    }
  );

  router.patch(
    '/api/workflows/:id/status',
    resolveSessionFromRequest,
    requireCapability('manage_workflows'),
    (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
      const status = String(req.body?.status || '');
      if (!['draft', 'active', 'suspended'].includes(status)) {
        res.status(400).json({ error: 'Estado inválido.' });
        return;
      }
      db.prepare('UPDATE workflows SET status = ?, updated_at = ? WHERE id = ? AND company_id = ?').run(
        status,
        new Date().toISOString(),
        req.params.id,
        companyId
      );
      res.json({ status });
    }
  );

  router.post(
    '/api/workflows/:id/execute',
    resolveSessionFromRequest,
    requireCapability('manage_workflows'),
    (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
      const wf = db
        .prepare('SELECT * FROM workflows WHERE id = ? AND company_id = ?')
        .get(req.params.id, companyId) as Record<string, unknown> | undefined;
      if (!wf) {
        res.status(404).json({ error: 'Fluxo não encontrado.' });
        return;
      }
      if (wf.status !== 'active') {
        res.status(400).json({ error: 'Apenas fluxos no estado "active" podem ser executados.' });
        return;
      }

      const nodes = (
        db
          .prepare('SELECT * FROM workflow_nodes WHERE workflow_id = ? AND company_id = ? ORDER BY position_x ASC')
          .all(req.params.id, companyId) as Array<Record<string, unknown>>
      ).map((n) => ({
        id: String(n.id),
        node_type: String(n.node_type),
        label: String(n.label),
        agent_id: n.agent_id ? String(n.agent_id) : null,
        config: JSON.parse(String(n.config || '{}')) as {
          action_type?: string;
          amount?: number;
          description?: string;
        },
      }));

      const policies = (
        db.prepare('SELECT * FROM policies WHERE company_id = ?').all(companyId) as Array<Record<string, unknown>>
      ).map(hydratePolicyRow);

      const overrideAmount = req.body?.amount !== undefined && req.body?.amount !== '' ? Number(req.body.amount) : null;
      const inputSummary = sanitizeTextInput(
        String(req.body?.input_summary || 'Execução manual de fluxo operacional'),
        240
      );
      const now = new Date().toISOString();

      const stepsLog: Array<{
        node_id: string;
        label: string;
        node_type: string;
        status: string;
        decision?: string;
        detail: string;
        timestamp: string;
      }> = [];

      let finalStatus: 'completed' | 'awaiting_approval' | 'blocked' = 'completed';

      for (const node of nodes) {
        const nodeType = String(node.node_type);
        const cfg = node.config as { action_type?: string; amount?: number; description?: string };

        if (nodeType === 'agent_task' && node.agent_id) {
          const agRow = db
            .prepare('SELECT * FROM agents WHERE id = ? AND company_id = ?')
            .get(String(node.agent_id), companyId) as Record<string, unknown> | undefined;

          if (!agRow) {
            finalStatus = 'blocked';
            stepsLog.push({
              node_id: String(node.id),
              label: String(node.label),
              node_type: nodeType,
              status: 'blocked',
              decision: 'BLOCKED',
              detail: 'Agente associado não encontrado ou pertencente a outro tenant.',
              timestamp: now,
            });
            break;
          }

          const agent = hydrateAgentRow(agRow);
          const evalAmount = overrideAmount !== null ? overrideAmount : cfg.amount ?? null;
          const actionType = cfg.action_type || 'read_info';
          const evalRes = evaluateAuthorization({
            agent,
            agentTools: agent.tools || [],
            policies,
            request: {
              action_type: actionType,
              description: cfg.description || `${wf.name}: ${node.label}`,
              amount: evalAmount,
              currency: 'EUR',
            },
          });

          const authId = crypto.randomUUID();
          db.prepare(`
            INSERT INTO authorization_requests (
              id, company_id, agent_id, action_type, tool_name, description,
              amount, currency, idempotency_key, decision, reason, policy_id,
              is_simulation, is_demo, created_at
            ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'EUR', ?, ?, ?, ?, 0, 0, ?)
          `).run(
            authId,
            companyId,
            agent.id,
            actionType,
            cfg.description || String(node.label),
            evalAmount,
            `wf_${authId}`,
            evalRes.decision,
            evalRes.reason,
            evalRes.matchedPolicy?.id ?? null,
            now
          );

          if (evalRes.decision === 'BLOCKED') {
            finalStatus = 'blocked';
            stepsLog.push({
              node_id: String(node.id),
              label: String(node.label),
              node_type: nodeType,
              status: 'blocked',
              decision: 'BLOCKED',
              detail: evalRes.reason,
              timestamp: now,
            });
            break;
          } else if (evalRes.decision === 'REQUIRES_APPROVAL') {
            finalStatus = 'awaiting_approval';
            db.prepare(`
              INSERT INTO approval_requests (
                id, company_id, authorization_request_id, agent_id, requested_action,
                description, financial_value, currency, policy_name, risk_level,
                status, is_demo, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, 'Pendente', 0, ?, ?)
            `).run(
              crypto.randomUUID(),
              companyId,
              authId,
              agent.id,
              actionType,
              `${wf.name} — ${cfg.description || node.label}`,
              evalAmount,
              evalRes.matchedPolicy?.name || 'Política de Fluxo',
              evalRes.riskLevel,
              now,
              now
            );

            stepsLog.push({
              node_id: String(node.id),
              label: String(node.label),
              node_type: nodeType,
              status: 'awaiting_approval',
              decision: 'REQUIRES_APPROVAL',
              detail: evalRes.reason,
              timestamp: now,
            });
            break;
          } else {
            stepsLog.push({
              node_id: String(node.id),
              label: String(node.label),
              node_type: nodeType,
              status: 'completed',
              decision: 'ALLOWED',
              detail: evalRes.reason,
              timestamp: now,
            });
          }
        } else if (nodeType === 'human_approval') {
          finalStatus = 'awaiting_approval';
          stepsLog.push({
            node_id: String(node.id),
            label: String(node.label),
            node_type: nodeType,
            status: 'awaiting_approval',
            detail: 'Fluxo em espera de validação humana.',
            timestamp: now,
          });
          break;
        } else {
          stepsLog.push({
            node_id: String(node.id),
            label: String(node.label),
            node_type: nodeType,
            status: 'completed',
            detail: 'Nó processado.',
            timestamp: now,
          });
        }
      }

      const execId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO workflow_executions (id, company_id, workflow_id, status, input_summary, steps_log, triggered_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(execId, companyId, req.params.id, finalStatus, inputSummary, JSON.stringify(stepsLog), req.session!.user_id, now);

      writeAuditLog({
        companyId,
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: 'workflow_execution',
        action: `Execução do fluxo "${wf.name}"`,
        result: finalStatus,
        reason: inputSummary,
      });

      res.json({ execution_id: execId, status: finalStatus, steps_log: stepsLog });
    }
  );

  // ========================
  // 9. INTEGRAÇÕES
  // ========================
  router.get('/api/integrations', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    const rows = db
      .prepare('SELECT * FROM integrations WHERE company_id = ? ORDER BY category ASC, name ASC')
      .all(req.session!.company_id) as Array<Record<string, unknown>>;

    const aiStatusMap = new Map<string, ReturnType<typeof getAIProvidersStatus>[number]>(
      getAIProvidersStatus().map((p) => [p.provider_key, p])
    );
    const integrations = rows.map((r) => {
      const key = String(r.provider_key);
      const aiInfo = aiStatusMap.get(key);
      return {
        id: String(r.id),
        company_id: String(r.company_id),
        provider_key: key,
        name: String(r.name),
        category: r.category,
        description: String(r.description),
        status: aiInfo ? (aiInfo.configured ? 'configured' : 'not_configured') : r.status,
        required_credentials: JSON.parse(String(r.required_credentials || '[]')),
        capabilities: JSON.parse(String(r.capabilities || '[]')),
        documentation_summary: String(r.documentation_summary),
        models: aiInfo?.models,
      };
    });
    res.json({ integrations });
  });

  // ========================
  // 10. HISTÓRICO E AUDITORIA (APPEND-ONLY)
  // ========================
  router.get('/api/audit-logs', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    const companyId = req.session!.company_id;
    const search = String(req.query.search || '').trim().toLowerCase();
    const eventType = String(req.query.event_type || '').trim();
    const actor = String(req.query.actor || '').trim().toLowerCase();
    const fromDate = String(req.query.from || '').trim();
    const toDate = String(req.query.to || '').trim();

    let rows = db
      .prepare('SELECT * FROM audit_logs WHERE company_id = ? ORDER BY created_at DESC LIMIT 300')
      .all(companyId) as Array<Record<string, unknown>>;

    rows = rows.filter((r) => {
      if (eventType && String(r.event_type) !== eventType) return false;
      if (actor && !String(r.actor_name).toLowerCase().includes(actor)) return false;
      if (fromDate && String(r.created_at).slice(0, 10) < fromDate) return false;
      if (toDate && String(r.created_at).slice(0, 10) > toDate) return false;
      if (search) {
        const hay = `${r.actor_name} ${r.action} ${r.reason} ${r.result} ${r.related_policy || ''}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    res.json({ logs: rows.map((r) => ({ ...r, is_demo: Boolean(r.is_demo) })) });
  });

  router.get(
    '/api/audit-logs/export.csv',
    resolveSessionFromRequest,
    requireCapability('export_audit'),
    (req: AuthedRequest, res: Response) => {
      const rows = db
        .prepare('SELECT * FROM audit_logs WHERE company_id = ? ORDER BY created_at DESC')
        .all(req.session!.company_id) as Array<Record<string, unknown>>;

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
    }
  );

  // ========================
  // 11. UTILIZADORES & DEFINIÇÕES
  // ========================
  router.get('/api/users', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    const rows = db
      .prepare(`
        SELECT cm.id, cm.company_id, cm.user_id, cm.role, cm.status, cm.created_at,
               p.email, p.full_name, p.job_title
        FROM company_members cm
        INNER JOIN profiles p ON p.id = cm.user_id
        WHERE cm.company_id = ?
        ORDER BY cm.created_at ASC
      `)
      .all(req.session!.company_id);
    res.json({ members: rows });
  });

  router.post(
    '/api/users',
    resolveSessionFromRequest,
    requireCapability('manage_users'),
    (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
      const limits = SUBSCRIPTION_LIMITS[req.session!.subscription_plan];
      const currentUsers = (
        db.prepare('SELECT COUNT(*) as c FROM company_members WHERE company_id = ?').get(companyId) as { c: number }
      ).c;
      if (currentUsers >= limits.maxUsers) {
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

      const now = new Date().toISOString();
      let profile = db.prepare('SELECT id FROM profiles WHERE lower(email) = ?').get(email) as { id: string } | undefined;
      if (!profile) {
        const uid = crypto.randomUUID();
        db.prepare(`
          INSERT INTO profiles (id, email, password_hash, full_name, job_title, avatar_initials, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(uid, email, hashPassword(tempPassword), fullName, jobTitle, fullName.slice(0, 2).toUpperCase(), now, now);
        profile = { id: uid };
      }

      const existsMember = db
        .prepare('SELECT id FROM company_members WHERE company_id = ? AND user_id = ?')
        .get(companyId, profile.id);
      if (existsMember) {
        res.status(409).json({ error: 'Este utilizador já pertence à empresa.' });
        return;
      }

      db.prepare(`
        INSERT INTO company_members (id, company_id, user_id, role, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
      `).run(crypto.randomUUID(), companyId, profile.id, role, now, now);

      writeAuditLog({
        companyId,
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: 'user_permission_changed',
        action: `Adição de utilizador ${fullName} (${email}) com perfil ${role}`,
        result: 'Sucesso',
        reason: 'Atribuição inicial de papel RBAC.',
      });

      res.status(201).json({ status: 'created' });
    }
  );

  router.patch(
    '/api/users/:memberId/role',
    resolveSessionFromRequest,
    requireCapability('manage_users'),
    (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
      const role = String(req.body?.role || '');
      if (!['OWNER', 'ADMIN', 'APPROVER', 'OPERATOR', 'VIEWER'].includes(role)) {
        res.status(400).json({ error: 'Perfil RBAC inválido.' });
        return;
      }

      const member = db
        .prepare(`
          SELECT cm.*, p.full_name FROM company_members cm
          INNER JOIN profiles p ON p.id = cm.user_id
          WHERE cm.id = ? AND cm.company_id = ?
        `)
        .get(req.params.memberId, companyId) as Record<string, unknown> | undefined;
      if (!member) {
        res.status(404).json({ error: 'Membro não encontrado.' });
        return;
      }

      db.prepare('UPDATE company_members SET role = ?, updated_at = ? WHERE id = ? AND company_id = ?').run(
        role,
        new Date().toISOString(),
        req.params.memberId,
        companyId
      );

      writeAuditLog({
        companyId,
        actorType: 'user',
        actorId: req.session!.user_id,
        actorName: req.session!.full_name,
        eventType: 'user_permission_changed',
        action: `Alteração do perfil de ${member.full_name} para ${role}`,
        result: 'Sucesso',
        reason: 'Atualização de permissões RBAC pela direção.',
      });

      res.json({ role });
    }
  );

  router.get('/api/company', resolveSessionFromRequest, (req: AuthedRequest, res: Response) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.session!.company_id);
    res.json({ company, plans: SUBSCRIPTION_LIMITS });
  });

  router.patch(
    '/api/company',
    resolveSessionFromRequest,
    requireCapability('manage_settings'),
    (req: AuthedRequest, res: Response) => {
      const companyId = req.session!.company_id;
      const name = sanitizeTextInput(String(req.body?.name || ''), 120);
      const sector = sanitizeTextInput(String(req.body?.sector || ''), 120);
      const nif = sanitizeTextInput(String(req.body?.nif || ''), 30);
      const plan = String(req.body?.subscription_plan || '') as SubscriptionPlan;

      const updates: string[] = [];
      const params: unknown[] = [];

      if (name) {
        updates.push('name = ?');
        params.push(name);
      }
      if (sector) {
        updates.push('sector = ?');
        params.push(sector);
      }
      if (nif) {
        updates.push('nif = ?');
        params.push(nif);
      }
      if (['STARTER', 'PROFESSIONAL', 'BUSINESS'].includes(plan)) {
        updates.push('subscription_plan = ?');
        params.push(plan);
        updates.push('retention_days = ?');
        params.push(SUBSCRIPTION_LIMITS[plan].retentionDays);
      }

      if (updates.length > 0) {
        updates.push('updated_at = ?');
        params.push(new Date().toISOString());
        params.push(companyId);
        db.prepare(`UPDATE companies SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }

      const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
      res.json({ company: updated });
    }
  );

  // ========================
  // 11B. BASE DE DADOS NO GOOGLE DRIVE DA EMPRESA
  // ========================
  router.get(
    '/api/company/drive/status',
    resolveSessionFromRequest,
    requireCapability('manage_settings'),
    async (req: AuthedRequest, res: Response) => {
      const googleToken = String(req.headers['x-google-access-token'] || '').trim();
      if (!googleToken) {
        res.status(401).json({ error: 'Token Google Drive em falta. Inicie sessão com a conta Google da empresa.' });
        return;
      }
      try {
        const account = await verifyGoogleDriveAccount(googleToken);
        const folderId = await findOrCreateMandatoFolder(googleToken);
        const files = await listMandatoDriveDatabaseFiles(googleToken, folderId);
        res.json({ account, folder_id: folderId, files });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Erro ao consultar Google Drive.' });
      }
    }
  );

  router.post(
    '/api/company/drive/sync',
    resolveSessionFromRequest,
    requireCapability('manage_settings'),
    async (req: AuthedRequest, res: Response) => {
      const googleToken = String(req.headers['x-google-access-token'] || '').trim();
      if (!googleToken) {
        res.status(401).json({ error: 'Token Google Drive em falta. Inicie sessão com a conta Google da empresa.' });
        return;
      }
      try {
        const account = await verifyGoogleDriveAccount(googleToken);
        const result = await syncCompanySnapshotToGoogleDrive(googleToken, req.session!.company_id);

        writeAuditLog({
          companyId: req.session!.company_id,
          actorType: 'user',
          actorId: req.session!.user_id,
          actorName: req.session!.full_name,
          eventType: 'google_drive_sync',
          action: `Sincronização da base de dados para Google Drive (${result.file.name})`,
          result: 'Sucesso',
          reason: `Operação ${result.operation} na conta ${account.email}.`,
        });

        res.json({ account, ...result });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Erro ao sincronizar com Google Drive.' });
      }
    }
  );

  router.post(
    '/api/company/drive/restore',
    resolveSessionFromRequest,
    requireCapability('manage_settings'),
    async (req: AuthedRequest, res: Response) => {
      const googleToken = String(req.headers['x-google-access-token'] || '').trim();
      const fileId = sanitizeTextInput(String(req.body?.file_id || ''), 200);
      if (!googleToken) {
        res.status(401).json({ error: 'Token Google Drive em falta. Inicie sessão com a conta Google da empresa.' });
        return;
      }
      if (!fileId) {
        res.status(400).json({ error: 'Indique o identificador do ficheiro na Google Drive.' });
        return;
      }
      try {
        const account = await verifyGoogleDriveAccount(googleToken);
        const restored = await restoreCompanySnapshotFromGoogleDrive(
          googleToken,
          req.session!.company_id,
          fileId
        );

        writeAuditLog({
          companyId: req.session!.company_id,
          actorType: 'user',
          actorId: req.session!.user_id,
          actorName: req.session!.full_name,
          eventType: 'google_drive_restore',
          action: `Restauro da base de dados a partir da Google Drive (ficheiro ${fileId})`,
          result: 'Sucesso',
          reason: `Restaurados ${restored.restoredCounts.agents} agentes e ${restored.restoredCounts.policies} políticas via ${account.email}.`,
        });

        res.json({ account, ...restored });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Erro ao restaurar da Google Drive.' });
      }
    }
  );

  router.delete(
    '/api/company/drive/files/:fileId',
    resolveSessionFromRequest,
    requireCapability('manage_settings'),
    async (req: AuthedRequest, res: Response) => {
      const googleToken = String(req.headers['x-google-access-token'] || '').trim();
      const fileId = sanitizeTextInput(String(req.params.fileId || ''), 200);
      if (!googleToken) {
        res.status(401).json({ error: 'Token Google Drive em falta.' });
        return;
      }
      try {
        const account = await verifyGoogleDriveAccount(googleToken);
        await deleteDriveDatabaseFile(googleToken, fileId);

        writeAuditLog({
          companyId: req.session!.company_id,
          actorType: 'user',
          actorId: req.session!.user_id,
          actorName: req.session!.full_name,
          eventType: 'google_drive_delete',
          action: `Eliminação do ficheiro de base de dados na Google Drive (${fileId})`,
          result: 'Sucesso',
          reason: `Eliminado manualmente por ${account.email}.`,
        });

        res.json({ deleted: true });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Erro ao eliminar ficheiro da Google Drive.' });
      }
    }
  );

  // ========================
  // 12. API GATEWAY CENTRAL DE AUTORIZAÇÃO — POST /api/v1/authorize
  // ========================
  router.post('/api/v1/authorize', (req: Request, res: Response) => {
    // 1. Autenticar agente por credencial Bearer / X-Agent-Key (armazenada apenas como hash SHA-256)
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
    const credRow = db
      .prepare('SELECT * FROM agent_credentials WHERE key_hash = ?')
      .get(hashed) as Record<string, unknown> | undefined;

    if (!credRow || credRow.status !== 'active') {
      res.status(401).json({ error: 'Credencial de agente inválida, revogada ou suspensa.' });
      return;
    }

    // 2. Derivar empresa EXCLUSIVAMENTE da identidade autenticada (nunca confiar em company_id do payload!)
    const resolvedCompanyId = String(credRow.company_id);
    const resolvedAgentId = String(credRow.agent_id);

    // 3. Rate limiting por agente
    const rate = gatewayRateLimiter.check(resolvedAgentId);
    if (!rate.allowed) {
      res.status(429).json({
        error: 'Limite de pedidos por minuto excedido para este agente.',
        retry_after_seconds: rate.retryAfterSeconds,
      });
      return;
    }

    // 4. Validar payload
    const actionType = sanitizeTextInput(String(req.body?.action_type || ''), 80);
    const description = sanitizeTextInput(String(req.body?.description || ''), 500);
    const amount = req.body?.amount !== undefined && req.body?.amount !== null ? Number(req.body.amount) : null;
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

    // 5. Idempotência (proteção contra replay / pedidos repetidos)
    if (idempotencyKey) {
      const existingReq = db
        .prepare('SELECT * FROM authorization_requests WHERE company_id = ? AND idempotency_key = ?')
        .get(resolvedCompanyId, idempotencyKey) as Record<string, unknown> | undefined;

      if (existingReq) {
        if (existingReq.decision === 'ALLOWED') {
          res.json({ decision: 'ALLOWED', authorization_id: existingReq.id, idempotent_replay: true });
          return;
        }
        if (existingReq.decision === 'REQUIRES_APPROVAL') {
          const apr = db
            .prepare('SELECT id FROM approval_requests WHERE authorization_request_id = ?')
            .get(String(existingReq.id)) as { id: string } | undefined;
          res.json({
            decision: 'REQUIRES_APPROVAL',
            approval_request_id: apr?.id ?? null,
            idempotent_replay: true,
          });
          return;
        }
        res.status(403).json({
          decision: 'BLOCKED',
          reason: existingReq.reason,
          idempotent_replay: true,
        });
        return;
      }
    }

    // 6. Recuperar agente e políticas da empresa resolvida
    const agRow = db
      .prepare('SELECT * FROM agents WHERE id = ? AND company_id = ?')
      .get(resolvedAgentId, resolvedCompanyId) as Record<string, unknown> | undefined;
    if (!agRow) {
      res.status(404).json({ error: 'Agente não encontrado.' });
      return;
    }

    const agent = hydrateAgentRow(agRow);
    const policies = (
      db.prepare('SELECT * FROM policies WHERE company_id = ?').all(resolvedCompanyId) as Array<Record<string, unknown>>
    ).map(hydratePolicyRow);

    // 7. Avaliar decisão no motor MANDATO
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

    const now = new Date().toISOString();
    const authId = crypto.randomUUID();
    let approvalId: string | null = null;

    db.transaction(() => {
      db.prepare('UPDATE agent_credentials SET last_used_at = ? WHERE id = ?').run(now, String(credRow.id));
      db.prepare('UPDATE agents SET actions_count = actions_count + 1, last_activity_at = ? WHERE id = ?').run(
        now,
        resolvedAgentId
      );

      db.prepare(`
        INSERT INTO authorization_requests (
          id, company_id, agent_id, action_type, tool_name, description,
          amount, currency, resource_id, idempotency_key, decision, reason,
          policy_id, is_simulation, is_demo, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
      `).run(
        authId,
        resolvedCompanyId,
        resolvedAgentId,
        actionType,
        toolName,
        description,
        amount,
        currency,
        resourceId,
        idempotencyKey,
        evalResult.decision,
        evalResult.reason,
        evalResult.matchedPolicy?.id ?? null,
        now
      );

      if (evalResult.decision === 'REQUIRES_APPROVAL') {
        approvalId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO approval_requests (
            id, company_id, authorization_request_id, agent_id, requested_action,
            description, financial_value, currency, policy_name, risk_level,
            status, is_demo, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pendente', 0, ?, ?)
        `).run(
          approvalId,
          resolvedCompanyId,
          authId,
          resolvedAgentId,
          actionType,
          description,
          amount,
          currency,
          evalResult.matchedPolicy?.name || 'Política Empresarial',
          evalResult.riskLevel,
          now,
          now
        );
      }

      writeAuditLog({
        companyId: resolvedCompanyId,
        actorType: 'agent',
        actorId: resolvedAgentId,
        actorName: agent.name,
        eventType: evalResult.decision === 'BLOCKED' ? 'blocked_action' : 'authorization_decision',
        action: `API Gateway: ${actionType} (${description})`,
        result: evalResult.decision,
        reason: evalResult.reason,
        relatedPolicy: evalResult.matchedPolicy?.name ?? null,
      });
    })();

    if (evalResult.decision === 'ALLOWED') {
      res.json({ decision: 'ALLOWED', authorization_id: authId });
      return;
    }
    if (evalResult.decision === 'REQUIRES_APPROVAL') {
      res.json({ decision: 'REQUIRES_APPROVAL', approval_request_id: approvalId });
      return;
    }
    res.status(403).json({
      decision: 'BLOCKED',
      reason: evalResult.reason,
    });
  });

  return router;
}
