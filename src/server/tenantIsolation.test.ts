import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockGoogleApiTransport } from './mockGoogleTransport.ts';
import {
  clearAllTenantCachesForTests,
  completeOAuthCodeCallback,
  createNewSpreadsheetForTenant,
  getTenantDatabase,
  initDatabasePlatform,
  resetRegistryCacheForTests,
  selectExistingSpreadsheetForTenant,
  setGoogleApiTransport,
  setGoogleRetryBaseDelayForTests,
  startCompanyGoogleOAuthFlow,
  TenantDatabaseNotConnectedError,
} from './database/databaseManager.ts';
import {
  createPlatformUser,
  createTenantRecord,
  addCompanyMembership,
} from './database/tenantRegistry.ts';
import { hashPassword, signSessionToken } from './security.ts';
import { createApiRouter } from './routes.ts';

let tempDir = '';
let mockTransport: MockGoogleApiTransport;
let server: http.Server;
let baseUrl = '';

async function setupConnectedCompany(params: {
  companyName: string;
  slug: string;
  nif: string;
  userEmail: string;
  googleEmail: string;
}) {
  const user = createPlatformUser({
    email: params.userEmail,
    passwordHash: hashPassword('Segura2026!'),
    fullName: params.companyName,
    jobTitle: 'Diretor',
  });
  const tenant = createTenantRecord({
    companyName: params.companyName,
    slug: params.slug,
    nif: params.nif,
    ownerUserId: user.id,
  });
  addCompanyMembership({ companyId: tenant.company_id, userId: user.id, role: 'OWNER', status: 'active' });

  const flow = startCompanyGoogleOAuthFlow({
    companyId: tenant.company_id,
    userId: user.id,
    enteredGoogleEmail: params.googleEmail,
  });
  const code = `code-${params.slug}`;
  mockTransport.registerAuthCode(code, params.googleEmail, `tok-${params.slug}`, `ref-${params.slug}`);
  await completeOAuthCodeCallback({ state: flow.state, code });
  const created = await createNewSpreadsheetForTenant({
    companyId: tenant.company_id,
    actorUserId: user.id,
  });

  return {
    user,
    tenant: created.tenant,
    spreadsheetId: created.metadata.spreadsheetId,
    sessionToken: signSessionToken(user.id, tenant.company_id),
  };
}

