import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockGoogleApiTransport } from './mockGoogleTransport.ts';
import {
  clearAllTenantCachesForTests,
  completeOAuthCodeCallback,
  createNewSpreadsheetForTenant,
  getTenantDatabase,
  GoogleSheetsError,
  initDatabasePlatform,
  invalidateTenantCache,
  resetRegistryCacheForTests,
  setGoogleApiTransport,
  setGoogleRetryBaseDelayForTests,
  startCompanyGoogleOAuthFlow,
} from './database/databaseManager.ts';
import { createTenantRecord } from './database/tenantRegistry.ts';
import { executeSerializedMultiSheetWrite } from './database/repositories/baseRepository.ts';
import { ALL_WORKSHEET_NAMES, WORKSHEET_NAMES } from './database/sheetSchema.ts';
import { getTenantOAuthSecret } from './database/secretManager.ts';

let tempDir = '';
let mockTransport: MockGoogleApiTransport;
let companyId = '';
let spreadsheetId = '';

test.beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandato-sdb-'));
  process.env.MANDATO_CONTROL_PLANE_DIR = tempDir;
  process.env.MANDATO_MASTER_ENCRYPTION_KEY = 'mandato-sdb-test-master-key-32b';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'mock-cid';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'mock-csec';
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/company/sheets/oauth/callback';

  resetRegistryCacheForTests();
  clearAllTenantCachesForTests();
  setGoogleRetryBaseDelayForTests(0);
  mockTransport = new MockGoogleApiTransport();
  setGoogleApiTransport(mockTransport);
  initDatabasePlatform();

  const tenant = createTenantRecord({
    companyName: 'Sigma Engenharia',
    slug: 'sigma-eng',
    nif: '509333444',
    ownerUserId: 'usr-sigma',
  });
  companyId = tenant.company_id;
  const flow = startCompanyGoogleOAuthFlow({
    companyId,
    userId: 'usr-sigma',
    enteredGoogleEmail: 'db@sigma.pt',
  });
  mockTransport.registerAuthCode('code-sigma', 'db@sigma.pt', 'tok-sigma', 'ref-sigma');
  await completeOAuthCodeCallback({ state: flow.state, code: 'code-sigma' });
  const created = await createNewSpreadsheetForTenant({ companyId, actorUserId: 'usr-sigma' });
  spreadsheetId = created.metadata.spreadsheetId;
});

