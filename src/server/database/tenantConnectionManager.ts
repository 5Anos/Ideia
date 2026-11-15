import crypto from 'node:crypto';
import type { SheetsConnectionStatus, TenantSheetsConfig } from '../../shared/types.ts';
import {
  ALL_WORKSHEET_NAMES,
  deserializeRowArray,
  type SchemaValidationReport,
  type WorksheetName,
} from './sheetSchema.ts';
import {
  batchGetRanges,
  createCompanySpreadsheet,
  ensureSpreadsheetSchema,
  exchangeGoogleOAuthCode,
  getSpreadsheetMetadata,
  GoogleSheetsError,
  listUserSpreadsheets,
  refreshGoogleOAuthToken,
  revokeGoogleOAuthToken,
  type SpreadsheetListItem,
  type SpreadsheetMetadata,
  validateSpreadsheetSchema,
  verifyGoogleTokenIdentity,
} from './googleSheetsProvider.ts';
import {
  deleteTenantOAuthSecret,
  getTenantOAuthSecret,
  storeTenantOAuthSecret,
  type StoredOAuthSecret,
} from './secretManager.ts';
import {
  appendPlatformAuditLog,
  consumeOAuthPkceState,
  findTenantBySpreadsheetId,
  getTenantById,
  saveOAuthPkceState,
  type TenantRegistryRecord,
  updateTenantRecord,
} from './tenantRegistry.ts';

export class TenantDatabaseNotConnectedError extends Error {
  readonly code = 'DATABASE_NOT_CONNECTED';
  readonly status: SheetsConnectionStatus;

  constructor(status: SheetsConnectionStatus, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SheetRowEntry {
  rowNumber: number; // 1-based row number in Google Sheet (data starts at 2)
  data: Record<string, string>;
}

interface TenantCacheEntry {
  loadedAt: number;
  metadata: SpreadsheetMetadata;
  tables: Map<WorksheetName, SheetRowEntry[]>;
}

const CACHE_TTL_MS = 10_000;
const tenantLocks = new Map<string, Promise<void>>();
const tenantCaches = new Map<string, TenantCacheEntry>();

export function invalidateTenantCache(companyId: string): void {
  tenantCaches.delete(companyId);
}

export function clearAllTenantCachesForTests(): void {
  tenantCaches.clear();
}

export async function withTenantWriteLock<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tenantLocks.get(companyId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => current);
  tenantLocks.set(companyId, chained);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tenantLocks.get(companyId) === chained) {
      tenantLocks.delete(companyId);
    }
  }
}

export const REQUIRED_SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'openid',
  'email',
  'profile',
];

export function isOAuthCodeFlowConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() &&
      process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim()
  );
}

