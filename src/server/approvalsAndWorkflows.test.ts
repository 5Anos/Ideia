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
  setGoogleApiTransport,
  setGoogleRetryBaseDelayForTests,
  startCompanyGoogleOAuthFlow,
} from './database/databaseManager.ts';
import {
  addCompanyMembership,
  createPlatformUser,
  createTenantRecord,
} from './database/tenantRegistry.ts';
import { hashPassword, signSessionToken } from './security.ts';
import { createApiRouter } from './routes.ts';

let tempDir = '';
let mockTransport: MockGoogleApiTransport;
let server: http.Server;
let baseUrl = '';

let companyId = '';
let ownerToken = '';
let approverToken = '';
let operatorToken = '';
let viewerToken = '';
let ownerUserId = '';

test.beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandato-aprwf-'));
  process.env.MANDATO_CONTROL_PLANE_DIR = tempDir;
  process.env.MANDATO_MASTER_ENCRYPTION_KEY = 'mandato-aprwf-test-master-key-32';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'mock-cid';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'mock-csec';
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/company/sheets/oauth/callback';

  resetRegistryCacheForTests();
  clearAllTenantCachesForTests();
  setGoogleRetryBaseDelayForTests(0);
  mockTransport = new MockGoogleApiTransport();
  setGoogleApiTransport(mockTransport);
  initDatabasePlatform();

  const owner = createPlatformUser({
    email: 'owner@omega.pt',
    passwordHash: hashPassword('Pass2026!'),
    fullName: 'Owner Omega',
    jobTitle: 'CEO',
  });
  ownerUserId = owner.id;
  const approver = createPlatformUser({
    email: 'approver@omega.pt',
    passwordHash: hashPassword('Pass2026!'),
    fullName: 'Approver Omega',
    jobTitle: 'CFO',
  });
  const operator = createPlatformUser({
    email: 'operator@omega.pt',
    passwordHash: hashPassword('Pass2026!'),
    fullName: 'Operator Omega',
    jobTitle: 'Ops',
  });
  const viewer = createPlatformUser({
    email: 'viewer@omega.pt',
    passwordHash: hashPassword('Pass2026!'),
    fullName: 'Viewer Omega',
    jobTitle: 'Auditor',
  });

  const tenant = createTenantRecord({
    companyName: 'Omega SA',
    slug: 'omega-sa',
    nif: '509555666',
    ownerUserId: owner.id,
  });
  companyId = tenant.company_id;

  addCompanyMembership({ companyId, userId: owner.id, role: 'OWNER', status: 'active' });
  addCompanyMembership({ companyId, userId: approver.id, role: 'APPROVER', status: 'active' });
  addCompanyMembership({ companyId, userId: operator.id, role: 'OPERATOR', status: 'active' });
  addCompanyMembership({ companyId, userId: viewer.id, role: 'VIEWER', status: 'active' });

  ownerToken = signSessionToken(owner.id, companyId);
  approverToken = signSessionToken(approver.id, companyId);
  operatorToken = signSessionToken(operator.id, companyId);
  viewerToken = signSessionToken(viewer.id, companyId);

  const flow = startCompanyGoogleOAuthFlow({
    companyId,
    userId: owner.id,
    enteredGoogleEmail: 'db@omega.pt',
  });
  mockTransport.registerAuthCode('code-omega', 'db@omega.pt', 'tok-omega', 'ref-omega');
  await completeOAuthCodeCallback({ state: flow.state, code: 'code-omega' });
  await createNewSpreadsheetForTenant({ companyId, actorUserId: owner.id });

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

