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
  initDatabasePlatform,
  resetRegistryCacheForTests,
  setGoogleApiTransport,
  setGoogleRetryBaseDelayForTests,
} from './database/databaseManager.ts';
import { createApiRouter } from './routes.ts';

let tempControlPlaneDir = '';
let mockTransport: MockGoogleApiTransport;
let server: http.Server;
let baseUrl = '';

test.before(async () => {
  tempControlPlaneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandato-e2e-'));
  process.env.MANDATO_CONTROL_PLANE_DIR = tempControlPlaneDir;
  process.env.MANDATO_MASTER_ENCRYPTION_KEY = 'mandato-e2e-master-encryption-key!';
  process.env.MANDATO_PLATFORM_ADMINS = 'direcao@demonstracao.pt';
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
      if (addr && typeof addr !== 'string') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  setGoogleApiTransport(null);
  clearAllTenantCachesForTests();
  resetRegistryCacheForTests();
  if (tempControlPlaneDir && fs.existsSync(tempControlPlaneDir)) {
    fs.rmSync(tempControlPlaneDir, { recursive: true, force: true });
  }
});

test('Ciclo completo: registo -> 503 sem Google Sheets -> ligar OAuth & criar folha -> agente externo -> /api/v1/authorize -> aprovação -> plataforma -> desligar', async () => {
  // 1. Registar nova empresa
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      full_name: 'Carlos Mendes',
      email: `carlos.${Date.now()}@novatech.pt`,
      password: 'PasswordSegura2026!',
      company_name: 'NovaTech Lda',
      nif: '508999111',
    }),
  });
  assert.equal(regRes.status, 201);
  const regData = (await regRes.json()) as { token: string; user: { company_id: string } };
  const token = regData.token;

  // 2. Sem folha Google Sheets ligada, dashboard retorna 503 DATABASE_NOT_CONNECTED
  const dashBefore = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(dashBefore.status, 503);
  const dashBeforeJson = (await dashBefore.json()) as { code: string };
  assert.equal(dashBeforeJson.code, 'DATABASE_NOT_CONNECTED');

  // 3. Guardar email Google e ligar OAuth (via bridge PKCE state + token validado no backend)
  const startRes = await fetch(`${baseUrl}/api/company/sheets/oauth/start?email=bd@novatech.pt`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(startRes.status, 200);
  const startJson = (await startRes.json()) as { state: string };

  mockTransport.registerAccessToken('tok-novatech', 'bd@novatech.pt');
  const bridgeRes = await fetch(`${baseUrl}/api/company/sheets/oauth/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      state: startJson.state,
      access_token: 'tok-novatech',
      entered_google_email: 'bd@novatech.pt',
    }),
  });
  assert.equal(bridgeRes.status, 200);

  // 4. Criar nova folha Google Sheets dedicada para a empresa
  const createSheetRes = await fetch(`${baseUrl}/api/company/sheets/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  assert.equal(createSheetRes.status, 201);
  const createSheetJson = (await createSheetRes.json()) as {
    config: { connection_status: string; schema_valid: boolean; spreadsheet_id: string };
  };
  assert.equal(createSheetJson.config.connection_status, 'Ligado');
  assert.equal(createSheetJson.config.schema_valid, true);

  // 5. Agora o dashboard já funciona usando a folha Google Sheets da empresa
  const dashAfter = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(dashAfter.status, 200);

  // 6. Criar política de compras e agente externo ativo
  const createPolRes = await fetch(`${baseUrl}/api/policies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'Política de Compras NovaTech',
      description: 'Até 300 EUR automático; 300-1000 EUR aprovação',
      action_type: 'purchase_order',
      rule_type: 'financial_threshold',
      max_auto_amount: 300,
      max_approval_amount: 1000,
    }),
  });
  assert.equal(createPolRes.status, 201);
  const { policy: createdPolicy } = (await createPolRes.json()) as { policy: { id: string } };

  const polRes = await fetch(`${baseUrl}/api/policies`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const polJson = (await polRes.json()) as { policies: Array<{ id: string }> };
  assert.ok(polJson.policies.some((p) => p.id === createdPolicy.id));

  const createAgentRes = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'Agente ERP NovaTech',
      description: 'Agente externo para testes E2E',
      category: 'Compras',
      objective: 'Testar gateway de autorização',
      origin: 'EXTERNAL',
      provider: 'Google Gemini',
      model: 'gemini-4-hydrogen',
      external_identifier: 'ext-novatech-01',
      status: 'active',
      policy_ids: [createdPolicy.id],
      tools: [{ tool_key: 'submeter_encomenda', is_enabled: true, requires_approval: true }],
    }),
  });
  assert.equal(createAgentRes.status, 201);
  const createdAgent = (await createAgentRes.json()) as { issued_api_key: string };
  assert.ok(createdAgent.issued_api_key.startsWith('mdt_ext_'));

  // 7. Chamar gateway /api/v1/authorize com €500 (REQUIRES_APPROVAL + idempotência)
  const idemKey = `idem_e2e_${Date.now()}`;
  const gwRes1 = await fetch(`${baseUrl}/api/v1/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${createdAgent.issued_api_key}`,
    },
    body: JSON.stringify({
      action_type: 'purchase_order',
      tool_name: 'submeter_encomenda',
      description: 'Compra de equipamento de escritório',
      amount: 500,
      currency: 'EUR',
      idempotency_key: idemKey,
    }),
  });
  assert.equal(gwRes1.status, 200);
  const gw1 = (await gwRes1.json()) as { decision: string; approval_request_id: string };
  assert.equal(gw1.decision, 'REQUIRES_APPROVAL');

  const gwRes2 = await fetch(`${baseUrl}/api/v1/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${createdAgent.issued_api_key}`,
    },
    body: JSON.stringify({
      action_type: 'purchase_order',
      tool_name: 'submeter_encomenda',
      description: 'Compra de equipamento de escritório',
      amount: 500,
      currency: 'EUR',
      idempotency_key: idemKey,
    }),
  });
  const gw2 = (await gwRes2.json()) as { approval_request_id: string; idempotent_replay: boolean };
  assert.equal(gw2.approval_request_id, gw1.approval_request_id);
  assert.equal(gw2.idempotent_replay, true);

  // 8. Aprovar pedido e verificar alteração bancária bloqueada (403)
  const aprRes = await fetch(`${baseUrl}/api/approvals/${gw1.approval_request_id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ decision: 'Aprovado', justification: 'Validado pela direção.' }),
  });
  assert.equal(aprRes.status, 200);

  const bankRes = await fetch(`${baseUrl}/api/v1/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${createdAgent.issued_api_key}`,
    },
    body: JSON.stringify({
      action_type: 'bank_details_update',
      description: 'Alterar IBAN do fornecedor',
    }),
  });
  assert.equal(bankRes.status, 403);

  // 9. Administração da Plataforma (apenas metadados de ligação via demo OWNER platform admin)
  const demoOwnerRes = await fetch(`${baseUrl}/api/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'OWNER' }),
  });
  const demoOwner = (await demoOwnerRes.json()) as { token: string };
  const platRes = await fetch(`${baseUrl}/api/platform/tenants`, {
    headers: { Authorization: `Bearer ${demoOwner.token}` },
  });
  assert.equal(platRes.status, 200);
  const platJson = (await platRes.json()) as { tenants: Array<{ company_name: string; verified_google_email: string }> };
  assert.ok(platJson.tenants.some((t) => t.company_name === 'NovaTech Lda' && t.verified_google_email === 'bd@novatech.pt'));

  // 10. Desligar conta Google e confirmar que o dashboard volta a devolver 503
  const discRes = await fetch(`${baseUrl}/api/company/sheets/disconnect`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(discRes.status, 200);

  const dashDisconnected = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(dashDisconnected.status, 503);
});
