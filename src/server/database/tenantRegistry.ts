import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Company,
  PlatformTenantSummary,
  SheetsConnectionStatus,
  SubscriptionPlan,
  UserRole,
} from '../../shared/types.ts';
import { hashPassword } from '../security.ts';

export interface PlatformUser {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  job_title: string;
  avatar_initials: string;
  is_platform_admin: boolean;
  recovery_token_hash: string | null;
  recovery_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlatformMembership {
  id: string;
  company_id: string;
  user_id: string;
  role: UserRole;
  status: 'active' | 'invited' | 'suspended';
  created_at: string;
  updated_at: string;
}

export interface TenantRegistryRecord {
  company_id: string;
  company_name: string;
  slug: string;
  nif: string;
  sector: string;
  subscription_plan: SubscriptionPlan;
  is_demo: boolean;
  retention_days: number;
  owner_user_id: string;
  entered_google_email: string;
  verified_google_email: string;
  email_mismatch_confirmed: boolean;
  spreadsheet_id: string;
  spreadsheet_name: string;
  spreadsheet_url: string;
  connection_status: SheetsConnectionStatus;
  secret_reference: string | null;
  last_connection_test: string | null;
  last_successful_write: string | null;
  last_error: string | null;
  schema_valid: boolean;
  missing_worksheets: string[];
  oauth_mode: 'authorization_code_pkce' | 'workspace_popup_bridge';
  created_at: string;
  updated_at: string;
}

export interface OAuthPkceStateRecord {
  state: string;
  company_id: string;
  user_id: string;
  entered_google_email: string;
  code_verifier: string;
  expires_at: number;
  used: boolean;
}

export interface PlatformAuditLogRecord {
  id: string;
  actor_user_id: string;
  actor_email: string;
  company_id: string | null;
  event_type: string;
  detail: string;
  created_at: string;
}

interface AgentCredentialRoute {
  key_hash: string;
  company_id: string;
}

interface ControlPlaneState {
  version: number;
  users: PlatformUser[];
  memberships: PlatformMembership[];
  tenants: TenantRegistryRecord[];
  oauthStates: OAuthPkceStateRecord[];
  platformAuditLogs: PlatformAuditLogRecord[];
  credentialRoutes: AgentCredentialRoute[];
}

export const DEMO_COMPANY_ID = 'comp-demo-mandato';

function getControlPlaneDir(): string {
  const custom = process.env.MANDATO_CONTROL_PLANE_DIR?.trim();
  const dir = custom ? path.resolve(custom) : path.resolve(process.cwd(), '.mandato-control-plane');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getRegistryPath(): string {
  return path.join(getControlPlaneDir(), 'registry.json');
}

function isEmailInPlatformAdminEnv(email: string): boolean {
  const raw = process.env.MANDATO_PLATFORM_ADMINS || 'direcao@demonstracao.pt';
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

function createInitialSeedState(): ControlPlaneState {
  const now = '2026-11-01T09:00:00.000Z';
  const demoUsers: Array<{
    id: string;
    email: string;
    fullName: string;
    jobTitle: string;
    role: UserRole;
    initials: string;
    pass: string;
  }> = [
    {
      id: 'usr-demo-owner',
      email: 'direcao@demonstracao.pt',
      fullName: 'Helena Vasconcelos',
      jobTitle: 'Diretora-Geral',
      role: 'OWNER',
      initials: 'HV',
      pass: 'MandatoDemo2026!',
    },
    {
      id: 'usr-demo-admin',
      email: 'administracao@demonstracao.pt',
      fullName: 'Tiago Azevedo',
      jobTitle: 'Diretor de Sistemas e Governação',
      role: 'ADMIN',
      initials: 'TA',
      pass: 'MandatoDemo2026!',
    },
    {
      id: 'usr-demo-approver',
      email: 'aprovacoes@demonstracao.pt',
      fullName: 'Inês Ferreira',
      jobTitle: 'Diretora Financeira',
      role: 'APPROVER',
      initials: 'IF',
      pass: 'MandatoDemo2026!',
    },
    {
      id: 'usr-demo-operator',
      email: 'operacoes@demonstracao.pt',
      fullName: 'Diogo Martins',
      jobTitle: 'Gestor de Operações',
      role: 'OPERATOR',
      initials: 'DM',
      pass: 'MandatoDemo2026!',
    },
    {
      id: 'usr-demo-viewer',
      email: 'auditoria@demonstracao.pt',
      fullName: 'Sofia Almeida',
      jobTitle: 'Auditora Interna',
      role: 'VIEWER',
      initials: 'SA',
      pass: 'MandatoDemo2026!',
    },
  ];

  const users: PlatformUser[] = demoUsers.map((u) => ({
    id: u.id,
    email: u.email,
    password_hash: hashPassword(u.pass),
    full_name: u.fullName,
    job_title: u.jobTitle,
    avatar_initials: u.initials,
    is_platform_admin: isEmailInPlatformAdminEnv(u.email),
    recovery_token_hash: null,
    recovery_expires_at: null,
    created_at: now,
    updated_at: now,
  }));

  const memberships: PlatformMembership[] = demoUsers.map((u) => ({
    id: `mem-${u.id}`,
    company_id: DEMO_COMPANY_ID,
    user_id: u.id,
    role: u.role,
    status: 'active',
    created_at: now,
    updated_at: now,
  }));

  const demoTenant: TenantRegistryRecord = {
    company_id: DEMO_COMPANY_ID,
    company_name: 'Empresa Demonstração, Lda',
    slug: 'empresa-demonstracao',
    nif: '509123456',
    sector: 'Serviços Empresariais & Distribuição',
    subscription_plan: 'BUSINESS',
    is_demo: true,
    retention_days: 1095,
    owner_user_id: 'usr-demo-owner',
    entered_google_email: '',
    verified_google_email: '',
    email_mismatch_confirmed: false,
    spreadsheet_id: '',
    spreadsheet_name: '',
    spreadsheet_url: '',
    connection_status: 'Não configurado',
    secret_reference: null,
    last_connection_test: null,
    last_successful_write: null,
    last_error: null,
    schema_valid: false,
    missing_worksheets: [],
    oauth_mode: 'workspace_popup_bridge',
    created_at: now,
    updated_at: now,
  };

  return {
    version: 1,
    users,
    memberships,
    tenants: [demoTenant],
    oauthStates: [],
    platformAuditLogs: [],
    credentialRoutes: [],
  };
}

let cachedState: ControlPlaneState | null = null;
let cachedDir: string | null = null;

function loadState(): ControlPlaneState {
  const dir = getControlPlaneDir();
  if (cachedState && cachedDir === dir) {
    return cachedState;
  }
  const filePath = getRegistryPath();
  if (!fs.existsSync(filePath)) {
    const initial = createInitialSeedState();
    saveState(initial);
    return initial;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as ControlPlaneState;
    cachedState = {
      version: parsed.version || 1,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      memberships: Array.isArray(parsed.memberships) ? parsed.memberships : [],
      tenants: Array.isArray(parsed.tenants) ? parsed.tenants : [],
      oauthStates: Array.isArray(parsed.oauthStates) ? parsed.oauthStates : [],
      platformAuditLogs: Array.isArray(parsed.platformAuditLogs) ? parsed.platformAuditLogs : [],
      credentialRoutes: Array.isArray(parsed.credentialRoutes) ? parsed.credentialRoutes : [],
    };
    cachedDir = dir;
    return cachedState;
  } catch {
    const initial = createInitialSeedState();
    saveState(initial);
    return initial;
  }
}

function saveState(state: ControlPlaneState): void {
  const dir = getControlPlaneDir();
  const filePath = getRegistryPath();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  cachedState = state;
  cachedDir = dir;
}

export function resetRegistryCacheForTests(): void {
  cachedState = null;
  cachedDir = null;
}

export function initControlPlaneRegistry(): void {
  loadState();
}

export function findPlatformUserByEmail(email: string): PlatformUser | null {
  const state = loadState();
  const normalized = email.trim().toLowerCase();
  return state.users.find((u) => u.email.toLowerCase() === normalized) || null;
}

export function findPlatformUserById(userId: string): PlatformUser | null {
  const state = loadState();
  return state.users.find((u) => u.id === userId) || null;
}

export function createPlatformUser(input: {
  id?: string;
  email: string;
  passwordHash: string;
  fullName: string;
  jobTitle: string;
}): PlatformUser {
  const state = loadState();
  const now = new Date().toISOString();
  const initials = input.fullName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('');

  const user: PlatformUser = {
    id: input.id || crypto.randomUUID(),
    email: input.email.trim().toLowerCase(),
    password_hash: input.passwordHash,
    full_name: input.fullName,
    job_title: input.jobTitle,
    avatar_initials: initials || 'US',
    is_platform_admin: isEmailInPlatformAdminEnv(input.email),
    recovery_token_hash: null,
    recovery_expires_at: null,
    created_at: now,
    updated_at: now,
  };
  state.users.push(user);
  saveState(state);
  return user;
}

export function setUserRecoveryToken(userId: string, tokenHash: string | null, expiresAt: string | null): void {
  const state = loadState();
  const u = state.users.find((x) => x.id === userId);
  if (!u) return;
  u.recovery_token_hash = tokenHash;
  u.recovery_expires_at = expiresAt;
  u.updated_at = new Date().toISOString();
  saveState(state);
}

export function updatePlatformUserPassword(userId: string, newPasswordHash: string): void {
  const state = loadState();
  const u = state.users.find((x) => x.id === userId);
  if (!u) return;
  u.password_hash = newPasswordHash;
  u.recovery_token_hash = null;
  u.recovery_expires_at = null;
  u.updated_at = new Date().toISOString();
  saveState(state);
}

export function getMembershipsForUser(userId: string): PlatformMembership[] {
  const state = loadState();
  return state.memberships.filter((m) => m.user_id === userId);
}

export function getMembership(companyId: string, userId: string): PlatformMembership | null {
  const state = loadState();
  return state.memberships.find((m) => m.company_id === companyId && m.user_id === userId) || null;
}

export function listMembersForCompany(companyId: string): Array<PlatformMembership & { email: string; full_name: string; job_title: string }> {
  const state = loadState();
  const usersById = new Map(state.users.map((u) => [u.id, u]));
  return state.memberships
    .filter((m) => m.company_id === companyId)
    .map((m) => {
      const u = usersById.get(m.user_id);
      return {
        ...m,
        email: u?.email || '',
        full_name: u?.full_name || '',
        job_title: u?.job_title || '',
      };
    });
}

export function addCompanyMembership(input: {
  companyId: string;
  userId: string;
  role: UserRole;
  status?: 'active' | 'invited' | 'suspended';
}): PlatformMembership {
  const state = loadState();
  const now = new Date().toISOString();
  const mem: PlatformMembership = {
    id: crypto.randomUUID(),
    company_id: input.companyId,
    user_id: input.userId,
    role: input.role,
    status: input.status || 'active',
    created_at: now,
    updated_at: now,
  };
  state.memberships.push(mem);
  saveState(state);
  return mem;
}

export function updateCompanyMembershipRole(
  companyId: string,
  memberId: string,
  role: UserRole
): (PlatformMembership & { full_name: string }) | null {
  const state = loadState();
  const mem = state.memberships.find((m) => m.id === memberId && m.company_id === companyId);
  if (!mem) return null;
  mem.role = role;
  mem.updated_at = new Date().toISOString();
  saveState(state);
  const u = state.users.find((x) => x.id === mem.user_id);
  return { ...mem, full_name: u?.full_name || '' };
}

export function createTenantRecord(input: {
  companyId?: string;
  companyName: string;
  slug: string;
  nif: string;
  sector?: string;
  subscriptionPlan?: SubscriptionPlan;
  ownerUserId: string;
  isDemo?: boolean;
}): TenantRegistryRecord {
  const state = loadState();
  const now = new Date().toISOString();
  const plan = input.subscriptionPlan || 'PROFESSIONAL';
  const retentionDays = plan === 'BUSINESS' ? 1095 : plan === 'PROFESSIONAL' ? 365 : 90;

  const tenant: TenantRegistryRecord = {
    company_id: input.companyId || crypto.randomUUID(),
    company_name: input.companyName,
    slug: input.slug,
    nif: input.nif,
    sector: input.sector || 'Geral',
    subscription_plan: plan,
    is_demo: Boolean(input.isDemo),
    retention_days: retentionDays,
    owner_user_id: input.ownerUserId,
    entered_google_email: '',
    verified_google_email: '',
    email_mismatch_confirmed: false,
    spreadsheet_id: '',
    spreadsheet_name: '',
    spreadsheet_url: '',
    connection_status: 'Não configurado',
    secret_reference: null,
    last_connection_test: null,
    last_successful_write: null,
    last_error: null,
    schema_valid: false,
    missing_worksheets: [],
    oauth_mode: 'workspace_popup_bridge',
    created_at: now,
    updated_at: now,
  };
  state.tenants.push(tenant);
  saveState(state);
  return tenant;
}

export function getTenantById(companyId: string): TenantRegistryRecord | null {
  const state = loadState();
  return state.tenants.find((t) => t.company_id === companyId) || null;
}

export function getTenantBySlug(slug: string): TenantRegistryRecord | null {
  const state = loadState();
  return state.tenants.find((t) => t.slug === slug) || null;
}

export function getDemoMembershipByRole(role: UserRole): {
  user: PlatformUser;
  membership: PlatformMembership;
  tenant: TenantRegistryRecord;
} | null {
  const state = loadState();
  const tenant = state.tenants.find((t) => t.slug === 'empresa-demonstracao');
  if (!tenant) return null;
  const membership = state.memberships.find(
    (m) => m.company_id === tenant.company_id && m.role === role && m.status === 'active'
  );
  if (!membership) return null;
  const user = state.users.find((u) => u.id === membership.user_id);
  if (!user) return null;
  return { user, membership, tenant };
}

export function updateTenantRecord(
  companyId: string,
  patch: Partial<TenantRegistryRecord>
): TenantRegistryRecord | null {
  const state = loadState();
  const idx = state.tenants.findIndex((t) => t.company_id === companyId);
  if (idx === -1) return null;
  state.tenants[idx] = {
    ...state.tenants[idx],
    ...patch,
    company_id: companyId,
    updated_at: new Date().toISOString(),
  };
  saveState(state);
  return state.tenants[idx];
}

export function toCompanyObject(tenant: TenantRegistryRecord): Company {
  return {
    id: tenant.company_id,
    name: tenant.company_name,
    slug: tenant.slug,
    nif: tenant.nif,
    sector: tenant.sector,
    subscription_plan: tenant.subscription_plan,
    is_demo: tenant.is_demo,
    retention_days: tenant.retention_days,
    created_at: tenant.created_at,
    updated_at: tenant.updated_at,
  };
}

export function findTenantBySpreadsheetId(spreadsheetId: string): TenantRegistryRecord | null {
  if (!spreadsheetId) return null;
  const state = loadState();
  return state.tenants.find((t) => t.spreadsheet_id === spreadsheetId) || null;
}

export function listPlatformTenantsMetadataOnly(): PlatformTenantSummary[] {
  const state = loadState();
  return state.tenants.map((t) => ({
    company_id: t.company_id,
    company_name: t.company_name,
    slug: t.slug,
    subscription_plan: t.subscription_plan,
    is_demo: t.is_demo,
    entered_google_email: t.entered_google_email,
    verified_google_email: t.verified_google_email,
    spreadsheet_id: t.spreadsheet_id,
    spreadsheet_name: t.spreadsheet_name,
    connection_status: t.connection_status,
    schema_valid: t.schema_valid,
    last_connection_test: t.last_connection_test,
    last_successful_write: t.last_successful_write,
    created_at: t.created_at,
  }));
}

export function saveOAuthPkceState(record: OAuthPkceStateRecord): void {
  const state = loadState();
  const now = Date.now();
  state.oauthStates = state.oauthStates.filter((s) => s.expires_at > now && !s.used);
  state.oauthStates.push(record);
  saveState(state);
}

export function consumeOAuthPkceState(stateToken: string): OAuthPkceStateRecord | null {
  const state = loadState();
  const now = Date.now();
  const idx = state.oauthStates.findIndex((s) => s.state === stateToken);
  if (idx === -1) return null;
  const record = state.oauthStates[idx];
  if (record.used || record.expires_at <= now) {
    state.oauthStates.splice(idx, 1);
    saveState(state);
    return null;
  }
  record.used = true;
  saveState(state);
  return record;
}

export function appendPlatformAuditLog(input: {
  actorUserId: string;
  actorEmail: string;
  companyId?: string | null;
  eventType: string;
  detail: string;
}): void {
  const state = loadState();
  state.platformAuditLogs.unshift({
    id: crypto.randomUUID(),
    actor_user_id: input.actorUserId,
    actor_email: input.actorEmail,
    company_id: input.companyId || null,
    event_type: input.eventType,
    detail: input.detail,
    created_at: new Date().toISOString(),
  });
  if (state.platformAuditLogs.length > 500) {
    state.platformAuditLogs = state.platformAuditLogs.slice(0, 500);
  }
  saveState(state);
}

export function listPlatformAuditLogs(): PlatformAuditLogRecord[] {
  const state = loadState();
  return [...state.platformAuditLogs];
}

export function registerAgentCredentialRoute(keyHash: string, companyId: string): void {
  const state = loadState();
  state.credentialRoutes = state.credentialRoutes.filter((r) => r.key_hash !== keyHash);
  state.credentialRoutes.push({ key_hash: keyHash, company_id: companyId });
  saveState(state);
}

export function resolveCompanyByCredentialHash(keyHash: string): string | null {
  const state = loadState();
  const match = state.credentialRoutes.find((r) => r.key_hash === keyHash);
  return match ? match.company_id : null;
}

