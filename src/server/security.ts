import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { UserRole, SubscriptionPlan } from '../shared/types.ts';

function resolveSessionSecret(): string {
  const envSecret = process.env.MANDATO_SESSION_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) {
    return envSecret;
  }
  try {
    const customDir = process.env.MANDATO_CONTROL_PLANE_DIR?.trim();
    const dir = customDir ? path.resolve(customDir) : path.resolve(process.cwd(), '.mandato-control-plane');
    fs.mkdirSync(dir, { recursive: true });
    const secretFile = path.join(dir, '.session-secret');
    if (fs.existsSync(secretFile)) {
      const stored = fs.readFileSync(secretFile, 'utf8').trim();
      if (stored.length >= 32) return stored;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, generated, { encoding: 'utf8', mode: 0o600 });
    return generated;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}

const SESSION_SECRET = resolveSessionSecret();

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

export function hashAgentCredential(rawSecret: string): string {
  return crypto.createHash('sha256').update(rawSecret).digest('hex');
}

export function generateAgentCredential(prefix = 'mdt_live'): {
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
} {
  const randomPart = crypto.randomBytes(24).toString('base64url');
  const rawKey = `${prefix}_${randomPart}`;
  const keyPrefix = rawKey.slice(0, 14);
  const keyHash = hashAgentCredential(rawKey);
  return { rawKey, keyPrefix, keyHash };
}

export interface SessionPayload {
  userId: string;
  companyId: string;
  exp: number;
}

export function signSessionToken(userId: string, companyId: string, ttlMs = 1000 * 60 * 60 * 24): string {
  const payload: SessionPayload = {
    userId,
    companyId,
    exp: Date.now() + ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  if (!token || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    if (!parsed.userId || !parsed.companyId || !parsed.exp || parsed.exp < Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Sliding window rate limiter
export class RateLimiter {
  private buckets = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(key: string, now = Date.now()): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const cutoff = now - this.windowMs;
    const timestamps = (this.buckets.get(key) ?? []).filter((ts) => ts > cutoff);
    if (timestamps.length >= this.maxRequests) {
      const oldest = timestamps[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      this.buckets.set(key, timestamps);
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }
    timestamps.push(now);
    this.buckets.set(key, timestamps);
    return { allowed: true, remaining: this.maxRequests - timestamps.length, retryAfterSeconds: 0 };
  }
}

// Prompt injection & policy bypass detection
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|policies)/i,
  /ignora(r)?\s+(todas\s+as\s+)?(instruções|regras|políticas)\s+(anteriores|acima)/i,
  /(bypass|override|disable|circumvent|ultrapassar|contornar|desativar)\s+(the\s+)?(policy|approval|governance|security|política|aprovação|governação)/i,
  /(modify|change|alterar|atualizar|editar)\s+(my|own|a\s+minha|própria)\s+(policy|policies|permissions|política|permissões)/i,
  /execute\s+(arbitrary\s+)?(shell|bash|cmd|powershell|sql)/i,
  /executar\s+(comando\s+)?(shell|bash|terminal|sql)/i,
  /system\s*:\s*you\s+are\s+now\s+(admin|root|unrestricted)/i,
  /access\s+(another|other)\s+company/i,
  /aceder\s+a\s+outra\s+empresa/i,
];

export function detectPromptInjection(text: string): { detected: boolean; matchedPattern: string | null } {
  if (!text) return { detected: false, matchedPattern: null };
  for (const regex of INJECTION_PATTERNS) {
    if (regex.test(text)) {
      return { detected: true, matchedPattern: regex.source };
    }
  }
  return { detected: false, matchedPattern: null };
}

export type PermissionCapability =
  | 'view_dashboard'
  | 'create_agent'
  | 'manage_agent'
  | 'test_agent'
  | 'manage_policies'
  | 'approve_requests'
  | 'manage_workflows'
  | 'manage_integrations'
  | 'manage_users'
  | 'manage_settings'
  | 'manage_database'
  | 'export_audit';

const ROLE_CAPABILITIES: Record<UserRole, Set<PermissionCapability>> = {
  OWNER: new Set([
    'view_dashboard',
    'create_agent',
    'manage_agent',
    'test_agent',
    'manage_policies',
    'approve_requests',
    'manage_workflows',
    'manage_integrations',
    'manage_users',
    'manage_settings',
    'manage_database',
    'export_audit',
  ]),
  ADMIN: new Set([
    'view_dashboard',
    'create_agent',
    'manage_agent',
    'test_agent',
    'manage_policies',
    'approve_requests',
    'manage_workflows',
    'manage_integrations',
    'manage_database',
    'export_audit',
  ]),
  APPROVER: new Set(['view_dashboard', 'approve_requests', 'test_agent', 'export_audit']),
  OPERATOR: new Set(['view_dashboard', 'create_agent', 'manage_agent', 'test_agent']),
  VIEWER: new Set(['view_dashboard']),
};

export function hasRoleCapability(role: UserRole, capability: PermissionCapability): boolean {
  return ROLE_CAPABILITIES[role]?.has(capability) ?? false;
}

export const SUBSCRIPTION_LIMITS: Record<
  SubscriptionPlan,
  {
    label: string;
    audience: string;
    monthlyPriceEur: number;
    maxAgents: number;
    maxUsers: number;
    workflowsEnabled: boolean;
    advancedGovernance: boolean;
    retentionDays: number;
  }
> = {
  STARTER: {
    label: 'Starter',
    audience: 'Para pequenas equipas em fase inicial',
    monthlyPriceEur: 99,
    maxAgents: 5,
    maxUsers: 5,
    workflowsEnabled: false,
    advancedGovernance: false,
    retentionDays: 90,
  },
  PROFESSIONAL: {
    label: 'Professional',
    audience: 'Para operações em crescimento com fluxos e aprovações',
    monthlyPriceEur: 299,
    maxAgents: 25,
    maxUsers: 25,
    workflowsEnabled: true,
    advancedGovernance: true,
    retentionDays: 365,
  },
  BUSINESS: {
    label: 'Business',
    audience: 'Para empresas com governação avançada e auditoria alargada',
    monthlyPriceEur: 699,
    maxAgents: 150,
    maxUsers: 100,
    workflowsEnabled: true,
    advancedGovernance: true,
    retentionDays: 1095,
  },
};

export function sanitizeTextInput(value: string, maxLen = 2000): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, maxLen);
}
