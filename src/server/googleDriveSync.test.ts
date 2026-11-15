import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDbPath = path.join(os.tmpdir(), `mandato-drive-test-${Date.now()}.db`);
process.env.MANDATO_DB_PATH = tempDbPath;

let dbInstance: { close: () => void } | null = null;
let exportFn: (companyId: string) => {
  schema_version: string;
  company_id: string;
  company: Record<string, unknown>;
  agents: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
};

test.before(async () => {
  const { initDatabase, db } = await import('./db.ts');
  const { exportCompanyDatabaseSnapshot } = await import('./googleDriveSync.ts');
  dbInstance = db;
  exportFn = exportCompanyDatabaseSnapshot;
  initDatabase();
});

test.after(() => {
  if (dbInstance) {
    dbInstance.close();
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${tempDbPath}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

test('exportCompanyDatabaseSnapshot exporta apenas os dados da empresa solicitada', () => {
  const demoCompanyId = '11111111-1111-4111-8111-111111111111';
  const snapshot = exportFn(demoCompanyId);

  assert.equal(snapshot.schema_version, '1.0');
  assert.equal(snapshot.company_id, demoCompanyId);
  assert.equal(snapshot.company.slug, 'empresa-demonstracao');
  assert.equal(snapshot.agents.length, 3);
  assert.equal(snapshot.policies.length, 5);
  assert.ok(snapshot.agents.every((a) => a.company_id === demoCompanyId));
  assert.ok(snapshot.policies.every((p) => p.company_id === demoCompanyId));
});