test.beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandato-isol-'));
  process.env.MANDATO_CONTROL_PLANE_DIR = tempDir;
  process.env.MANDATO_MASTER_ENCRYPTION_KEY = 'mandato-isolation-test-key-32b!';
  process.env.MANDATO_PLATFORM_ADMINS = 'direcao@demonstracao.pt,platadmin@mandato.pt';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'mock-cid';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'mock-csec';
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/company/sheets/oauth/callback';

  resetRegistryCacheForTests();
  clearAllTenantCachesForTests();
  setGoogleRetryBaseDelayForTests(0);
  mockTransport = new MockGoogleApiTransport();
  setGoogleApiTransport(mockTransport);
  initDatabasePlatform();

  const app = express();
  app.use(express.json());
  app.use(createApiRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  setGoogleApiTransport(null);
  clearAllTenantCachesForTests();
  resetRegistryCacheForTests();
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('11. Empresa A e Empresa B têm folhas e dados totalmente isolados', async () => {
  const empA = await setupConnectedCompany({
    companyName: 'Empresa A Lda',
    slug: 'emp-a',
    nif: '501111111',
    userEmail: 'owner@empa.pt',
    googleEmail: 'sheets@empa.pt',
  });
  const empB = await setupConnectedCompany({
    companyName: 'Empresa B Lda',
    slug: 'emp-b',
    nif: '502222222',
    userEmail: 'owner@empb.pt',
    googleEmail: 'sheets@empb.pt',
  });

  assert.notEqual(empA.spreadsheetId, empB.spreadsheetId);

  const dbA = await getTenantDatabase(empA.tenant.company_id);
  await dbA.policies.createPolicy({
    name: 'Política Exclusiva Empresa A',
    description: 'Confidencial A',
    actionType: 'purchase_order',
    ruleType: 'financial_threshold',
    maxAutoAmount: 200,
    maxApprovalAmount: 800,
    isAbsoluteRestriction: false,
  });

  const dbB = await getTenantDatabase(empB.tenant.company_id);
  const policiesB = await dbB.policies.listPolicies();
  assert.equal(policiesB.some((p) => p.name === 'Política Exclusiva Empresa A'), false);

  const policiesA = await dbA.policies.listPolicies();
  assert.equal(policiesA.some((p) => p.name === 'Política Exclusiva Empresa A'), true);
});

test('12. Associar spreadsheet_id já pertencente à Empresa A na Empresa B é bloqueado', async () => {
  const empA = await setupConnectedCompany({
    companyName: 'Empresa A Lda',
    slug: 'emp-a',
    nif: '501111111',
    userEmail: 'owner@empa.pt',
    googleEmail: 'sheets@empa.pt',
  });
  const empB = await setupConnectedCompany({
    companyName: 'Empresa B Lda',
    slug: 'emp-b',
    nif: '502222222',
    userEmail: 'owner@empb.pt',
    googleEmail: 'sheets@empb.pt',
  });

  // Mesmo que alguém partilhasse a folha no Drive, o registry rejeita partilha entre tenants
  mockTransport.spreadsheets.get(empA.spreadsheetId)!.sharedWith.add('sheets@empb.pt');

  await assert.rejects(
    () =>
      selectExistingSpreadsheetForTenant({
        companyId: empB.tenant.company_id,
        actorUserId: empB.user.id,
        spreadsheetId: empA.spreadsheetId,
      }),
    /Violação de isolamento multi-empresa/i
  );
});

test('13. Gateway /api/v1/authorize resolve company_id apenas pelo hash da credencial e bloqueia spoofing', async () => {
  const empA = await setupConnectedCompany({
    companyName: 'Empresa A Lda',
    slug: 'emp-a',
    nif: '501111111',
    userEmail: 'owner@empa.pt',
    googleEmail: 'sheets@empa.pt',
  });
  const empB = await setupConnectedCompany({
    companyName: 'Empresa B Lda',
    slug: 'emp-b',
    nif: '502222222',
    userEmail: 'owner@empb.pt',
    googleEmail: 'sheets@empb.pt',
  });

  // Criar política + agente ativo na Empresa A via HTTP API
  const polRes = await fetch(`${baseUrl}/api/policies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${empA.sessionToken}` },
    body: JSON.stringify({
      name: 'Compras A',
      action_type: 'purchase_order',
      rule_type: 'financial_threshold',
      max_auto_amount: 100,
      max_approval_amount: 500,
    }),
  });
  const { policy } = (await polRes.json()) as { policy: { id: string } };

  const agRes = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${empA.sessionToken}` },
    body: JSON.stringify({
      name: 'Agente A',
      description: 'Compras',
      origin: 'EXTERNAL',
      status: 'active',
      policy_ids: [policy.id],
    }),
  });
  const { issued_api_key } = (await agRes.json()) as { issued_api_key: string };

  // Tentar spoof de target company_id para Empresa B -> BLOQUEADO (403)
  const spoofRes = await fetch(`${baseUrl}/api/v1/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued_api_key}` },
    body: JSON.stringify({
      action_type: 'read_info',
      description: 'Ler dados de outra empresa',
      company_id: empB.tenant.company_id,
    }),
  });
  assert.equal(spoofRes.status, 403);
  const spoofJson = (await spoofRes.json()) as { decision: string };
  assert.equal(spoofJson.decision, 'BLOCKED');

  // Garantir que Empresa B não recebeu qualquer pedido de autorização ou auditoria da Empresa A
  const dbB = await getTenantDatabase(empB.tenant.company_id);
  assert.equal((await dbB.approvals.listAuthorizationRequests()).length, 0);
});

test('14. /api/platform/tenants exige is_platform_admin e expõe apenas metadados de ligação', async () => {
  const empA = await setupConnectedCompany({
    companyName: 'Empresa A Segredo SA',
    slug: 'emp-a-sec',
    nif: '501111111',
    userEmail: 'normal@empa.pt',
    googleEmail: 'sheets@empa.pt',
  });

  // Criar registo operacional confidencial na folha da Empresa A
  const dbA = await getTenantDatabase(empA.tenant.company_id);
  await dbA.policies.createPolicy({
    name: 'NOME_SECRETO_OPERACIONAL_A',
    description: 'Confidencial',
    actionType: 'purchase_order',
    ruleType: 'require_approval',
    maxAutoAmount: null,
    maxApprovalAmount: null,
    isAbsoluteRestriction: false,
  });

  // Utilizador normal recebe 403
  const forbidden = await fetch(`${baseUrl}/api/platform/tenants`, {
    headers: { Authorization: `Bearer ${empA.sessionToken}` },
  });
  assert.equal(forbidden.status, 403);

  // Admin da plataforma recebe 200 com metadados e ZERO dados operacionais
  const platUser = createPlatformUser({
    email: 'platadmin@mandato.pt',
    passwordHash: hashPassword('Admin2026!'),
    fullName: 'Platform Admin',
    jobTitle: 'SRE',
  });
  addCompanyMembership({ companyId: empA.tenant.company_id, userId: platUser.id, role: 'OWNER', status: 'active' });
  const adminToken = signSessionToken(platUser.id, empA.tenant.company_id);

  const okRes = await fetch(`${baseUrl}/api/platform/tenants`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(okRes.status, 200);
  const rawBody = await okRes.text();
  assert.equal(rawBody.includes('NOME_SECRETO_OPERACIONAL_A'), false);

  const parsed = JSON.parse(rawBody) as { tenants: Array<Record<string, unknown>> };
  const row = parsed.tenants.find((t) => t.company_id === empA.tenant.company_id)!;
  assert.equal(row.verified_google_email, 'sheets@empa.pt');
  assert.equal(row.connection_status, 'Ligado');
  assert.equal('secret_reference' in row, false);
});

test('15. Empresa sem folha Google Sheets ligada falha explicitamente com 503 DATABASE_NOT_CONNECTED (sem fallback local)', async () => {
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      full_name: 'Maria Sem Folha',
      email: 'maria@semfolha.pt',
      password: 'Password2026!',
      company_name: 'Sem Folha Lda',
      nif: '509888777',
    }),
  });
  assert.equal(regRes.status, 201);
  const { token, user } = (await regRes.json()) as { token: string; user: { company_id: string } };

  for (const endpoint of ['/api/dashboard', '/api/agents', '/api/policies', '/api/approvals', '/api/workflows', '/api/audit-logs']) {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 503, `Esperado 503 em ${endpoint}`);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'DATABASE_NOT_CONNECTED');
  }

  await assert.rejects(
    () => getTenantDatabase(user.company_id),
    (err: unknown) => err instanceof TenantDatabaseNotConnectedError
  );
});
