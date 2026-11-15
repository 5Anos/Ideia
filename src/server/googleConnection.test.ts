import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockGoogleApiTransport } from './mockGoogleTransport.ts';
import {
  clearAllTenantCachesForTests,
  completeOAuthBridgeLogin,
  completeOAuthCodeCallback,
  createNewSpreadsheetForTenant,
  disconnectTenantGoogleAccount,
  getTenantDatabase,
  GoogleSheetsError,
  initDatabasePlatform,
  resetRegistryCacheForTests,
  selectExistingSpreadsheetForTenant,
  setGoogleApiTransport,
  setGoogleRetryBaseDelayForTests,
  startCompanyGoogleOAuthFlow,
  TenantDatabaseNotConnectedError,
  testTenantSheetsConnection,
} from './database/databaseManager.ts';
import {
  createTenantRecord,
  getTenantById,
  updateTenantRecord,
} from './database/tenantRegistry.ts';
import { getTenantOAuthSecret, storeTenantOAuthSecret } from './database/secretManager.ts';
import { ALL_WORKSHEET_NAMES, WORKSHEET_HEADERS } from './database/sheetSchema.ts';

let tempDir = '';
let mockTransport: MockGoogleApiTransport;

test.beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandato-gconn-'));
  process.env.MANDATO_CONTROL_PLANE_DIR = tempDir;
  process.env.MANDATO_MASTER_ENCRYPTION_KEY = 'mandato-test-master-key-32bytes!';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'mock-client-id';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'mock-client-secret';
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/company/sheets/oauth/callback';

  resetRegistryCacheForTests();
  clearAllTenantCachesForTests();
  setGoogleRetryBaseDelayForTests(0);
  mockTransport = new MockGoogleApiTransport();
  setGoogleApiTransport(mockTransport);
  initDatabasePlatform();
});

