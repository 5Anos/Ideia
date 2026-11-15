import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDbPath = path.join(os.tmpdir(), `mandato-test-${Date.now()}.db`);
process.env.MANDATO_DB_PATH = tempDbPath;

let server: http.Server;
let baseUrl = '';
let dbInstance: { close: () => void } | null = null;

test.before(async () => {
  const { initDatabase, db } = await import('./db');
  const { createApiRouter } = await import('./routes');
  dbInstance = db;
  initDatabase();
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
  if (dbInstance) {
    dbInstance.close();
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${tempDbPath}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

test('Demo login, isolamento multi-empresa e controlo RBAC', async () => {
  // 1. Login como OWNER da Empresa Demonstração
  const ownerRes = await fetch(`${baseUrl}/api/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'OWNER' }),
  });
  assert.equal(ownerRes.status, 200);
  const ownerData = (await ownerRes.json()) as { token: string; user: { company_id: string } };
  assert.ok(ownerData.token);

  // 2. Registar nova empresa isolada
  const uniqueEmail = `teste.${Date.now()}@novatech.pt`;
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      full_name: 'Carlos Mendes',
      email: uniqueEmail,
      password: 'PasswordSegura2026!',
      company_name: 'NovaTech Lda',
      nif: '508999111',
    }),
  });
  assert.equal(regRes.status, 201);
  const regData = (await regRes.json()) as { token: string; user: { company_id: string } };
  assert.notEqual(regData.user.company_id, ownerData.user.company_id);

  // 3. Verificar que NovaTech não vê os agentes da Empresa Demonstração
  const agentsRes = await fetch(`${baseUrl}/api/agents`, {
    headers: { Authorization: `Bearer ${regData.token}` },
  });
  const agentsJson = (await agentsRes.json()) as { agents: unknown[] };
  assert.equal(agentsJson.agents.length, 0);

  // 4. Verificar que VIEWER não pode criar agentes
  const viewerRes = await fetch(`${baseUrl}/api/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'VIEWER' }),
  });
  const viewerData = (await viewerRes.json()) as { token: string };
  const forbiddenCreate = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${viewerData.token}`,
    },
    body: JSON.stringify({ name: 'Teste', description: 'Teste' }),
  });
  assert.equal(forbiddenCreate.status, 403);
});

test('Criação de agente externo, gateway /api/v1/authorize, idempotência e aprovação humana', async () => {
  const ownerRes = await fetch(`${baseUrl}/api/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'OWNER' }),
  });
  const { token } = (await ownerRes.json()) as { token: string };

  // Criar agente externo com política de compras da demo
  const createRes = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      name: 'Agente ERP Externo Teste',
      description: 'Agente externo para testes de integração',
      category: 'Compras',
      objective: 'Testar gateway de autorização',
      origin: 'EXTERNAL',
      provider: 'Google Gemini',
      model: 'gemini-4-hydrogen',
      external_identifier: 'ext-test-01',
      status: 'active',
      policy_ids: ['pol-demo-1', 'pol-demo-3'],
      tools: [{ tool_key: 'submeter_encomenda', is_enabled: true, requires_approval: true }],
    }),
  });
  assert.equal(createRes.status, 201);
  const created = (await createRes.json()) as { agent: { id: string }; issued_api_key: string };
  assert.ok(created.issued_api_key.startsWith('mdt_ext_'));

  // Chamar gateway com compra €500 (deve devolver REQUIRES_APPROVAL)
  const idemKey = `idem_${Date.now()}`;
  const gwRes1 = await fetch(`${baseUrl}/api/v1/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${created.issued_api_key}`,
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
  const gwJson1 = (await gwRes1.json()) as { decision: string; approval_request_id: string };
  assert.equal(gwJson1.decision, 'REQUIRES_APPROVAL');
  assert.ok(gwJson1.approval_request_id);

  // Repetir com mesma idempotency_key -> mesmo approval_request_id sem duplicar
  const gwRes2 = await fetch(`${baseUrl}/api/v1/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${created.issued_api_key}`,
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
  const gwJson2 = (await gwRes2.json()) as { approval_request_id: string; idempotent_replay: boolean };
  assert.equal(gwJson2.approval_request_id, gwJson1.approval_request_id);
  assert.equal(gwJson2.idempotent_replay, true);

  // Gestor aprova o pedido
  const aprRes = await fetch(`${baseUrl}/api/approvals/${gwJson1.approval_request_id}/decide`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      decision: 'Aprovado',
      justification: 'Equipamento validado no orçamento anual.',
    }),
  });
  assert.equal(aprRes.status, 200);
  const aprJson = (await aprRes.json()) as { status: string };
  assert.equal(aprJson.status, 'Aprovado');

  // Chamar gateway para alteração bancária -> BLOCKED (403)
  const bankRes = await fetch(`${baseUrl}/api/v1/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${created.issued_api_key}`,
    },
    body: JSON.stringify({
      action_type: 'bank_details_update',
      description: 'Alterar IBAN do fornecedor',
    }),
  });
  assert.equal(bankRes.status, 403);
  const bankJson = (await bankRes.json()) as { decision: string };
  assert.equal(bankJson.decision, 'BLOCKED');
});

test('Execução de fluxo de trabalho respeita motor de autorizações', async () => {
  const ownerRes = await fetch(`${baseUrl}/api/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'OWNER' }),
  });
  const { token } = (await ownerRes.json()) as { token: string };

  const execRes = await fetch(`${baseUrl}/api/workflows/wf-demo-compras/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      amount: 500,
      input_summary: 'Teste fluxo €500',
    }),
  });
  assert.equal(execRes.status, 200);
  const execJson = (await execRes.json()) as { status: string; steps_log: unknown[] };
  assert.equal(execJson.status, 'awaiting_approval');
  assert.ok(execJson.steps_log.length >= 2);
});