test('30-33. Idempotência de pedidos, expiração, bloqueio de auto-aprovação/restrição absoluta e RBAC em /decide', async () => {
  const db = await getTenantDatabase(companyId);
  const pol = await db.policies.createPolicy({
    name: 'Compras Omega',
    description: 'Regra',
    actionType: 'purchase_order',
    ruleType: 'financial_threshold',
    maxAutoAmount: 100,
    maxApprovalAmount: 1000,
    isAbsoluteRestriction: false,
  });
  const createAgentRes = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      name: 'Agente Compras Omega',
      description: 'Compras',
      category: 'Compras',
      objective: 'Testar aprovações',
      origin: 'EXTERNAL',
      status: 'active',
      policy_ids: [pol.id],
    }),
  });
  assert.equal(createAgentRes.status, 201);
  const { agent, issued_api_key: rawApiKey } = (await createAgentRes.json()) as {
    agent: { id: string };
    issued_api_key: string;
  };

  // 30. Gateway com mesma idempotency_key devolve mesmo approval_request_id sem duplicar
  const gw1 = await fetch(`${baseUrl}/api/v1/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawApiKey}` },
    body: JSON.stringify({
      action_type: 'purchase_order',
      description: 'Pedido único',
      amount: 400,
      idempotency_key: 'idem-unique-1',
    }),
  });
  assert.equal(gw1.status, 200);
  const g1 = (await gw1.json()) as { approval_request_id: string };
  assert.ok(g1.approval_request_id);
  const gw2 = await fetch(`${baseUrl}/api/v1/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawApiKey}` },
    body: JSON.stringify({
      action_type: 'purchase_order',
      description: 'Pedido único',
      amount: 400,
      idempotency_key: 'idem-unique-1',
    }),
  });
  assert.equal(gw2.status, 200);
  const g2 = (await gw2.json()) as { approval_request_id: string; idempotent_replay: boolean };
  assert.equal(g1.approval_request_id, g2.approval_request_id);
  assert.equal(g2.idempotent_replay, true);

  // 33. OPERATOR e VIEWER não podem aprovar/rejeitar (403)
  for (const deniedToken of [operatorToken, viewerToken]) {
    const res = await fetch(`${baseUrl}/api/approvals/${g1.approval_request_id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deniedToken}` },
      body: JSON.stringify({ decision: 'Aprovado', justification: 'Tentativa não autorizada' }),
    });
    assert.equal(res.status, 403);
  }

  // APPROVER aprova com sucesso (200); segunda decisão no mesmo pedido falha com 409
  const okApr = await fetch(`${baseUrl}/api/approvals/${g1.approval_request_id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${approverToken}` },
    body: JSON.stringify({ decision: 'Aprovado', justification: 'Orçamento validado' }),
  });
  assert.equal(okApr.status, 200);

  const dupApr = await fetch(`${baseUrl}/api/approvals/${g1.approval_request_id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${approverToken}` },
    body: JSON.stringify({ decision: 'Rejeitado', justification: 'Duplicado' }),
  });
  assert.equal(dupApr.status, 409);

  // 31. Pedido expirado transita para Expirado e não pode ser decidido
  const expRec = await db.approvals.recordAuthorizationAndOptionalApproval({
    agentId: agent.id,
    actionType: 'purchase_order',
    toolName: null,
    description: 'Pedido expirado',
    amount: 350,
    currency: 'EUR',
    resourceId: null,
    idempotencyKey: null,
    decision: 'REQUIRES_APPROVAL',
    reason: 'Teste expiração',
    policyId: pol.id,
    policyName: pol.name,
    riskLevel: 'medium',
    isSimulation: false,
    createApproval: true,
    expiresInHours: -2,
  });
  const listBefore = await db.approvals.listApprovalRequests();
  assert.equal(listBefore.find((a) => a.id === expRec.approvalRequestId)?.status, 'Expirado');
  const expDecide = await fetch(`${baseUrl}/api/approvals/${expRec.approvalRequestId}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${approverToken}` },
    body: JSON.stringify({ decision: 'Aprovado', justification: 'Tarde demais' }),
  });
  assert.equal(expDecide.status, 409);

  // 32. Auto-aprovação (quando actor user_id === approval.agent_id) e ações absolutas são bloqueadas (403)
  const selfRec = await db.approvals.recordAuthorizationAndOptionalApproval({
    agentId: ownerUserId,
    actionType: 'purchase_order',
    toolName: null,
    description: 'Pedido próprio',
    amount: 250,
    currency: 'EUR',
    resourceId: null,
    idempotencyKey: null,
    decision: 'REQUIRES_APPROVAL',
    reason: 'Auto-aprovação teste',
    policyId: pol.id,
    policyName: pol.name,
    riskLevel: 'medium',
    isSimulation: false,
    createApproval: true,
  });
  const selfAprRes = await fetch(`${baseUrl}/api/approvals/${selfRec.approvalRequestId}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ decision: 'Aprovado', justification: 'Tentar auto-aprovar' }),
  });
  assert.equal(selfAprRes.status, 403);

  const absRec = await db.approvals.recordAuthorizationAndOptionalApproval({
    agentId: agent.id,
    actionType: 'bank_details_update',
    toolName: null,
    description: 'Alterar IBAN',
    amount: null,
    currency: 'EUR',
    resourceId: null,
    idempotencyKey: null,
    decision: 'REQUIRES_APPROVAL',
    reason: 'Tentativa forçada',
    policyId: null,
    policyName: 'Absoluta',
    riskLevel: 'critical',
    isSimulation: false,
    createApproval: true,
  });
  const absDecide = await fetch(`${baseUrl}/api/approvals/${absRec.approvalRequestId}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ decision: 'Aprovado', justification: 'Não deve permitir' }),
  });
  assert.equal(absDecide.status, 403);
});