test.afterEach(() => {
  setGoogleApiTransport(null);
  clearAllTenantCachesForTests();
  resetRegistryCacheForTests();
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('1-2. Fluxo OAuth Code + PKCE gera state, troca código, cifra tokens no cofre e verifica email', async () => {
  const tenant = createTenantRecord({
    companyName: 'Alfa Logística Lda',
    slug: 'alfa-logistica',
    nif: '501234567',
    ownerUserId: 'usr-alfa',
  });

  const flow = startCompanyGoogleOAuthFlow({
    companyId: tenant.company_id,
    userId: 'usr-alfa',
    enteredGoogleEmail: 'dados@alfalogistica.pt',
  });
  assert.equal(flow.mode, 'authorization_code_pkce');
  assert.ok(flow.authUrl?.includes('code_challenge_method=S256'));
  assert.ok(flow.state);

  mockTransport.registerAuthCode('auth-code-123', 'dados@alfalogistica.pt', 'tok-alfa-1', 'ref-alfa-1');
  const cbRes = await completeOAuthCodeCallback({ state: flow.state, code: 'auth-code-123' });

  assert.equal(cbRes.verifiedEmail, 'dados@alfalogistica.pt');
  assert.equal(cbRes.emailMismatchWarning, false);

  const updated = getTenantById(tenant.company_id)!;
  assert.equal(updated.verified_google_email, 'dados@alfalogistica.pt');
  assert.ok(updated.secret_reference);

  const vaultRaw = fs.readFileSync(path.join(tempDir, 'secrets.vault.json'), 'utf8');
  assert.equal(vaultRaw.includes('tok-alfa-1'), false, 'Access token nunca pode ser guardado em texto simples');
  assert.equal(vaultRaw.includes('ref-alfa-1'), false, 'Refresh token nunca pode ser guardado em texto simples');

  const decrypted = getTenantOAuthSecret(updated.secret_reference);
  assert.equal(decrypted?.access_token, 'tok-alfa-1');
  assert.equal(decrypted?.refresh_token, 'ref-alfa-1');
});

test('3. State OAuth inválido, expirado ou reutilizado é rejeitado', async () => {
  const tenant = createTenantRecord({
    companyName: 'Beta Consultoria',
    slug: 'beta-consult',
    nif: '502345678',
    ownerUserId: 'usr-beta',
  });

  const flow = startCompanyGoogleOAuthFlow({
    companyId: tenant.company_id,
    userId: 'usr-beta',
    enteredGoogleEmail: 'ops@beta.pt',
  });

  mockTransport.registerAuthCode('code-once', 'ops@beta.pt', 'tok-once', 'ref-once');
  await completeOAuthCodeCallback({ state: flow.state, code: 'code-once' });

  // Reutilização do mesmo state falha
  await assert.rejects(
    () => completeOAuthCodeCallback({ state: flow.state, code: 'code-once' }),
    /Estado OAuth inválido/i
  );

  // State inexistente na bridge falha
  await assert.rejects(
    () =>
      completeOAuthBridgeLogin({
        companyId: tenant.company_id,
        actorUserId: 'usr-beta',
        state: 'forged-state',
        accessToken: 'tok-once',
      }),
    /Estado de segurança OAuth inválido/i
  );
});

test('4. Divergência entre email indicado e email verificado gera aviso explícito', async () => {
  const tenant = createTenantRecord({
    companyName: 'Gama Energia SA',
    slug: 'gama-energia',
    nif: '503456789',
    ownerUserId: 'usr-gama',
  });

  const flow = startCompanyGoogleOAuthFlow({
    companyId: tenant.company_id,
    userId: 'usr-gama',
    enteredGoogleEmail: 'esperado@gama.pt',
  });

  mockTransport.registerAccessToken('tok-outro', 'pessoal@gmail.com');
  const bridge = await completeOAuthBridgeLogin({
    companyId: tenant.company_id,
    actorUserId: 'usr-gama',
    state: flow.state,
    accessToken: 'tok-outro',
  });

  assert.equal(bridge.emailMismatchWarning, true);
  assert.equal(bridge.verifiedEmail, 'pessoal@gmail.com');
  const updated = getTenantById(tenant.company_id)!;
  assert.equal(updated.email_mismatch_confirmed, false);
});

test('5. Criação de nova folha dedicada cria todas as 20 abas com cabeçalhos e marca Ligado', async () => {
  const tenant = createTenantRecord({
    companyName: 'Delta Retail Lda',
    slug: 'delta-retail',
    nif: '504567890',
    ownerUserId: 'usr-delta',
  });

  const flow = startCompanyGoogleOAuthFlow({
    companyId: tenant.company_id,
    userId: 'usr-delta',
    enteredGoogleEmail: 'db@deltaretail.pt',
  });
  mockTransport.registerAuthCode('code-delta', 'db@deltaretail.pt', 'tok-delta', 'ref-delta');
  await completeOAuthCodeCallback({ state: flow.state, code: 'code-delta' });

  const created = await createNewSpreadsheetForTenant({
    companyId: tenant.company_id,
    actorUserId: 'usr-delta',
  });

  assert.equal(created.tenant.connection_status, 'Ligado');
  assert.equal(created.tenant.schema_valid, true);
  assert.equal(created.metadata.title, 'MANDATO — Delta Retail Lda');
  assert.equal(created.metadata.sheets.length, ALL_WORKSHEET_NAMES.length);

  const mockSheet = mockTransport.spreadsheets.get(created.metadata.spreadsheetId)!;
  assert.ok(mockSheet);
  for (const ws of ALL_WORKSHEET_NAMES) {
    const tab = mockSheet.sheets.find((t) => t.title === ws);
    assert.ok(tab, `Falta a aba ${ws}`);
    assert.deepEqual(tab.rows[0], [...WORKSHEET_HEADERS[ws]]);
  }
});

test('6. Folha incompleta fica em Estrutura inválida e initializeIfMissing cria apenas abas em falta', async () => {
  const tenant = createTenantRecord({
    companyName: 'Épsilon Indústria',
    slug: 'epsilon-ind',
    nif: '505678901',
    ownerUserId: 'usr-eps',
  });

  const flow = startCompanyGoogleOAuthFlow({
    companyId: tenant.company_id,
    userId: 'usr-eps',
    enteredGoogleEmail: 'sheets@epsilon.pt',
  });
  mockTransport.registerAuthCode('code-eps', 'sheets@epsilon.pt', 'tok-eps', 'ref-eps');
  await completeOAuthCodeCallback({ state: flow.state, code: 'code-eps' });

  mockTransport.seedCustomSpreadsheet({
    spreadsheetId: 'sheet-partial-123456',
    title: 'Folha Parcial',
    ownerEmail: 'sheets@epsilon.pt',
    tabs: [
      {
        title: 'CompanySettings',
        rows: [[...WORKSHEET_HEADERS.CompanySettings]],
      },
    ],
  });

  const check1 = await selectExistingSpreadsheetForTenant({
    companyId: tenant.company_id,
    actorUserId: 'usr-eps',
    spreadsheetId: 'sheet-partial-123456',
    initializeIfMissing: false,
  });
  assert.equal(check1.report.valid, false);
  assert.equal(check1.tenant.connection_status, 'Estrutura inválida');
  assert.equal(check1.report.missingWorksheets.length, ALL_WORKSHEET_NAMES.length - 1);

  const check2 = await selectExistingSpreadsheetForTenant({
    companyId: tenant.company_id,
    actorUserId: 'usr-eps',
    spreadsheetId: 'sheet-partial-123456',
    initializeIfMissing: true,
  });
  assert.equal(check2.report.valid, true);
  assert.equal(check2.tenant.connection_status, 'Ligado');
});

test('7-8. Acesso negado (403) / Folha removida (404) mapeia para Sem acesso à folha e teste de ligação diagnostica', async () => {
  const tenant = createTenantRecord({
    companyName: 'Zeta Serviços',
    slug: 'zeta-serv',
    nif: '506789012',
    ownerUserId: 'usr-zeta',
  });
  const flow = startCompanyGoogleOAuthFlow({
    companyId: tenant.company_id,
    userId: 'usr-zeta',
    enteredGoogleEmail: 'zeta@empresa.pt',
  });
  mockTransport.registerAuthCode('code-zeta', 'zeta@empresa.pt', 'tok-zeta', 'ref-zeta');
  await completeOAuthCodeCallback({ state: flow.state, code: 'code-zeta' });

  // Folha pertence a outro utilizador Google -> 403
  mockTransport.seedCustomSpreadsheet({
    spreadsheetId: 'sheet-other-user-999',
    title: 'Folha Alheia',
    ownerEmail: 'outro@terceiro.pt',
    tabs: [],
  });

  await assert.rejects(
    () =>
      selectExistingSpreadsheetForTenant({
        companyId: tenant.company_id,
        actorUserId: 'usr-zeta',
        spreadsheetId: 'sheet-other-user-999',
      }),
    (err: unknown) => err instanceof GoogleSheetsError && err.code === 'ACCESS_DENIED'
  );
  assert.equal(getTenantById(tenant.company_id)?.connection_status, 'Sem acesso à folha');

  // Agora criar folha própria e correr diagnóstico completo
  await createNewSpreadsheetForTenant({ companyId: tenant.company_id, actorUserId: 'usr-zeta' });
  const diag = await testTenantSheetsConnection(tenant.company_id);
  assert.equal(diag.status, 'Ligado');
  assert.equal(diag.verifiedEmail, 'zeta@empresa.pt');
  assert.ok(diag.steps.every((s) => s.ok));

  // Se folha for removida no Google Drive (404)
  const spId = getTenantById(tenant.company_id)!.spreadsheet_id;
  mockTransport.spreadsheets.delete(spId);
  const diagRemoved = await testTenantSheetsConnection(tenant.company_id);
  assert.equal(diagRemoved.status, 'Sem acesso à folha');
});

test('9. Desligar conta Google revoga tokens, remove cofre e bloqueia leituras operacionais', async () => {
  const tenant = createTenantRecord({
    companyName: 'Teta Soluções',
    slug: 'teta-sol',
    nif: '507890123',
    ownerUserId: 'usr-teta',
  });
  const flow = startCompanyGoogleOAuthFlow({
    companyId: tenant.company_id,
    userId: 'usr-teta',
    enteredGoogleEmail: 'admin@teta.pt',
  });
  mockTransport.registerAuthCode('code-teta', 'admin@teta.pt', 'tok-teta', 'ref-teta');
  await completeOAuthCodeCallback({ state: flow.state, code: 'code-teta' });
  await createNewSpreadsheetForTenant({ companyId: tenant.company_id, actorUserId: 'usr-teta' });

  const secretRefBefore = getTenantById(tenant.company_id)!.secret_reference;
  await disconnectTenantGoogleAccount(tenant.company_id, 'usr-teta');

  assert.ok(mockTransport.revokedTokens.includes('ref-teta'));
  assert.equal(getTenantOAuthSecret(secretRefBefore), null);
  assert.equal(getTenantById(tenant.company_id)?.connection_status, 'Não configurado');

  await assert.rejects(
    () => getTenantDatabase(tenant.company_id),
    (err: unknown) => err instanceof TenantDatabaseNotConnectedError && err.code === 'DATABASE_NOT_CONNECTED'
  );
});

test('10. Token expirado renova automaticamente via refresh_token; refresh revogado marca Ligação expirada', async () => {
  const tenant = createTenantRecord({
    companyName: 'Iota Digital',
    slug: 'iota-dig',
    nif: '508901234',
    ownerUserId: 'usr-iota',
  });
  const flow = startCompanyGoogleOAuthFlow({
    companyId: tenant.company_id,
    userId: 'usr-iota',
    enteredGoogleEmail: 'ops@iota.pt',
  });
  mockTransport.registerAuthCode('code-iota', 'ops@iota.pt', 'tok-iota-expired', 'ref-iota-ok');
  await completeOAuthCodeCallback({ state: flow.state, code: 'code-iota' });
  await createNewSpreadsheetForTenant({ companyId: tenant.company_id, actorUserId: 'usr-iota' });

  // Forçar expiração local + remota do access token
  const ref = getTenantById(tenant.company_id)!.secret_reference!;
  const currentSecret = getTenantOAuthSecret(ref)!;
  storeTenantOAuthSecret(tenant.company_id, {
    ...currentSecret,
    expires_at: Date.now() - 10_000,
  });
  mockTransport.expireAccessToken('tok-iota-expired');

  // Renovação automática deve funcionar e permitir aceder à BD
  const db = await getTenantDatabase(tenant.company_id);
  const policies = await db.policies.listPolicies();
  assert.ok(Array.isArray(policies));

  // Agora revogar refresh token e forçar expiração do novo access token
  const refreshedSecret = getTenantOAuthSecret(ref)!;
  mockTransport.refreshTokens.get('ref-iota-ok')!.revoked = true;
  storeTenantOAuthSecret(tenant.company_id, {
    ...refreshedSecret,
    expires_at: Date.now() - 10_000,
  });
  updateTenantRecord(tenant.company_id, { connection_status: 'Ligado' });

  await assert.rejects(
    () => getTenantDatabase(tenant.company_id),
    (err: unknown) => err instanceof TenantDatabaseNotConnectedError && err.status === 'Ligação expirada'
  );
  assert.equal(getTenantById(tenant.company_id)?.connection_status, 'Ligação expirada');
});