test.afterEach(() => {
  setGoogleApiTransport(null);
  clearAllTenantCachesForTests();
  resetRegistryCacheForTests();
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('16-17. Serialização RAW preserva fórmulas/zeros e CRUD completo funciona em todas as entidades principais', async () => {
  const db = await getTenantDatabase(companyId);

  // Política com texto que parece fórmula (=SUM...) para garantir modo RAW sem injeção/corrupção
  const pol = await db.policies.createPolicy({
    name: '=SUM(A1:A5) 00123',
    description: 'Teste RAW e zeros à esquerda 0045',
    actionType: 'purchase_order',
    ruleType: 'financial_threshold',
    maxAutoAmount: 300,
    maxApprovalAmount: 900,
    isAbsoluteRestriction: false,
  });

  const { agent } = await db.agents.createAgent({
    name: 'Agente Sigma',
    description: '007 Operacional',
    category: 'Compras',
    objective: 'Automatizar compras',
    origin: 'EXTERNAL',
    provider: 'Google Gemini',
    model: 'gemini-4-hydrogen',
    externalIdentifier: '00123-ext',
    status: 'active',
    avatarIcon: 'bot',
    instructions: {
      role: 'Comprador',
      objective: 'Compras',
      responsibilities: ['Comparar preços'],
      behaviour: 'Rigoroso',
      communication_style: 'Formal',
      rules: [],
      restrictions: [],
      expected_output: 'JSON',
    },
    permissionsSummary: {
      read_permissions: ['suppliers'],
      write_permissions: [],
      max_auto_financial_limit_eur: 300,
      max_approval_financial_limit_eur: 900,
      allowed_resources: [],
      restricted_resources: [],
      actions_requiring_approval: ['purchase_order'],
      always_blocked_actions: [],
    },
    policyIds: [pol.id],
    selectedTools: [{ tool_key: 'submeter_encomenda', is_enabled: true, requires_approval: true }],
    createdBy: 'usr-sigma',
  });

  const wfId = await db.workflows.createWorkflow({
    name: 'Fluxo Sigma',
    description: 'Teste CRUD',
    status: 'active',
    nodes: [
      { id: 'n1', node_type: 'start', label: 'Início' },
      { id: 'n2', node_type: 'end', label: 'Fim' },
    ],
    edges: [{ source_node_id: 'n1', target_node_id: 'n2' }],
  });

  const rec = await db.approvals.recordAuthorizationAndOptionalApproval({
    agentId: agent.id,
    actionType: 'purchase_order',
    toolName: 'submeter_encomenda',
    description: 'Compra €450',
    amount: 450,
    currency: 'EUR',
    resourceId: 'po-1',
    idempotencyKey: 'idem-raw-1',
    decision: 'REQUIRES_APPROVAL',
    reason: 'Acima do limite automático',
    policyId: pol.id,
    policyName: pol.name,
    riskLevel: 'medium',
    isSimulation: false,
    createApproval: true,
  });

  await db.audit.appendAuditEvent({
    actorType: 'agent',
    actorId: agent.id,
    actorName: agent.name,
    eventType: 'authorization_decision',
    action: 'Compra €450',
    result: 'REQUIRES_APPROVAL',
    reason: 'Teste CRUD',
  });

  // Limpar cache para forçar leitura fresca da folha Google Sheets
  invalidateTenantCache(companyId);

  const loadedPolicy = await db.policies.getPolicyById(pol.id);
  assert.equal(loadedPolicy?.name, '=SUM(A1:A5) 00123');

  const loadedAgent = await db.agents.getAgentById(agent.id);
  assert.equal(loadedAgent?.external_identifier, '00123-ext');
  assert.equal(loadedAgent?.policies?.length, 1);

  const loadedWf = await db.workflows.getWorkflowById(wfId);
  assert.equal(loadedWf?.nodes.length, 2);

  const loadedApproval = await db.approvals.getApprovalById(rec.approvalRequestId!);
  assert.equal(loadedApproval?.financial_value, 450);

  const logs = await db.audit.listAuditLogs();
  assert.equal(logs.length, 1);
});

test('18. Quota 429 transitório faz retry e sucede; 429 persistente lança GoogleSheetsError QUOTA_EXCEEDED', async () => {
  const db = await getTenantDatabase(companyId);

  // 2 erros 429 transitórios seguidos de sucesso
  mockTransport.injectNextError(429, { error: { message: 'Quota exceeded' } });
  mockTransport.injectNextError(429, { error: { message: 'Rate limit exceeded' } });

  const pol = await db.policies.createPolicy({
    name: 'Política Retry OK',
    description: 'Teste retry',
    actionType: 'read_info',
    ruleType: 'allow_if_verified',
    maxAutoAmount: null,
    maxApprovalAmount: null,
    isAbsoluteRestriction: false,
  });
  assert.equal(pol.name, 'Política Retry OK');

  // 5 erros 429 consecutivos excedem maxRetries (3) e propagam QUOTA_EXCEEDED
  for (let i = 0; i < 5; i++) {
    mockTransport.injectNextError(429, { error: { message: 'Quota exceeded persistently' } });
  }
  await assert.rejects(
    () =>
      db.audit.appendAuditEvent({
        actorType: 'system',
        actorId: 'sys',
        actorName: 'Sistema',
        eventType: 'test',
        action: 'Falha quota',
        result: 'Erro',
        reason: 'Teste 429',
      }),
    (err: unknown) => err instanceof GoogleSheetsError && err.code === 'QUOTA_EXCEEDED'
  );
});

test('19. AuditLogs é estritamente append-only sem métodos de atualização ou eliminação', async () => {
  const db = await getTenantDatabase(companyId);
  const protoMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(db.audit));
  assert.equal(protoMethods.includes('update'), false);
  assert.equal(protoMethods.includes('delete'), false);
  assert.equal(protoMethods.includes('deleteAuditLog'), false);

  await db.audit.appendAuditEvent({
    actorType: 'system',
    actorId: 'sys-1',
    actorName: 'Sistema',
    eventType: 'audit_1',
    action: 'Evento A',
    result: 'OK',
    reason: 'Append-only 1',
  });
  await db.audit.appendAuditEvent({
    actorType: 'system',
    actorId: 'sys-2',
    actorName: 'Sistema',
    eventType: 'audit_2',
    action: 'Evento B',
    result: 'OK',
    reason: 'Append-only 2',
  });

  invalidateTenantCache(companyId);
  const logs = await db.audit.listAuditLogs();
  assert.equal(logs.length, 2);
});

test('20. Lock serializado por empresa evita perda de atualizações em escritas concorrentes', async () => {
  const db = await getTenantDatabase(companyId);
  await Promise.all(
    Array.from({ length: 6 }, (_, idx) =>
      db.audit.appendAuditEvent({
        actorType: 'system',
        actorId: `sys-${idx}`,
        actorName: 'Sistema',
        eventType: 'concurrent_write',
        action: `Evento ${idx}`,
        result: 'OK',
        reason: 'Concorrência',
      })
    )
  );

  invalidateTenantCache(companyId);
  const logs = await db.audit.listAuditLogs();
  assert.equal(logs.length, 6);
});

test('21. Rollback compensatório em escrita multi-aba restaura estado em caso de falha intermédia', async () => {
  const sheetBefore = mockTransport.spreadsheets.get(spreadsheetId)!;
  const policiesTabBefore = sheetBefore.sheets.find((s) => s.title === WORKSHEET_NAMES.Policies)!;
  const rowsCountBefore = policiesTabBefore.rows.length;

  // Simular falha definitiva (400 não retryable) quando tentar escrever na segunda aba (AuditLogs)
  mockTransport.injectNextError(
    400,
    { error: { message: 'Simulated write failure on AuditLogs' } },
    /AuditLogs.*:append/
  );

  await assert.rejects(() =>
    executeSerializedMultiSheetWrite(companyId, [
      {
        worksheet: WORKSHEET_NAMES.Policies,
        inserts: [
          {
            id: 'pol-rollback-1',
            company_id: companyId,
            name: 'Deve Ser Revertida',
            description: 'Rollback',
            action_type: 'purchase_order',
            rule_type: 'require_approval',
            max_auto_amount: '',
            max_approval_amount: '',
            currency: 'EUR',
            conditions_json: '{}',
            is_absolute_restriction: false,
            status: 'active',
            is_demo: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      },
      {
        worksheet: WORKSHEET_NAMES.AuditLogs,
        inserts: [
          {
            id: 'aud-rollback-1',
            company_id: companyId,
            actor_type: 'system',
            actor_id: 'sys',
            actor_name: 'Sistema',
            event_type: 'fail',
            action: 'fail',
            result: 'fail',
            reason: 'fail',
            related_policy: '',
            metadata_json: '{}',
            is_demo: false,
            created_at: new Date().toISOString(),
          },
        ],
      },
    ])
  );

  // O registo inserido na primeira aba foi removido pela compensação
  assert.equal(policiesTabBefore.rows.length, rowsCountBefore);
});

test('22. Segredos e credenciais nunca são guardados em texto simples no registry nem no cofre', async () => {
  const registryRaw = fs.readFileSync(path.join(tempDir, 'registry.json'), 'utf8');
  const vaultRaw = fs.readFileSync(path.join(tempDir, 'secrets.vault.json'), 'utf8');

  assert.equal(registryRaw.includes('tok-sigma'), false);
  assert.equal(registryRaw.includes('ref-sigma'), false);
  assert.equal(vaultRaw.includes('tok-sigma'), false);
  assert.equal(vaultRaw.includes('ref-sigma'), false);

  const decrypted = getTenantOAuthSecret(`vault://mandato/oauth/${companyId}`);
  assert.equal(decrypted?.access_token, 'tok-sigma');
  assert.equal(ALL_WORKSHEET_NAMES.length, 20);
});
