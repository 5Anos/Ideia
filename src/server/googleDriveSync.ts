import { db } from './db.ts';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const MANDATO_FOLDER_NAME = 'MANDATO - Base de Dados';

export interface GoogleDriveUserInfo {
  email: string;
  displayName: string;
}

export interface GoogleDriveFileSummary {
  id: string;
  name: string;
  modifiedTime: string;
  sizeBytes: number;
}

export interface CompanyDatabaseSnapshot {
  schema_version: string;
  exported_at: string;
  company_id: string;
  company: Record<string, unknown>;
  agents: Array<Record<string, unknown>>;
  agent_tools: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
  policy_assignments: Array<Record<string, unknown>>;
  workflows: Array<Record<string, unknown>>;
  workflow_nodes: Array<Record<string, unknown>>;
  workflow_edges: Array<Record<string, unknown>>;
  workflow_executions: Array<Record<string, unknown>>;
  authorization_requests: Array<Record<string, unknown>>;
  approval_requests: Array<Record<string, unknown>>;
  approval_decisions: Array<Record<string, unknown>>;
  audit_logs: Array<Record<string, unknown>>;
  integrations: Array<Record<string, unknown>>;
}

async function driveFetchJson<T>(url: string, accessToken: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers || {}),
    },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error('Sessão Google Drive expirada ou sem permissão. Volte a iniciar sessão com o Google.');
    }
    throw new Error(`Erro na API Google Drive (${res.status}): ${errText.slice(0, 200)}`);
  }

  if (res.status === 204) {
    return {} as T;
  }
  return (await res.json()) as T;
}

export async function verifyGoogleDriveAccount(accessToken: string): Promise<GoogleDriveUserInfo> {
  const about = await driveFetchJson<{
    user?: { emailAddress?: string; displayName?: string };
  }>(`${DRIVE_API_BASE}/about?fields=user(emailAddress,displayName)`, accessToken);

  return {
    email: about.user?.emailAddress || 'Conta Google ligada',
    displayName: about.user?.displayName || 'Utilizador Google',
  };
}

