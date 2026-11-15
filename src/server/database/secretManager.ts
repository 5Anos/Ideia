import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface StoredOAuthSecret {
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  scope: string;
  verified_google_email: string;
  token_type: string;
  oauth_mode: 'authorization_code_pkce' | 'workspace_popup_bridge';
  updated_at: string;
}

interface SecretVaultFile {
  secrets: Record<string, { iv: string; tag: string; ciphertext: string; updated_at: string }>;
}

const EPHEMERAL_DEV_KEY = crypto.randomBytes(32);
let masterKeyWarned = false;

function resolveControlPlaneDir(): string {
  const custom = process.env.MANDATO_CONTROL_PLANE_DIR?.trim();
  const dir = custom ? path.resolve(custom) : path.resolve(process.cwd(), '.mandato-control-plane');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getMasterKey(): Buffer {
  const envKey = process.env.MANDATO_MASTER_ENCRYPTION_KEY?.trim();
  if (envKey && envKey.length >= 16) {
    return crypto.createHash('sha256').update(envKey, 'utf8').digest();
  }
  // Para desenvolvimento e Cloud Run sem Secret Manager externo, derivar chave estável a partir do segredo de sessão
  const sessionSecret = process.env.MANDATO_SESSION_SECRET?.trim();
  if (sessionSecret && sessionSecret.length >= 16) {
    return crypto.createHash('sha256').update(`vault:${sessionSecret}`, 'utf8').digest();
  }

  // Fallback local persistente no control-plane para reinícios em desenvolvimento sem vazar em código-fonte
  const dir = resolveControlPlaneDir();
  const keyFile = path.join(dir, '.vault-key');
  try {
    if (fs.existsSync(keyFile)) {
      const hex = fs.readFileSync(keyFile, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) {
        return Buffer.from(hex, 'hex');
      }
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyFile, generated, { encoding: 'utf8', mode: 0o600 });
    if (!masterKeyWarned) {
      masterKeyWarned = true;
      console.warn(
        '[MANDATO Security] MANDATO_MASTER_ENCRYPTION_KEY não definida. Gerada chave local cifrada para desenvolvimento.'
      );
    }
    return Buffer.from(generated, 'hex');
  } catch {
    return EPHEMERAL_DEV_KEY;
  }
}

function getVaultPath(): string {
  return path.join(resolveControlPlaneDir(), 'secrets.vault.json');
}

function readVault(): SecretVaultFile {
  const filePath = getVaultPath();
  if (!fs.existsSync(filePath)) {
    return { secrets: {} };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as SecretVaultFile;
    return parsed && typeof parsed.secrets === 'object' ? parsed : { secrets: {} };
  } catch {
    return { secrets: {} };
  }
}

function writeVault(vault: SecretVaultFile): void {
  const filePath = getVaultPath();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(vault, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function encryptPayload(plainJson: string): { iv: string; tag: string; ciphertext: string } {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainJson, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

function decryptPayload(entry: { iv: string; tag: string; ciphertext: string }): string {
  const key = getMasterKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(entry.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(entry.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function buildSecretReference(companyId: string): string {
  const safeId = companyId.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (process.env.GOOGLE_SECRET_MANAGER_ENABLED === 'true' && process.env.GOOGLE_CLOUD_PROJECT_ID) {
    return `projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}/secrets/mandato-oauth-${safeId}`;
  }
  return `vault://mandato/oauth/${safeId}`;
}

export function storeTenantOAuthSecret(companyId: string, secret: StoredOAuthSecret): string {
  const ref = buildSecretReference(companyId);
  const vault = readVault();
  const encrypted = encryptPayload(JSON.stringify(secret));
  vault.secrets[ref] = {
    ...encrypted,
    updated_at: new Date().toISOString(),
  };
  writeVault(vault);
  return ref;
}

export function getTenantOAuthSecret(secretRef: string | null | undefined): StoredOAuthSecret | null {
  if (!secretRef) return null;
  const vault = readVault();
  const entry = vault.secrets[secretRef];
  if (!entry) return null;
  try {
    const plain = decryptPayload(entry);
    return JSON.parse(plain) as StoredOAuthSecret;
  } catch {
    return null;
  }
}

export function deleteTenantOAuthSecret(secretRef: string | null | undefined): void {
  if (!secretRef) return;
  const vault = readVault();
  if (vault.secrets[secretRef]) {
    delete vault.secrets[secretRef];
    writeVault(vault);
  }
}