export function generatePkceChallenge(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

export function startCompanyGoogleOAuthFlow(params: {
  companyId: string;
  userId: string;
  enteredGoogleEmail?: string;
}): { mode: 'authorization_code_pkce' | 'workspace_popup_bridge'; authUrl?: string; state: string } {
  const tenant = getTenantById(params.companyId);
  if (!tenant) {
    throw new Error('Empresa não encontrada.');
  }
  const enteredEmail = (params.enteredGoogleEmail ?? tenant.entered_google_email ?? '').trim().toLowerCase();
  const state = crypto.randomBytes(24).toString('base64url');
  const { codeVerifier, codeChallenge } = generatePkceChallenge();

  saveOAuthPkceState({
    state,
    company_id: params.companyId,
    user_id: params.userId,
    entered_google_email: enteredEmail,
    code_verifier: codeVerifier,
    expires_at: Date.now() + 10 * 60_000,
    used: false,
  });

  updateTenantRecord(params.companyId, {
    entered_google_email: enteredEmail,
    connection_status: tenant.spreadsheet_id && tenant.connection_status === 'Ligado'
      ? tenant.connection_status
      : 'A aguardar autorização',
    last_error: null,
  });

  if (isOAuthCodeFlowConfigured()) {
    const query = new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!.trim(),
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI!.trim(),
      response_type: 'code',
      scope: REQUIRED_SHEETS_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    if (enteredEmail) {
      query.set('login_hint', enteredEmail);
    }
    return {
      mode: 'authorization_code_pkce',
      authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`,
      state,
    };
  }

  return {
    mode: 'workspace_popup_bridge',
    state,
  };
}

export async function completeOAuthCodeCallback(params: {
  state: string;
  code?: string;
  error?: string;
}): Promise<{ companyId: string; verifiedEmail: string; emailMismatchWarning: boolean }> {
  if (params.error) {
    const st = consumeOAuthPkceState(params.state);
    if (st) {
      updateTenantRecord(st.company_id, {
        connection_status: 'Erro de autenticação',
        last_error: `Autorização Google cancelada ou recusada: ${params.error}`,
      });
    }
    throw new Error('Autorização Google cancelada pelo utilizador.');
  }

  const pkce = consumeOAuthPkceState(params.state);
  if (!pkce || !params.code) {
    throw new Error('Estado OAuth inválido, já utilizado ou expirado.');
  }
  if (!isOAuthCodeFlowConfigured()) {
    throw new Error('Credenciais GOOGLE_OAUTH_CLIENT_ID / CLIENT_SECRET não configuradas.');
  }

  const tokenData = await exchangeGoogleOAuthCode({
    code: params.code,
    codeVerifier: pkce.code_verifier,
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI!.trim(),
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID!.trim(),
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!.trim(),
  });

  return persistVerifiedTenantToken({
    companyId: pkce.company_id,
    actorUserId: pkce.user_id,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || null,
    expiresInSeconds: tokenData.expires_in || 3600,
    scope: tokenData.scope || REQUIRED_SHEETS_SCOPES.join(' '),
    oauthMode: 'authorization_code_pkce',
    enteredEmailOverride: pkce.entered_google_email,
  });
}

export async function completeOAuthBridgeLogin(params: {
  companyId: string;
  actorUserId: string;
  state: string;
  accessToken: string;
  enteredGoogleEmail?: string;
}): Promise<{ companyId: string; verifiedEmail: string; emailMismatchWarning: boolean }> {
  const pkce = consumeOAuthPkceState(params.state);
  if (!pkce || pkce.company_id !== params.companyId) {
    throw new Error('Estado de segurança OAuth inválido ou expirado. Tente ligar novamente.');
  }

  return persistVerifiedTenantToken({
    companyId: params.companyId,
    actorUserId: params.actorUserId,
    accessToken: params.accessToken,
    refreshToken: null,
    expiresInSeconds: 3500,
    scope: REQUIRED_SHEETS_SCOPES.join(' '),
    oauthMode: 'workspace_popup_bridge',
    enteredEmailOverride: params.enteredGoogleEmail ?? pkce.entered_google_email,
  });
}

async function persistVerifiedTenantToken(params: {
  companyId: string;
  actorUserId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
  oauthMode: 'authorization_code_pkce' | 'workspace_popup_bridge';
  enteredEmailOverride?: string;
}): Promise<{ companyId: string; verifiedEmail: string; emailMismatchWarning: boolean }> {
  const tenant = getTenantById(params.companyId);
  if (!tenant) throw new Error('Empresa não encontrada.');

  const identity = await verifyGoogleTokenIdentity(params.accessToken);
  const existingSecret = getTenantOAuthSecret(tenant.secret_reference);
  const secretRef = storeTenantOAuthSecret(params.companyId, {
    access_token: params.accessToken,
    refresh_token: params.refreshToken ?? existingSecret?.refresh_token ?? null,
    expires_at: Date.now() + Math.max(60, params.expiresInSeconds - 60) * 1000,
    scope: params.scope,
    verified_google_email: identity.email,
    token_type: 'Bearer',
    oauth_mode: params.oauthMode,
    updated_at: new Date().toISOString(),
  });

  const enteredEmail = (params.enteredEmailOverride ?? tenant.entered_google_email ?? '').trim().toLowerCase();
  const mismatch = Boolean(enteredEmail && enteredEmail !== identity.email);

  updateTenantRecord(params.companyId, {
    verified_google_email: identity.email,
    entered_google_email: enteredEmail || identity.email,
    email_mismatch_confirmed: !mismatch,
    secret_reference: secretRef,
    oauth_mode: params.oauthMode,
    connection_status: tenant.spreadsheet_id && tenant.schema_valid ? 'Ligado' : 'A aguardar autorização',
    last_error: null,
  });

  appendPlatformAuditLog({
    actorUserId: params.actorUserId,
    actorEmail: identity.email,
    companyId: params.companyId,
    eventType: 'google_oauth_connected',
    detail: mismatch
      ? `Conta Google ligada (${identity.email}) diferente do email indicado (${enteredEmail}).`
      : `Conta Google verificada e ligada (${identity.email}).`,
  });

  return {
    companyId: params.companyId,
    verifiedEmail: identity.email,
    emailMismatchWarning: mismatch,
  };
}

export async function getValidTenantAccessToken(companyId: string): Promise<{
  tenant: TenantRegistryRecord;
  accessToken: string;
}> {
  const tenant = getTenantById(companyId);
  if (!tenant) {
    throw new TenantDatabaseNotConnectedError('Não configurado', 'Empresa não encontrada.');
  }
  const secret = getTenantOAuthSecret(tenant.secret_reference);
  if (!secret || !secret.access_token) {
    throw new TenantDatabaseNotConnectedError(
      tenant.connection_status,
      'A conta Google da empresa não está ligada. Aceda a Definições -> Base de Dados (Google Sheets).'
    );
  }

  // Verificar expiração
  if (Date.now() < secret.expires_at) {
    return { tenant, accessToken: secret.access_token };
  }

  // Tentar renovação automática se houver refresh_token
  if (secret.refresh_token && isOAuthCodeFlowConfigured()) {
    try {
      const refreshed = await refreshGoogleOAuthToken({
        refreshToken: secret.refresh_token,
        clientId: process.env.GOOGLE_OAUTH_CLIENT_ID!.trim(),
        clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!.trim(),
      });
      const updatedSecret: StoredOAuthSecret = {
        ...secret,
        access_token: refreshed.access_token,
        expires_at: Date.now() + Math.max(60, (refreshed.expires_in || 3600) - 60) * 1000,
        scope: refreshed.scope || secret.scope,
        updated_at: new Date().toISOString(),
      };
      storeTenantOAuthSecret(companyId, updatedSecret);
      return { tenant, accessToken: updatedSecret.access_token };
    } catch (err) {
      updateTenantRecord(companyId, {
        connection_status: 'Ligação expirada',
        last_error: err instanceof Error ? err.message : 'Falha ao renovar token OAuth.',
      });
      throw new TenantDatabaseNotConnectedError(
        'Ligação expirada',
        'A ligação OAuth com a conta Google expirou. É necessário reconectar a conta nas Definições.'
      );
    }
  }

  updateTenantRecord(companyId, {
    connection_status: 'Ligação expirada',
    last_error: 'Sessão Google expirada sem token de renovação disponível.',
  });
  throw new TenantDatabaseNotConnectedError(
    'Ligação expirada',
    'A autorização Google da empresa expirou. Reconecte a conta Google em Definições.'
  );
}

export async function ensureConnectedOperationalSpreadsheet(companyId: string): Promise<{
  tenant: TenantRegistryRecord;
  accessToken: string;
}> {
  const { tenant, accessToken } = await getValidTenantAccessToken(companyId);
  if (!tenant.spreadsheet_id) {
    throw new TenantDatabaseNotConnectedError(
      'Não configurado',
      'Nenhuma folha de cálculo Google Sheets está selecionada para esta empresa.'
    );
  }
  if (tenant.connection_status !== 'Ligado' || !tenant.schema_valid) {
    throw new TenantDatabaseNotConnectedError(
      tenant.connection_status,
      `A base de dados Google Sheets da empresa não está operacional (estado: ${tenant.connection_status}).`
    );
  }
  return { tenant, accessToken };
}

export async function listAvailableSpreadsheetsForTenant(companyId: string): Promise<SpreadsheetListItem[]> {
  const { accessToken } = await getValidTenantAccessToken(companyId);
  return listUserSpreadsheets(accessToken);
}

export async function selectExistingSpreadsheetForTenant(params: {
  companyId: string;
  actorUserId: string;
  spreadsheetId: string;
  initializeIfMissing?: boolean;
}): Promise<{ tenant: TenantRegistryRecord; report: SchemaValidationReport }> {
  const { tenant, accessToken } = await getValidTenantAccessToken(params.companyId);

  // Garantir isolamento estrito: nenhuma folha já vinculada a outra empresa pode ser reutilizada
  const ownerOfSheet = findTenantBySpreadsheetId(params.spreadsheetId);
  if (ownerOfSheet && ownerOfSheet.company_id !== params.companyId) {
    throw new Error(
      'Violação de isolamento multi-empresa: esta folha de cálculo já está atribuída a outra organização.'
    );
  }

  try {
    let validation = params.initializeIfMissing
      ? await ensureSpreadsheetSchema(accessToken, params.spreadsheetId)
      : await validateSpreadsheetSchema(accessToken, params.spreadsheetId);

    const nextStatus: SheetsConnectionStatus = validation.report.valid ? 'Ligado' : 'Estrutura inválida';
    const now = new Date().toISOString();

    const updated = updateTenantRecord(params.companyId, {
      spreadsheet_id: validation.metadata.spreadsheetId,
      spreadsheet_name: validation.metadata.title,
      spreadsheet_url: validation.metadata.spreadsheetUrl,
      schema_valid: validation.report.valid,
      missing_worksheets: validation.report.missingWorksheets,
      connection_status: nextStatus,
      last_connection_test: now,
      last_error: validation.report.valid
        ? null
        : `Faltam ${validation.report.missingWorksheets.length} abas ou colunas obrigatórias.`,
    });

    invalidateTenantCache(params.companyId);
    appendPlatformAuditLog({
      actorUserId: params.actorUserId,
      actorEmail: tenant.verified_google_email,
      companyId: params.companyId,
      eventType: 'spreadsheet_selected',
      detail: `Folha "${validation.metadata.title}" (${validation.metadata.spreadsheetId}) associada. Estado: ${nextStatus}.`,
    });

    return { tenant: updated!, report: validation.report };
  } catch (err) {
    if (err instanceof GoogleSheetsError) {
      const status: SheetsConnectionStatus =
        err.code === 'AUTH_ERROR'
          ? 'Ligação expirada'
          : err.code === 'ACCESS_DENIED' || err.code === 'NOT_FOUND'
          ? 'Sem acesso à folha'
          : 'Erro de autenticação';
      updateTenantRecord(params.companyId, {
        connection_status: status,
        last_error: err.message,
      });
    }
    throw err;
  }
}

export async function createNewSpreadsheetForTenant(params: {
  companyId: string;
  actorUserId: string;
  customTitle?: string;
}): Promise<{ tenant: TenantRegistryRecord; metadata: SpreadsheetMetadata }> {
  const { tenant, accessToken } = await getValidTenantAccessToken(params.companyId);
  const title = params.customTitle?.trim() || `MANDATO — ${tenant.company_name}`;
  const metadata = await createCompanySpreadsheet(accessToken, title);
  const now = new Date().toISOString();

  const updated = updateTenantRecord(params.companyId, {
    spreadsheet_id: metadata.spreadsheetId,
    spreadsheet_name: metadata.title,
    spreadsheet_url: metadata.spreadsheetUrl,
    schema_valid: true,
    missing_worksheets: [],
    connection_status: 'Ligado',
    last_connection_test: now,
    last_successful_write: now,
    last_error: null,
  });

  invalidateTenantCache(params.companyId);
  appendPlatformAuditLog({
    actorUserId: params.actorUserId,
    actorEmail: tenant.verified_google_email,
    companyId: params.companyId,
    eventType: 'spreadsheet_created',
    detail: `Folha de cálculo dedicada criada (${metadata.spreadsheetId}).`,
  });

  return { tenant: updated!, metadata };
}

export async function testTenantSheetsConnection(companyId: string): Promise<{
  status: SheetsConnectionStatus;
  verifiedEmail: string;
  spreadsheetTitle: string;
  schemaReport: SchemaValidationReport | null;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
}> {
  const tenant = getTenantById(companyId);
  if (!tenant) throw new Error('Empresa não encontrada.');

  const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
  const now = new Date().toISOString();

  const secret = getTenantOAuthSecret(tenant.secret_reference);
  if (!secret) {
    updateTenantRecord(companyId, {
      connection_status: 'Não configurado',
      last_connection_test: now,
      last_error: 'Credenciais OAuth Google não ligadas.',
    });
    steps.push({ step: 'Credenciais OAuth', ok: false, detail: 'Conta Google ainda não autorizada.' });
    return {
      status: 'Não configurado',
      verifiedEmail: '',
      spreadsheetTitle: '',
      schemaReport: null,
      steps,
    };
  }
  steps.push({ step: 'Credenciais OAuth', ok: true, detail: 'Token cifrado presente no servidor.' });

  let accessToken = secret.access_token;
  try {
    const resolved = await getValidTenantAccessToken(companyId);
    accessToken = resolved.accessToken;
    steps.push({ step: 'Validade do Token', ok: true, detail: 'Token OAuth válido ou renovado automaticamente.' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Token expirado.';
    steps.push({ step: 'Validade do Token', ok: false, detail: msg });
    return {
      status: 'Ligação expirada',
      verifiedEmail: tenant.verified_google_email,
      spreadsheetTitle: tenant.spreadsheet_name,
      schemaReport: null,
      steps,
    };
  }

  let verifiedEmail = tenant.verified_google_email;
  try {
    const identity = await verifyGoogleTokenIdentity(accessToken);
    verifiedEmail = identity.email;
    steps.push({ step: 'Identidade Google', ok: true, detail: `Conta verificada: ${verifiedEmail}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro ao verificar identidade Google.';
    updateTenantRecord(companyId, {
      connection_status: 'Erro de autenticação',
      last_connection_test: now,
      last_error: msg,
    });
    steps.push({ step: 'Identidade Google', ok: false, detail: msg });
    return {
      status: 'Erro de autenticação',
      verifiedEmail,
      spreadsheetTitle: tenant.spreadsheet_name,
      schemaReport: null,
      steps,
    };
  }

  if (!tenant.spreadsheet_id) {
    updateTenantRecord(companyId, {
      verified_google_email: verifiedEmail,
      connection_status: 'A aguardar autorização',
      last_connection_test: now,
      last_error: 'Nenhuma folha de cálculo selecionada.',
    });
    steps.push({ step: 'Acesso à Folha', ok: false, detail: 'Selecione ou crie uma folha Google Sheets.' });
    return {
      status: 'A aguardar autorização',
      verifiedEmail,
      spreadsheetTitle: '',
      schemaReport: null,
      steps,
    };
  }

  try {
    const { metadata, report } = await validateSpreadsheetSchema(accessToken, tenant.spreadsheet_id);
    steps.push({ step: 'Acesso à Folha', ok: true, detail: `Folha acessível: ${metadata.title}` });
    steps.push({
      step: 'Validação de Estrutura (20 abas)',
      ok: report.valid,
      detail: report.valid
        ? 'Todas as 20 abas e respetivos cabeçalhos estão conformes.'
        : `Faltam ${report.missingWorksheets.length} abas e ${report.headerMismatches.length} cabeçalhos.`,
    });

    // Teste de leitura real na aba CompanySettings
    await batchGetRanges(accessToken, tenant.spreadsheet_id, [`'CompanySettings'!A1:K2`]);
    steps.push({ step: 'Leitura Operacional', ok: true, detail: 'Leitura da aba CompanySettings confirmada.' });

    const finalStatus: SheetsConnectionStatus = report.valid ? 'Ligado' : 'Estrutura inválida';
    updateTenantRecord(companyId, {
      verified_google_email: verifiedEmail,
      spreadsheet_name: metadata.title,
      spreadsheet_url: metadata.spreadsheetUrl,
      schema_valid: report.valid,
      missing_worksheets: report.missingWorksheets,
      connection_status: finalStatus,
      last_connection_test: now,
      last_error: report.valid ? null : 'Estrutura da folha de cálculo incompleta.',
    });

    return {
      status: finalStatus,
      verifiedEmail,
      spreadsheetTitle: metadata.title,
      schemaReport: report,
      steps,
    };
  } catch (err) {
    const gErr = err instanceof GoogleSheetsError ? err : null;
    const status: SheetsConnectionStatus =
      gErr?.code === 'AUTH_ERROR'
        ? 'Ligação expirada'
        : gErr?.code === 'ACCESS_DENIED' || gErr?.code === 'NOT_FOUND'
        ? 'Sem acesso à folha'
        : 'Erro de autenticação';
    const msg = err instanceof Error ? err.message : 'Falha no acesso ao Google Sheets.';
    updateTenantRecord(companyId, {
      connection_status: status,
      last_connection_test: now,
      last_error: msg,
    });
    steps.push({ step: 'Acesso à Folha', ok: false, detail: msg });
    return {
      status,
      verifiedEmail,
      spreadsheetTitle: tenant.spreadsheet_name,
      schemaReport: null,
      steps,
    };
  }
}

export async function disconnectTenantGoogleAccount(companyId: string, actorUserId: string): Promise<void> {
  const tenant = getTenantById(companyId);
  if (!tenant) throw new Error('Empresa não encontrada.');
  const secret = getTenantOAuthSecret(tenant.secret_reference);
  if (secret?.refresh_token) {
    await revokeGoogleOAuthToken(secret.refresh_token);
  } else if (secret?.access_token) {
    await revokeGoogleOAuthToken(secret.access_token);
  }
  deleteTenantOAuthSecret(tenant.secret_reference);
  invalidateTenantCache(companyId);

  updateTenantRecord(companyId, {
    verified_google_email: '',
    email_mismatch_confirmed: false,
    secret_reference: null,
    connection_status: 'Não configurado',
    schema_valid: false,
    last_error: null,
  });

  appendPlatformAuditLog({
    actorUserId,
    actorEmail: tenant.verified_google_email || 'desconhecido',
    companyId,
    eventType: 'google_oauth_disconnected',
    detail: 'Conta Google desligada e tokens revogados do armazenamento seguro.',
  });
}

export async function loadTenantSpreadsheetTables(companyId: string): Promise<{
  tenant: TenantRegistryRecord;
  accessToken: string;
  metadata: SpreadsheetMetadata;
  tables: Map<WorksheetName, SheetRowEntry[]>;
}> {
  const { tenant, accessToken } = await ensureConnectedOperationalSpreadsheet(companyId);
  const cached = tenantCaches.get(companyId);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return {
      tenant,
      accessToken,
      metadata: cached.metadata,
      tables: cached.tables,
    };
  }

  try {
    const metadata = await getSpreadsheetMetadata(accessToken, tenant.spreadsheet_id);
    const ranges = ALL_WORKSHEET_NAMES.map((ws) => `'${ws}'!A1:Z`);
    const rawMap = await batchGetRanges(accessToken, tenant.spreadsheet_id, ranges);
    const tables = new Map<WorksheetName, SheetRowEntry[]>();

    for (const ws of ALL_WORKSHEET_NAMES) {
      const rawRows = rawMap.get(ws) || [];
      const entries: SheetRowEntry[] = [];
      for (let i = 1; i < rawRows.length; i++) {
        const rowArr = rawRows[i];
        if (!rowArr || rowArr.every((c) => c === '')) continue;
        const obj = deserializeRowArray(ws, rowArr);
        // Isolamento rigoroso em profundidade: ignorar qualquer linha que não pertença ao company_id autenticado
        if (obj.company_id && obj.company_id !== companyId) {
          continue;
        }
        entries.push({
          rowNumber: i + 1,
          data: obj,
        });
      }
      tables.set(ws, entries);
    }

    tenantCaches.set(companyId, {
      loadedAt: Date.now(),
      metadata,
      tables,
    });

    return { tenant, accessToken, metadata, tables };
  } catch (err) {
    if (err instanceof GoogleSheetsError) {
      if (err.code === 'AUTH_ERROR') {
        updateTenantRecord(companyId, { connection_status: 'Ligação expirada', last_error: err.message });
      } else if (err.code === 'ACCESS_DENIED' || err.code === 'NOT_FOUND') {
        updateTenantRecord(companyId, { connection_status: 'Sem acesso à folha', last_error: err.message });
      }
    }
    throw err;
  }
}

export function buildTenantSheetsConfigResponse(tenant: TenantRegistryRecord): TenantSheetsConfig {
  const mismatchWarning = Boolean(
    tenant.entered_google_email &&
      tenant.verified_google_email &&
      tenant.entered_google_email.toLowerCase() !== tenant.verified_google_email.toLowerCase() &&
      !tenant.email_mismatch_confirmed
  );

  return {
    company_id: tenant.company_id,
    company_name: tenant.company_name,
    entered_google_email: tenant.entered_google_email,
    verified_google_email: tenant.verified_google_email,
    email_mismatch_confirmed: tenant.email_mismatch_confirmed,
    email_mismatch_warning: mismatchWarning,
    spreadsheet_id: tenant.spreadsheet_id,
    spreadsheet_name: tenant.spreadsheet_name,
    spreadsheet_url: tenant.spreadsheet_url,
    connection_status: tenant.connection_status,
    last_connection_test: tenant.last_connection_test,
    last_successful_write: tenant.last_successful_write,
    last_error: tenant.last_error,
    schema_valid: tenant.schema_valid,
    missing_worksheets: tenant.missing_worksheets,
    oauth_mode: isOAuthCodeFlowConfigured() ? 'authorization_code_pkce' : 'workspace_popup_bridge',
    oauth_code_flow_configured: isOAuthCodeFlowConfigured(),
    updated_at: tenant.updated_at,
  };
}