export async function findOrCreateMandatoFolder(accessToken: string): Promise<string> {
  const q = encodeURIComponent(
    `name = '${MANDATO_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  const existing = await driveFetchJson<{ files?: Array<{ id: string; name: string }> }>(
    `${DRIVE_API_BASE}/files?q=${q}&fields=files(id,name)&pageSize=5`,
    accessToken
  );

  if (existing.files && existing.files.length > 0) {
    return existing.files[0].id;
  }

  const created = await driveFetchJson<{ id: string }>(`${DRIVE_API_BASE}/files`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: MANDATO_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      description: 'Repositório da base de dados empresarial da plataforma MANDATO.',
    }),
  });

  return created.id;
}

export async function listMandatoDriveDatabaseFiles(
  accessToken: string,
  folderId?: string
): Promise<GoogleDriveFileSummary[]> {
  const qParts = ["mimeType = 'application/json'", 'trashed = false', "name contains 'mandato-db-'"];
  if (folderId) {
    qParts.push(`'${folderId}' in parents`);
  }
  const q = encodeURIComponent(qParts.join(' and '));
  const data = await driveFetchJson<{
    files?: Array<{ id: string; name: string; modifiedTime?: string; size?: string }>;
  }>(
    `${DRIVE_API_BASE}/files?q=${q}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,size)&pageSize=20`,
    accessToken
  );

  return (data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    modifiedTime: f.modifiedTime || new Date().toISOString(),
    sizeBytes: Number(f.size || 0),
  }));
}

export function exportCompanyDatabaseSnapshot(companyId: string): CompanyDatabaseSnapshot {
  const company = db
    .prepare('SELECT * FROM companies WHERE id = ?')
    .get(companyId) as Record<string, unknown> | undefined;
  if (!company) {
    throw new Error('Empresa não encontrada para exportação.');
  }

  return {
    schema_version: '1.0',
    exported_at: new Date().toISOString(),
    company_id: companyId,
    company,
    agents: db.prepare('SELECT * FROM agents WHERE company_id = ?').all(companyId) as Array<Record<string, unknown>>,
    agent_tools: db.prepare('SELECT * FROM agent_tools WHERE company_id = ?').all(companyId) as Array<Record<string, unknown>>,
    policies: db.prepare('SELECT * FROM policies WHERE company_id = ?').all(companyId) as Array<Record<string, unknown>>,
    policy_assignments: db.prepare('SELECT * FROM policy_assignments WHERE company_id = ?').all(companyId) as Array<Record<string, unknown>>,
    workflows: db.prepare('SELECT * FROM workflows WHERE company_id = ?').all(companyId) as Array<Record<string, unknown>>,
    workflow_nodes: db.prepare('SELECT * FROM workflow_nodes WHERE company_id = ?').all(companyId) as Array<Record<string, unknown>>,
    workflow_edges: db.prepare('SELECT * FROM workflow_edges WHERE company_id = ?').all(companyId) as Array<Record<string, unknown>>,
    workflow_executions: db.prepare('SELECT * FROM workflow_executions WHERE company_id = ?').all(companyId) as Array<Record<string, unknown>>,
    authorization_requests: db.prepare('SELECT * FROM authorization_requests WHERE company_id = ?').all(companyId) as Array<Record<string, unknown>>,
    approval_requests: db.prepare('SELECT * FROM approval_requests WHERE company_id = ?').all(companyId) as Array<Record<string, unknown>>,
    approval_decisions: db.prepare('SELECT * FROM approval_decisions WHERE company_id = ?').all(companyId) as Array<Record<string, unknown>>,
    audit_logs: db.prepare('SELECT * FROM audit_logs WHERE company_id = ?').all(companyId) as Array<Record<string, unknown>>,
    integrations: db.prepare('SELECT * FROM integrations WHERE company_id = ?').all(companyId) as Array<Record<string, unknown>>,
  };
}

export async function syncCompanySnapshotToGoogleDrive(
  accessToken: string,
  companyId: string
): Promise<{ file: GoogleDriveFileSummary; folderId: string; operation: 'created' | 'updated' }> {
  const snapshot = exportCompanyDatabaseSnapshot(companyId);
  const slug = String(snapshot.company.slug || companyId);
  const fileName = `mandato-db-${slug}.json`;
  const folderId = await findOrCreateMandatoFolder(accessToken);
  const existingFiles = await listMandatoDriveDatabaseFiles(accessToken, folderId);
  const matching = existingFiles.find((f) => f.name === fileName);

  const jsonContent = JSON.stringify(snapshot, null, 2);

  if (matching) {
    const updated = await driveFetchJson<{
      id: string;
      name: string;
      modifiedTime?: string;
      size?: string;
    }>(
      `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(matching.id)}?uploadType=media&fields=id,name,modifiedTime,size`,
      accessToken,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: jsonContent,
      }
    );
    return {
      folderId,
      operation: 'updated',
      file: {
        id: updated.id,
        name: updated.name,
        modifiedTime: updated.modifiedTime || new Date().toISOString(),
        sizeBytes: Number(updated.size || Buffer.byteLength(jsonContent, 'utf8')),
      },
    };
  }

  const boundary = `mandato_boundary_${Date.now()}`;
  const metadataPart = JSON.stringify({
    name: fileName,
    mimeType: 'application/json',
    parents: [folderId],
    description: `Base de dados da empresa ${String(snapshot.company.name)} na plataforma MANDATO.`,
  });

  const multipartBody = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadataPart,
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    jsonContent,
    `--${boundary}--`,
  ].join('\r\n');

  const created = await driveFetchJson<{
    id: string;
    name: string;
    modifiedTime?: string;
    size?: string;
  }>(
    `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,modifiedTime,size`,
    accessToken,
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    }
  );

  return {
    folderId,
    operation: 'created',
    file: {
      id: created.id,
      name: created.name,
      modifiedTime: created.modifiedTime || new Date().toISOString(),
      sizeBytes: Number(created.size || Buffer.byteLength(jsonContent, 'utf8')),
    },
  };
}

export async function restoreCompanySnapshotFromGoogleDrive(
  accessToken: string,
  companyId: string,
  fileId: string
): Promise<{ restoredCounts: { agents: number; policies: number; workflows: number; auditLogs: number } }> {
  const res = await fetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Não foi possível descarregar o ficheiro da Google Drive (${res.status}).`);
  }

  const snapshot = (await res.json()) as Partial<CompanyDatabaseSnapshot>;
  if (!snapshot || snapshot.schema_version !== '1.0' || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.policies)) {
    throw new Error('O ficheiro selecionado não é um snapshot válido da base de dados MANDATO.');
  }

  db.transaction(() => {
    // Limpar registos operacionais da empresa atual antes de restaurar (mantendo utilizadores e credenciais ativas)
    db.prepare('DELETE FROM approval_decisions WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM approval_requests WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM authorization_requests WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM workflow_executions WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM workflow_edges WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM workflow_nodes WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM workflows WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM policy_assignments WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM agent_tools WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM agents WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM policies WHERE company_id = ?').run(companyId);

    if (snapshot.company) {
      db.prepare(
        'UPDATE companies SET name = ?, nif = ?, sector = ?, updated_at = ? WHERE id = ?'
      ).run(
        String(snapshot.company.name || 'Empresa'),
        snapshot.company.nif ? String(snapshot.company.nif) : null,
        snapshot.company.sector ? String(snapshot.company.sector) : null,
        new Date().toISOString(),
        companyId
      );
    }

    const insertPolicy = db.prepare(`
      INSERT OR REPLACE INTO policies (
        id, company_id, name, description, action_type, rule_type,
        max_auto_amount, max_approval_amount, currency, conditions,
        is_absolute_restriction, status, is_demo, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of snapshot.policies || []) {
      insertPolicy.run(
        p.id, companyId, p.name, p.description, p.action_type || 'general', p.rule_type || 'require_approval',
        p.max_auto_amount ?? null, p.max_approval_amount ?? null, p.currency || 'EUR',
        p.conditions || '{}', p.is_absolute_restriction ?? 0, p.status || 'active',
        p.is_demo ?? 0, p.created_at || new Date().toISOString(), p.updated_at || new Date().toISOString()
      );
    }

    const insertAgent = db.prepare(`
      INSERT OR REPLACE INTO agents (
        id, company_id, name, description, category, objective, origin,
        provider, model, external_identifier, status, security_status,
        avatar_icon, instructions, permissions_summary, actions_count,
        last_activity_at, is_demo, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const a of snapshot.agents || []) {
      insertAgent.run(
        a.id, companyId, a.name, a.description, a.category, a.objective, a.origin || 'MANDATO',
        a.provider || 'Google Gemini', a.model || 'gemini-4-hydrogen', a.external_identifier ?? null,
        a.status || 'active', a.security_status || 'protected', a.avatar_icon || 'bot',
        a.instructions, a.permissions_summary, a.actions_count ?? 0,
        a.last_activity_at ?? null, a.is_demo ?? 0, a.created_by ?? null,
        a.created_at || new Date().toISOString(), a.updated_at || new Date().toISOString()
      );
    }

    const insertTool = db.prepare(`
      INSERT OR REPLACE INTO agent_tools (
        id, company_id, agent_id, tool_key, tool_name, category, risk_level,
        is_enabled, requires_approval, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const t of snapshot.agent_tools || []) {
      insertTool.run(
        t.id, companyId, t.agent_id, t.tool_key, t.tool_name, t.category,
        t.risk_level || 'medium', t.is_enabled ?? 0, t.requires_approval ?? 1,
        t.created_at || new Date().toISOString()
      );
    }

    const insertAgPol = db.prepare(`
      INSERT OR IGNORE INTO policy_assignments (id, company_id, policy_id, agent_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const ap of snapshot.policy_assignments || []) {
      insertAgPol.run(ap.id, companyId, ap.policy_id, ap.agent_id, ap.created_at || new Date().toISOString());
    }

    const insertWf = db.prepare(`
      INSERT OR REPLACE INTO workflows (id, company_id, name, description, status, is_demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const w of snapshot.workflows || []) {
      insertWf.run(
        w.id, companyId, w.name, w.description, w.status || 'active', w.is_demo ?? 0,
        w.created_at || new Date().toISOString(), w.updated_at || new Date().toISOString()
      );
    }

    const insertWfNode = db.prepare(`
      INSERT OR REPLACE INTO workflow_nodes (id, company_id, workflow_id, node_type, label, agent_id, config, position_x, position_y, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const n of snapshot.workflow_nodes || []) {
      insertWfNode.run(
        n.id, companyId, n.workflow_id, n.node_type, n.label, n.agent_id ?? null,
        n.config || '{}', n.position_x ?? 0, n.position_y ?? 0, n.created_at || new Date().toISOString()
      );
    }

    const insertWfEdge = db.prepare(`
      INSERT OR REPLACE INTO workflow_edges (id, company_id, workflow_id, source_node_id, target_node_id, condition_label, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const e of snapshot.workflow_edges || []) {
      insertWfEdge.run(
        e.id, companyId, e.workflow_id, e.source_node_id, e.target_node_id,
        e.condition_label ?? null, e.created_at || new Date().toISOString()
      );
    }

    const insertWfExec = db.prepare(`
      INSERT OR REPLACE INTO workflow_executions (id, company_id, workflow_id, status, input_summary, steps_log, triggered_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const ex of snapshot.workflow_executions || []) {
      insertWfExec.run(
        ex.id, companyId, ex.workflow_id, ex.status, ex.input_summary,
        ex.steps_log || '[]', ex.triggered_by ?? null, ex.created_at || new Date().toISOString()
      );
    }

    const insertAuthReq = db.prepare(`
      INSERT OR REPLACE INTO authorization_requests (
        id, company_id, agent_id, action_type, tool_name, description,
        amount, currency, resource_id, idempotency_key, decision, reason,
        policy_id, is_simulation, is_demo, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const ar of snapshot.authorization_requests || []) {
      insertAuthReq.run(
        ar.id, companyId, ar.agent_id, ar.action_type, ar.tool_name ?? null, ar.description,
        ar.amount ?? null, ar.currency || 'EUR', ar.resource_id ?? null, ar.idempotency_key ?? null,
        ar.decision, ar.reason, ar.policy_id ?? null, ar.is_simulation ?? 0, ar.is_demo ?? 0,
        ar.created_at || new Date().toISOString()
      );
    }

    const insertAprReq = db.prepare(`
      INSERT OR REPLACE INTO approval_requests (
        id, company_id, authorization_request_id, agent_id, requested_action,
        description, financial_value, currency, policy_name, risk_level,
        status, info_requested_note, is_demo, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const ap of snapshot.approval_requests || []) {
      insertAprReq.run(
        ap.id, companyId, ap.authorization_request_id ?? null, ap.agent_id,
        ap.requested_action, ap.description, ap.financial_value ?? null,
        ap.currency || 'EUR', ap.policy_name || 'Política Empresarial', ap.risk_level || 'medium',
        ap.status || 'Pendente', ap.info_requested_note ?? null, ap.is_demo ?? 0,
        ap.created_at || new Date().toISOString(), ap.updated_at || new Date().toISOString()
      );
    }

    const insertAprDec = db.prepare(`
      INSERT OR REPLACE INTO approval_decisions (
        id, company_id, approval_request_id, approver_id, approver_name,
        decision, justification, policy_applied, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const ad of snapshot.approval_decisions || []) {
      insertAprDec.run(
        ad.id, companyId, ad.approval_request_id, ad.approver_id, ad.approver_name,
        ad.decision, ad.justification, ad.policy_applied ?? null, ad.created_at || new Date().toISOString()
      );
    }
  })();

  return {
    restoredCounts: {
      agents: (snapshot.agents || []).length,
      policies: (snapshot.policies || []).length,
      workflows: (snapshot.workflows || []).length,
      auditLogs: (snapshot.audit_logs || []).length,
    },
  };
}

export async function deleteDriveDatabaseFile(accessToken: string, fileId: string): Promise<void> {
  await driveFetchJson<unknown>(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`, accessToken, {
    method: 'DELETE',
  });
}