test('34-38. Grafo de Workflow: condição true/false, pausa human_approval, retoma Aprovado/Rejeitado e fluxo suspenso bloqueado', async () => {
  const db = await getTenantDatabase(companyId);
  const wfId = await db.workflows.createWorkflow({
    name: 'Fluxo Condicional Compras',
    description: 'Valida valor > 300 EUR e exige aprovação humana',
    status: 'active',
    nodes: [
      { id: 'n_start', node_type: 'start', label: 'Início', position_x: 0 },
      {
        id: 'n_cond',
        node_type: 'condition',
        label: 'Valor > €300?',
        config: { condition_expression: 'amount > 300' },
        position_x: 150,
      },
      {
        id: 'n_apr',
        node_type: 'human_approval',
        label: 'Aprovação Direção',
        config: { action_type: 'purchase_order' },
        position_x: 300,
      },
      {
        id: 'n_notif_ok',
        node_type: 'notification',
        label: 'Notificar Execução',
        config: { recipient: 'compras@omega.pt', description: 'Encomenda aprovada' },
        position_x: 450,
      },
      {
        id: 'n_notif_rej',
        node_type: 'notification',
        label: 'Notificar Rejeição',
        config: { recipient: 'solicitante@omega.pt', description: 'Encomenda rejeitada' },
        position_x: 450,
      },
      { id: 'n_end_fast', node_type: 'end', label: 'Conclusão Automática', position_x: 300 },
      { id: 'n_end_final', node_type: 'end', label: 'Fim', position_x: 600 },
    ],
    edges: [
      { source_node_id: 'n_start', target_node_id: 'n_cond' },
      { source_node_id: 'n_cond', target_node_id: 'n_apr', condition_label: 'true' },
      { source_node_id: 'n_cond', target_node_id: 'n_end_fast', condition_label: 'false' },
      { source_node_id: 'n_apr', target_node_id: 'n_notif_ok', condition_label: 'Aprovado' },
      { source_node_id: 'n_apr', target_node_id: 'n_notif_rej', condition_label: 'Rejeitado' },
      { source_node_id: 'n_notif_ok', target_node_id: 'n_end_final' },
      { source_node_id: 'n_notif_rej', target_node_id: 'n_end_final' },
    ],
  });

  // 34. Ramo false (valor <= 300): conclui direto no ramo automático
  const fastRes = await fetch(`${baseUrl}/api/workflows/${wfId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ amount: 180, input_summary: 'Compra €180' }),
  });
  assert.equal(fastRes.status, 200);
  const fastJson = (await fastRes.json()) as { status: string; steps_log: Array<{ label: string }> };
  assert.equal(fastJson.status, 'completed');
  assert.ok(fastJson.steps_log.some((s) => s.label === 'Conclusão Automática'));

  // 35. Ramo true (valor > 300): pausa em human_approval
  const pauseRes1 = await fetch(`${baseUrl}/api/workflows/${wfId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ amount: 550, input_summary: 'Compra €550 Aprovada' }),
  });
  const pauseJson1 = (await pauseRes1.json()) as {
    execution_id: string;
    status: string;
    approval_request_id: string;
  };
  assert.equal(pauseJson1.status, 'awaiting_approval');
  assert.ok(pauseJson1.approval_request_id);

  // 36. Aprovação retoma fluxo pelo ramo "Aprovado" até completed
  const aprResumeRes = await fetch(`${baseUrl}/api/approvals/${pauseJson1.approval_request_id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${approverToken}` },
    body: JSON.stringify({ decision: 'Aprovado', justification: 'Aprovado pela CFO' }),
  });
  const aprResumeJson = (await aprResumeRes.json()) as {
    status: string;
    workflow_resumed: { execution_id: string; status: string };
  };
  assert.equal(aprResumeJson.status, 'Aprovado');
  assert.equal(aprResumeJson.workflow_resumed.status, 'completed');

  const execAfterApprove = await db.workflows.getExecutionById(pauseJson1.execution_id);
  assert.ok(execAfterApprove?.steps_log.some((s) => s.label === 'Notificar Execução'));

  // 37. Rejeição retoma fluxo pelo ramo "Rejeitado"
  const pauseRes2 = await fetch(`${baseUrl}/api/workflows/${wfId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ amount: 720, input_summary: 'Compra €720 Rejeitada' }),
  });
  const pauseJson2 = (await pauseRes2.json()) as {
    execution_id: string;
    approval_request_id: string;
  };
  const rejResumeRes = await fetch(`${baseUrl}/api/approvals/${pauseJson2.approval_request_id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${approverToken}` },
    body: JSON.stringify({ decision: 'Rejeitado', justification: 'Fora do orçamento' }),
  });
  assert.equal(rejResumeRes.status, 200);
  const execAfterReject = await db.workflows.getExecutionById(pauseJson2.execution_id);
  assert.ok(execAfterReject?.steps_log.some((s) => s.label === 'Notificar Rejeição'));

  // 38. Fluxo suspenso é recusado com 400
  await fetch(`${baseUrl}/api/workflows/${wfId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ status: 'suspended' }),
  });
  const suspExec = await fetch(`${baseUrl}/api/workflows/${wfId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ amount: 100, input_summary: 'Tentar executar suspenso' }),
  });
  assert.equal(suspExec.status, 400);
});
