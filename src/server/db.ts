import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { generateAgentCredential, hashPassword } from './security.ts';
import { AGENT_TEMPLATES, TOOL_CATALOG } from './seedTemplates.ts';

const DATA_DIR = path.resolve(process.cwd(), '.data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = process.env.MANDATO_DB_PATH
  ? path.resolve(process.env.MANDATO_DB_PATH)
  : path.join(DATA_DIR, 'mandato.db');
const dbParentDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbParentDir)) {
  fs.mkdirSync(dbParentDir, { recursive: true });
}
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.SUPABASE_URL.startsWith('http')
  );
}

export function getSupabaseAdminClient() {
  if (!isSupabaseConfigured()) return null;
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      nif TEXT,
      sector TEXT,
      subscription_plan TEXT NOT NULL DEFAULT 'PROFESSIONAL',
      is_demo INTEGER NOT NULL DEFAULT 0,
      retention_days INTEGER NOT NULL DEFAULT 365,
      settings TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      job_title TEXT,
      avatar_initials TEXT,
      recovery_token TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS company_members (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      objective TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'MANDATO',
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      external_identifier TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      security_status TEXT NOT NULL DEFAULT 'protected',
      avatar_icon TEXT NOT NULL DEFAULT 'bot',
      instructions TEXT NOT NULL,
      permissions_summary TEXT NOT NULL,
      actions_count INTEGER NOT NULL DEFAULT 0,
      last_activity_at TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_versions (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      instructions TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_credentials (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      last_used_at TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_tools (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      tool_key TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      category TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 0,
      requires_approval INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      objective TEXT NOT NULL,
      suggested_instructions TEXT NOT NULL,
      suggested_tools TEXT NOT NULL,
      suggested_permissions TEXT NOT NULL,
      recommended_restrictions TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      action_type TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      max_auto_amount REAL,
      max_approval_amount REAL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      conditions TEXT NOT NULL DEFAULT '{}',
      is_absolute_restriction INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS policy_assignments (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      UNIQUE(policy_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS authorization_requests (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      action_type TEXT NOT NULL,
      tool_name TEXT,
      description TEXT NOT NULL,
      amount REAL,
      currency TEXT DEFAULT 'EUR',
      resource_id TEXT,
      idempotency_key TEXT,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL,
      policy_id TEXT,
      is_simulation INTEGER NOT NULL DEFAULT 0,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(company_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      authorization_request_id TEXT NOT NULL REFERENCES authorization_requests(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      requested_action TEXT NOT NULL,
      description TEXT NOT NULL,
      financial_value REAL,
      currency TEXT DEFAULT 'EUR',
      policy_name TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pendente',
      info_requested_note TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_decisions (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      approval_request_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
      approver_id TEXT NOT NULL,
      approver_name TEXT NOT NULL,
      decision TEXT NOT NULL,
      justification TEXT NOT NULL,
      policy_applied TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_nodes (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      node_type TEXT NOT NULL,
      label TEXT NOT NULL,
      agent_id TEXT,
      config TEXT NOT NULL DEFAULT '{}',
      position_x INTEGER NOT NULL DEFAULT 0,
      position_y INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_edges (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      source_node_id TEXT NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
      target_node_id TEXT NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
      condition_label TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_executions (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      input_summary TEXT NOT NULL,
      steps_log TEXT NOT NULL DEFAULT '[]',
      triggered_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      provider_key TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'not_configured',
      required_credentials TEXT NOT NULL DEFAULT '[]',
      capabilities TEXT NOT NULL DEFAULT '[]',
      documentation_summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(company_id, provider_key)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      reason TEXT NOT NULL,
      related_policy TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);

  seedTemplates();
  seedDemoCompanyIfMissing();
}

function seedTemplates(): void {
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM agent_templates').get() as { cnt: number };
  if (countRow.cnt > 0) return;

  const insert = db.prepare(`
    INSERT INTO agent_templates (
      id, name, category, description, objective,
      suggested_instructions, suggested_tools, suggested_permissions,
      recommended_restrictions, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  for (const tpl of AGENT_TEMPLATES) {
    insert.run(
      tpl.id,
      tpl.name,
      tpl.category,
      tpl.description,
      tpl.objective,
      JSON.stringify(tpl.suggested_instructions),
      JSON.stringify(tpl.suggested_tools),
      JSON.stringify(tpl.suggested_permissions),
      JSON.stringify(tpl.recommended_restrictions),
      now
    );
  }
}

export function seedIntegrationsForCompany(companyId: string): void {
  const geminiReady = Boolean(
    process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
  );
  const openaiReady = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
  const anthropicReady = Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());

  const items = [
    {
      key: 'google_gemini',
      name: 'Google Gemini',
      category: 'ai_provider',
      description: 'Provedor principal de raciocínio e geração de instruções estruturadas para agentes.',
      status: geminiReady ? 'configured' : 'not_configured',
      creds: ['GEMINI_API_KEY (variável de ambiente no servidor)'],
      caps: ['Execução de agentes', 'Geração de instruções com IA', 'Saída JSON estruturada'],
      docs: 'Configure GEMINI_API_KEY no painel de segredos do servidor. Nunca expor no browser.',
    },
    {
      key: 'openai',
      name: 'OpenAI',
      category: 'ai_provider',
      description: 'Arquitetura preparada para modelos GPT através da camada de abstração MANDATO.',
      status: openaiReady ? 'configured' : 'not_configured',
      creds: ['OPENAI_API_KEY (variável de ambiente no servidor)'],
      caps: ['Execução de modelos GPT', 'Registo de agentes externos OpenAI'],
      docs: 'Defina OPENAI_API_KEY no ambiente de servidor para ativar modelos OpenAI.',
    },
    {
      key: 'anthropic',
      name: 'Anthropic',
      category: 'ai_provider',
      description: 'Suporte preparado para modelos Claude com validação obrigatória pelo motor de políticas.',
      status: anthropicReady ? 'configured' : 'not_configured',
      creds: ['ANTHROPIC_API_KEY (variável de ambiente no servidor)'],
      caps: ['Execução de modelos Claude', 'Registo de agentes externos Anthropic'],
      docs: 'Defina ANTHROPIC_API_KEY no ambiente de servidor para ativar modelos Claude.',
    },
    {
      key: 'email_smtp',
      name: 'Email Corporativo (SMTP / Microsoft 365 / Workspace)',
      category: 'business_system',
      description: 'Envio controlado de comunicações após aprovação humana obrigatória.',
      status: 'not_configured',
      creds: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS ou OAuth Cliente'],
      caps: ['Envio de emails aprovados', 'Notificações de aprovação'],
      docs: 'Requer credenciais SMTP ou OAuth configuradas no servidor. No MVP apenas rascunhos são gerados.',
    },
    {
      key: 'crm_connector',
      name: 'CRM Empresarial',
      category: 'business_system',
      description: 'Consulta de leads, oportunidades e histórico comercial sob política de leitura.',
      status: 'not_configured',
      creds: ['CRM_BASE_URL', 'CRM_API_TOKEN'],
      caps: ['Consultar clientes', 'Registar notas comerciais'],
      docs: 'Conector genérico pronto para integração via REST API autenticada.',
    },
    {
      key: 'erp_connector',
      name: 'ERP e Compras',
      category: 'business_system',
      description: 'Integração para emissão real de ordens de compra após autorização e segunda verificação.',
      status: 'not_configured',
      creds: ['ERP_ENDPOINT', 'ERP_CLIENT_SECRET'],
      caps: ['Consultar fornecedores', 'Emitir notas de encomenda pós-aprovação'],
      docs: 'A aprovação no MANDATO não executa compras reais sem este conector configurado e verificado.',
    },
    {
      key: 'accounting_connector',
      name: 'Contabilidade e Faturação',
      category: 'business_system',
      description: 'Leitura de faturas e reconciliação de reembolsos autorizados.',
      status: 'not_configured',
      creds: ['ACCOUNTING_API_KEY', 'COMPANY_FISCAL_ID'],
      caps: ['Consultar faturas', 'Exportar lançamentos aprovados'],
      docs: 'Integrável com software de faturação certificado em Portugal via API.',
    },
    {
      key: 'document_storage',
      name: 'Armazenamento Documental',
      category: 'business_system',
      description: 'Indexação e leitura controlada de contratos, propostas e atas.',
      status: 'not_configured',
      creds: ['STORAGE_BUCKET', 'STORAGE_ACCESS_KEY'],
      caps: ['Pesquisar documentos', 'Analisar ficheiros'],
      docs: 'Configure credenciais S3/Supabase Storage no servidor para acesso a repositórios externos.',
    },
    {
      key: 'rest_api_gateway',
      name: 'APIs REST Externas',
      category: 'business_system',
      description: 'Gateway central /api/v1/authorize e conectores HTTP com lista explícita de domínios.',
      status: 'configured',
      creds: ['Chave Bearer de Agente (SHA-256 no servidor)'],
      caps: ['POST /api/v1/authorize', 'Idempotência e rate limiting', 'Auditoria completa'],
      docs: 'Ativo para agentes externos registados com credencial emitida no MANDATO.',
    },
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO integrations (
      id, company_id, provider_key, name, category, description, status,
      required_credentials, capabilities, documentation_summary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  for (const item of items) {
    stmt.run(
      crypto.randomUUID(),
      companyId,
      item.key,
      item.name,
      item.category,
      item.description,
      item.status,
      JSON.stringify(item.creds),
      JSON.stringify(item.caps),
      item.docs,
      now
    );
  }
}

function seedDemoCompanyIfMissing(): void {
  const existing = db.prepare('SELECT id FROM companies WHERE slug = ?').get('empresa-demonstracao') as
    | { id: string }
    | undefined;
  if (existing) return;

  const companyId = '11111111-1111-4111-8111-111111111111';
  const now = new Date();
  const iso = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  const daysAgoIso = (daysAgo: number, hour = 10) => {
    const d = new Date(now.getTime() - daysAgo * 86_400_000);
    d.setHours(hour, 15, 0, 0);
    return d.toISOString();
  };

  db.prepare(`
    INSERT INTO companies (id, name, slug, nif, sector, subscription_plan, is_demo, retention_days, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 365, ?, ?)
  `).run(
    companyId,
    'Empresa Demonstração',
    'empresa-demonstracao',
    '509123456',
    'Serviços Empresariais e Distribuição',
    'PROFESSIONAL',
    daysAgoIso(20),
    iso(5)
  );

  // 5 Utilizadores demonstrando os 5 perfis RBAC
  const demoUsers = [
    {
      id: 'u-owner-1',
      email: 'direcao@demonstracao.pt',
      name: 'Helena Vasconcelos',
      title: 'Diretora-Geral',
      initials: 'HV',
      role: 'OWNER',
    },
    {
      id: 'u-admin-1',
      email: 'seguranca@demonstracao.pt',
      name: 'Tiago Azevedo',
      title: 'Responsável de Governação e TI',
      initials: 'TA',
      role: 'ADMIN',
    },
    {
      id: 'u-approver-1',
      email: 'compras.gestor@demonstracao.pt',
      name: 'Inês Ferreira',
      title: 'Gestora de Compras',
      initials: 'IF',
      role: 'APPROVER',
    },
    {
      id: 'u-operator-1',
      email: 'operacoes@demonstracao.pt',
      name: 'Diogo Martins',
      title: 'Operador de Automação',
      initials: 'DM',
      role: 'OPERATOR',
    },
    {
      id: 'u-viewer-1',
      email: 'auditoria@demonstracao.pt',
      name: 'Sofia Almeida',
      title: 'Auditora Interna',
      initials: 'SA',
      role: 'VIEWER',
    },
  ];

  const defaultPassHash = hashPassword('MandatoDemo2026!');
  const insertProfile = db.prepare(`
    INSERT INTO profiles (id, email, password_hash, full_name, job_title, avatar_initials, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMember = db.prepare(`
    INSERT INTO company_members (id, company_id, user_id, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `);

  for (const u of demoUsers) {
    insertProfile.run(u.id, u.email, defaultPassHash, u.name, u.title, u.initials, daysAgoIso(20), daysAgoIso(20));
    insertMember.run(crypto.randomUUID(), companyId, u.id, u.role, daysAgoIso(20), daysAgoIso(20));
  }

  // 3 Agentes internos + 1 Externo registado (total 3 principais + 1 externo)
  const agentComprasId = 'agent-compras-demo';
  const agentFinanceiroId = 'agent-financeiro-demo';
  const agentAtendimentoId = 'agent-atendimento-demo';

  const comprasTpl = AGENT_TEMPLATES[0];
  const finTpl = AGENT_TEMPLATES[1];
  const atendTpl = AGENT_TEMPLATES[3];

  const insertAgent = db.prepare(`
    INSERT INTO agents (
      id, company_id, name, description, category, objective, origin,
      provider, model, external_identifier, status, security_status,
      avatar_icon, instructions, permissions_summary, actions_count,
      last_activity_at, is_demo, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `);

  insertAgent.run(
    agentComprasId,
    companyId,
    'Agente de Compras',
    'Gere cotações de fornecedores, compara propostas e submete pedidos de compra dentro dos tetos financeiros.',
    'Compras',
    comprasTpl.objective,
    'MANDATO',
    'Google Gemini',
    'gemini-4-hydrogen',
    null,
    'active',
    'protected',
    'shopping-cart',
    JSON.stringify(comprasTpl.suggested_instructions),
    JSON.stringify(comprasTpl.suggested_permissions),
    18,
    iso(12),
    'u-owner-1',
    daysAgoIso(15),
    iso(12)
  );

  insertAgent.run(
    agentFinanceiroId,
    companyId,
    'Agente Financeiro',
    'Verifica faturas, analisa desvios orçamentais e avalia pedidos de reembolso segundo as políticas da empresa.',
    'Financeiro',
    finTpl.objective,
    'MANDATO',
    'Google Gemini',
    'gemini-4-hydrogen',
    null,
    'running',
    'protected',
    'landmark',
    JSON.stringify(finTpl.suggested_instructions),
    JSON.stringify(finTpl.suggested_permissions),
    14,
    iso(25),
    'u-admin-1',
    daysAgoIso(14),
    iso(25)
  );

  insertAgent.run(
    agentAtendimentoId,
    companyId,
    'Agente de Atendimento (Externo)',
    'Agente ligado via API externa para triagem de tickets de clientes e preparação de respostas.',
    'Atendimento ao Cliente',
    atendTpl.objective,
    'EXTERNAL',
    'Google Gemini',
    'gemini-3.1-flash-lite',
    'ext-crm-support-01',
    'active',
    'protected',
    'headset',
    JSON.stringify(atendTpl.suggested_instructions),
    JSON.stringify(atendTpl.suggested_permissions),
    9,
    iso(45),
    'u-admin-1',
    daysAgoIso(10),
    iso(45)
  );

  // Credenciais hash para cada agente
  const insertCred = db.prepare(`
    INSERT INTO agent_credentials (id, company_id, agent_id, key_prefix, key_hash, status, last_used_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
  `);
  for (const agId of [agentComprasId, agentFinanceiroId, agentAtendimentoId]) {
    const cred = generateAgentCredential(agId === agentAtendimentoId ? 'mdt_ext' : 'mdt_live');
    insertCred.run(crypto.randomUUID(), companyId, agId, cred.keyPrefix, cred.keyHash, iso(30), daysAgoIso(10));
  }

  // Ferramentas para os agentes
  const insertTool = db.prepare(`
    INSERT INTO agent_tools (id, company_id, agent_id, tool_key, tool_name, category, risk_level, is_enabled, requires_approval, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const comprasTools = new Set(['consultar_fornecedores', 'analisar_ficheiros', 'submeter_encomenda']);
  const finTools = new Set(['analisar_ficheiros', 'gerar_relatorios', 'processar_reembolso']);
  const atendTools = new Set(['consultar_informacao', 'preparar_emails', 'enviar_email_externo']);

  for (const tool of TOOL_CATALOG) {
    insertTool.run(
      crypto.randomUUID(),
      companyId,
      agentComprasId,
      tool.tool_key,
      tool.tool_name,
      tool.category,
      tool.risk_level,
      comprasTools.has(tool.tool_key) ? 1 : 0,
      tool.default_requires_approval ? 1 : 0,
      daysAgoIso(15)
    );
    insertTool.run(
      crypto.randomUUID(),
      companyId,
      agentFinanceiroId,
      tool.tool_key,
      tool.tool_name,
      tool.category,
      tool.risk_level,
      finTools.has(tool.tool_key) ? 1 : 0,
      tool.default_requires_approval ? 1 : 0,
      daysAgoIso(14)
    );
    insertTool.run(
      crypto.randomUUID(),
      companyId,
      agentAtendimentoId,
      tool.tool_key,
      tool.tool_name,
      tool.category,
      tool.risk_level,
      atendTools.has(tool.tool_key) ? 1 : 0,
      tool.default_requires_approval ? 1 : 0,
      daysAgoIso(10)
    );
  }

  // 5 Políticas de autorização
  const policies = [
    {
      id: 'pol-demo-1',
      name: 'Política de Compras Operacionais',
      desc: 'Compras até €300 autorizadas automaticamente; entre €300 e €1.000 exigem aprovação de gestor; acima de €1.000 bloqueadas.',
      action: 'purchase_order',
      rule: 'financial_threshold',
      autoMax: 300,
      appMax: 1000,
      abs: 0,
      status: 'active',
    },
    {
      id: 'pol-demo-2',
      name: 'Política de Reembolsos a Clientes',
      desc: 'Reembolsos até €50 permitidos; acima de €50 requerem aprovação; destinos não verificados são bloqueados.',
      action: 'refund',
      rule: 'financial_threshold',
      autoMax: 50,
      appMax: 500,
      abs: 0,
      status: 'active',
    },
    {
      id: 'pol-demo-3',
      name: 'Proteção Absoluta de Dados Bancários',
      desc: 'Bloqueio absoluto a qualquer alteração de IBAN ou dados bancários de fornecedores por agentes.',
      action: 'bank_details_update',
      rule: 'block_always',
      autoMax: null,
      appMax: null,
      abs: 1,
      status: 'active',
    },
    {
      id: 'pol-demo-4',
      name: 'Comunicação Externa com Clientes',
      desc: 'Rascunhos são permitidos; o envio efetivo de mensagens externas exige aprovação humana.',
      action: 'send_message',
      rule: 'require_approval',
      autoMax: null,
      appMax: null,
      abs: 0,
      status: 'active',
    },
    {
      id: 'pol-demo-5',
      name: 'Gestão de Novos Fornecedores',
      desc: 'Consulta de fornecedores permitida; criação de novo registo de fornecedor exige validação humana.',
      action: 'create_supplier',
      rule: 'require_approval',
      autoMax: null,
      appMax: null,
      abs: 0,
      status: 'review_required',
    },
  ];

  const insertPolicy = db.prepare(`
    INSERT INTO policies (
      id, company_id, name, description, action_type, rule_type,
      max_auto_amount, max_approval_amount, currency, conditions,
      is_absolute_restriction, status, is_demo, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, 1, ?, ?)
  `);
  for (const p of policies) {
    insertPolicy.run(
      p.id,
      companyId,
      p.name,
      p.desc,
      p.action,
      p.rule,
      p.autoMax,
      p.appMax,
      JSON.stringify(p.action === 'refund' ? { require_verified_destination: true } : {}),
      p.abs,
      p.status,
      daysAgoIso(15),
      daysAgoIso(2)
    );
  }

  // Atribuir políticas aos agentes
  const assignStmt = db.prepare(`
    INSERT INTO policy_assignments (id, company_id, policy_id, agent_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const p of policies) {
    assignStmt.run(crypto.randomUUID(), companyId, p.id, agentComprasId, daysAgoIso(15));
    assignStmt.run(crypto.randomUUID(), companyId, p.id, agentFinanceiroId, daysAgoIso(14));
    assignStmt.run(crypto.randomUUID(), companyId, p.id, agentAtendimentoId, daysAgoIso(10));
  }

  // 10 Registos de autorização de exemplo (incluindo pedidos pendentes, aprovados e bloqueados)
  const authRecords = [
    {
      id: 'auth-demo-01',
      agent: agentComprasId,
      action: 'purchase_order',
      tool: 'submeter_encomenda',
      desc: 'Compra de equipamento de escritório (cadeira ergonómica e monitores)',
      amount: 500,
      res: 'ORD-2026-081',
      decision: 'REQUIRES_APPROVAL',
      reason: 'Valor €500,00 excede o limite automático de €300,00. Requer aprovação de gestor.',
      pol: 'pol-demo-1',
      createdAt: iso(18),
    },
    {
      id: 'auth-demo-02',
      agent: agentComprasId,
      action: 'purchase_order',
      tool: 'submeter_encomenda',
      desc: 'Aquisição de consumíveis de impressão e papel A4',
      amount: 185,
      res: 'ORD-2026-080',
      decision: 'ALLOWED',
      reason: 'Autorizado automaticamente pela política "Política de Compras Operacionais" (€185,00 ≤ €300,00).',
      pol: 'pol-demo-1',
      createdAt: daysAgoIso(0, 9),
    },
    {
      id: 'auth-demo-03',
      agent: agentComprasId,
      action: 'bank_details_update',
      tool: 'alterar_dados_bancarios',
      desc: 'Pedido para atualizar IBAN do fornecedor Lusitano Papel Lda.',
      amount: null,
      res: 'SUP-402',
      decision: 'BLOCKED',
      reason: 'Restrição absoluta: agentes não podem alterar dados bancários ou IBAN de fornecedores.',
      pol: 'pol-demo-3',
      createdAt: daysAgoIso(1, 16),
    },
    {
      id: 'auth-demo-04',
      agent: agentFinanceiroId,
      action: 'refund',
      tool: 'processar_reembolso',
      desc: 'Reembolso parcial por atraso na entrega — Fatura FT-992',
      amount: 42,
      res: 'FT-992',
      decision: 'ALLOWED',
      reason: 'Autorizado automaticamente pela política de reembolsos (€42,00 ≤ €50,00, destino verificado).',
      pol: 'pol-demo-2',
      createdAt: daysAgoIso(1, 11),
    },
    {
      id: 'auth-demo-05',
      agent: agentFinanceiroId,
      action: 'refund',
      tool: 'processar_reembolso',
      desc: 'Reembolso integral de licença anual cancelada — Cliente NorteTech',
      amount: 240,
      res: 'FT-985',
      decision: 'REQUIRES_APPROVAL',
      reason: 'Valor €240,00 excede o limite automático de €50,00 para reembolsos.',
      pol: 'pol-demo-2',
      createdAt: daysAgoIso(2, 14),
    },
    {
      id: 'auth-demo-06',
      agent: agentComprasId,
      action: 'purchase_order',
      tool: 'submeter_encomenda',
      desc: 'Aquisição de servidor rack para infraestrutura local',
      amount: 2450,
      res: 'ORD-2026-074',
      decision: 'BLOCKED',
      reason: 'Valor €2.450,00 excede o teto máximo permitido de €1.000,00 sem exceção autorizada.',
      pol: 'pol-demo-1',
      createdAt: daysAgoIso(2, 10),
    },
    {
      id: 'auth-demo-07',
      agent: agentAtendimentoId,
      action: 'send_message',
      tool: 'enviar_email_externo',
      desc: 'Envio de esclarecimento contratual ao cliente Atlântico Logística',
      amount: null,
      res: 'TKT-3310',
      decision: 'REQUIRES_APPROVAL',
      reason: 'Comunicação externa com cliente exige aprovação humana obrigatória.',
      pol: 'pol-demo-4',
      createdAt: daysAgoIso(3, 15),
    },
    {
      id: 'auth-demo-08',
      agent: agentComprasId,
      action: 'read_supplier',
      tool: 'consultar_fornecedores',
      desc: 'Comparação de cotações para material informático (3 fornecedores)',
      amount: null,
      res: 'RFQ-112',
      decision: 'ALLOWED',
      reason: 'Ação de leitura segura permitida.',
      pol: null,
      createdAt: daysAgoIso(4, 9),
    },
    {
      id: 'auth-demo-09',
      agent: agentComprasId,
      action: 'purchase_order',
      tool: 'submeter_encomenda',
      desc: 'Compra de licenças de produtividade para equipa comercial',
      amount: 480,
      res: 'ORD-2026-069',
      decision: 'REQUIRES_APPROVAL',
      reason: 'Valor €480,00 excede o limite automático de €300,00. Requer aprovação de gestor.',
      pol: 'pol-demo-1',
      createdAt: daysAgoIso(5, 11),
    },
    {
      id: 'auth-demo-10',
      agent: agentAtendimentoId,
      action: 'read_info',
      tool: 'consultar_informacao',
      desc: 'Consulta de estado de encomenda para resposta em rascunho',
      amount: null,
      res: 'TKT-3298',
      decision: 'ALLOWED',
      reason: 'Ação de leitura segura permitida.',
      pol: null,
      createdAt: daysAgoIso(6, 16),
    },
  ];

  const insertAuthReq = db.prepare(`
    INSERT INTO authorization_requests (
      id, company_id, agent_id, action_type, tool_name, description,
      amount, currency, resource_id, idempotency_key, decision, reason,
      policy_id, is_simulation, is_demo, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, ?, ?, 0, 1, ?)
  `);

  for (const r of authRecords) {
    insertAuthReq.run(
      r.id,
      companyId,
      r.agent,
      r.action,
      r.tool,
      r.desc,
      r.amount,
      r.res,
      `demo_${r.id}`,
      r.decision,
      r.reason,
      r.pol,
      r.createdAt
    );
  }

  // Pedidos de aprovação (2 Pendentes, 1 Aprovado, 1 Rejeitado)
  const insertApproval = db.prepare(`
    INSERT INTO approval_requests (
      id, company_id, authorization_request_id, agent_id, requested_action,
      description, financial_value, currency, policy_name, risk_level,
      status, is_demo, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, 1, ?, ?)
  `);

  insertApproval.run(
    'apr-demo-01',
    companyId,
    'auth-demo-01',
    agentComprasId,
    'Ordem de Compra (purchase_order)',
    'Compra de equipamento de escritório (cadeira ergonómica e monitores)',
    500,
    'Política de Compras Operacionais',
    'medium',
    'Pendente',
    iso(18),
    iso(18)
  );

  insertApproval.run(
    'apr-demo-02',
    companyId,
    'auth-demo-07',
    agentAtendimentoId,
    'Comunicação Externa (send_message)',
    'Envio de esclarecimento contratual ao cliente Atlântico Logística',
    null,
    'Comunicação Externa com Clientes',
    'medium',
    'Pendente',
    daysAgoIso(3, 15),
    daysAgoIso(3, 15)
  );

  insertApproval.run(
    'apr-demo-03',
    companyId,
    'auth-demo-09',
    agentComprasId,
    'Ordem de Compra (purchase_order)',
    'Compra de licenças de produtividade para equipa comercial',
    480,
    'Política de Compras Operacionais',
    'medium',
    'Aprovado',
    daysAgoIso(5, 11),
    daysAgoIso(5, 12)
  );

  insertApproval.run(
    'apr-demo-04',
    companyId,
    'auth-demo-05',
    agentFinanceiroId,
    'Reembolso a Cliente (refund)',
    'Reembolso integral de licença anual cancelada — Cliente NorteTech',
    240,
    'Política de Reembolsos a Clientes',
    'high',
    'Aprovado',
    daysAgoIso(2, 14),
    daysAgoIso(2, 15)
  );

  db.prepare(`
    INSERT INTO approval_decisions (
      id, company_id, approval_request_id, approver_id, approver_name,
      decision, justification, policy_applied, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    companyId,
    'apr-demo-03',
    'u-approver-1',
    'Inês Ferreira',
    'Aprovado',
    'Orçamento comercial validado para o 4.º trimestre. Nota de encomenda autorizada (sem pagamento automático).',
    'Política de Compras Operacionais',
    daysAgoIso(5, 12)
  );

  db.prepare(`
    INSERT INTO approval_decisions (
      id, company_id, approval_request_id, approver_id, approver_name,
      decision, justification, policy_applied, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    companyId,
    'apr-demo-04',
    'u-owner-1',
    'Helena Vasconcelos',
    'Aprovado',
    'Cancelamento confirmado dentro do prazo contratual de 14 dias.',
    'Política de Reembolsos a Clientes',
    daysAgoIso(2, 15)
  );

  // Workflow de exemplo: Gestão de Compras
  const wfId = 'wf-demo-compras';
  db.prepare(`
    INSERT INTO workflows (id, company_id, name, description, status, is_demo, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', 1, ?, ?)
  `).run(
    wfId,
    companyId,
    'Gestão de Compras Corporativas',
    'Orquestra verificação de fornecedores, análise de cotações, validação de políticas MANDATO e aprovação humana acima de €300.',
    daysAgoIso(12),
    daysAgoIso(2)
  );

  const wfNodes = [
    { id: 'wfn-1', type: 'start', label: 'Pedido de Compra Recebido', agent: null, x: 40, y: 140, cfg: {} },
    { id: 'wfn-2', type: 'agent_task', label: 'Consultar Fornecedores Homologados', agent: agentComprasId, x: 260, y: 140, cfg: { action_type: 'read_supplier', description: 'Consultar catálogo de fornecedores' } },
    { id: 'wfn-3', type: 'agent_task', label: 'Preparar Recomendação (€500)', agent: agentComprasId, x: 490, y: 140, cfg: { action_type: 'purchase_order', amount: 500, description: 'Submeter recomendação de compra de €500' } },
    { id: 'wfn-4', type: 'condition', label: 'Motor de Políticas MANDATO', agent: null, x: 720, y: 140, cfg: { condition_expression: 'Montante > €300' } },
    { id: 'wfn-5', type: 'human_approval', label: 'Aprovação do Gestor de Compras', agent: null, x: 950, y: 140, cfg: { recipient: 'Inês Ferreira' } },
    { id: 'wfn-6', type: 'notification', label: 'Registar Decisão e Auditoria', agent: null, x: 1180, y: 140, cfg: { recipient: 'Equipa Financeira' } },
    { id: 'wfn-7', type: 'end', label: 'Fim do Fluxo', agent: null, x: 1380, y: 140, cfg: {} },
  ];

  const insertNode = db.prepare(`
    INSERT INTO workflow_nodes (id, company_id, workflow_id, node_type, label, agent_id, config, position_x, position_y, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const n of wfNodes) {
    insertNode.run(n.id, companyId, wfId, n.type, n.label, n.agent, JSON.stringify(n.cfg), n.x, n.y, daysAgoIso(12));
  }

  const insertEdge = db.prepare(`
    INSERT INTO workflow_edges (id, company_id, workflow_id, source_node_id, target_node_id, condition_label, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < wfNodes.length - 1; i++) {
    insertEdge.run(
      `wfe-${i + 1}`,
      companyId,
      wfId,
      wfNodes[i].id,
      wfNodes[i + 1].id,
      i === 3 ? 'Requer aprovação' : null,
      daysAgoIso(12)
    );
  }

  db.prepare(`
    INSERT INTO workflow_executions (id, company_id, workflow_id, status, input_summary, steps_log, triggered_by, created_at)
    VALUES (?, ?, ?, 'awaiting_approval', ?, ?, 'u-operator-1', ?)
  `).run(
    'wfe-exec-1',
    companyId,
    wfId,
    'Pedido: Equipamento de escritório (€500,00)',
    JSON.stringify([
      { node_id: 'wfn-1', label: 'Pedido de Compra Recebido', node_type: 'start', status: 'completed', detail: 'Iniciado por Diogo Martins', timestamp: iso(20) },
      { node_id: 'wfn-2', label: 'Consultar Fornecedores Homologados', node_type: 'agent_task', status: 'completed', decision: 'ALLOWED', detail: '3 fornecedores consultados', timestamp: iso(19) },
      { node_id: 'wfn-3', label: 'Preparar Recomendação (€500)', node_type: 'agent_task', status: 'awaiting_approval', decision: 'REQUIRES_APPROVAL', detail: 'Pedido apr-demo-01 criado para aprovação humana', timestamp: iso(18) },
    ]),
    iso(20)
  );

  // Registos de auditoria (append-only)
  const insertAudit = db.prepare(`
    INSERT INTO audit_logs (
      id, company_id, actor_type, actor_id, actor_name, event_type,
      action, result, reason, related_policy, is_demo, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);

  const auditEntries = [
    ['user', 'u-owner-1', 'Helena Vasconcelos', 'agent_created', 'Criação do Agente de Compras', 'Sucesso', 'Agente criado a partir do modelo Assistente de Compras.', null, daysAgoIso(15)],
    ['user', 'u-admin-1', 'Tiago Azevedo', 'policy_created', 'Ativação de 5 políticas base de governação', 'Sucesso', 'Configuração inicial de limites financeiros e proteção bancária.', 'Política de Compras Operacionais', daysAgoIso(15)],
    ['agent', agentComprasId, 'Agente de Compras', 'authorization_decision', 'Compra de consumíveis (€185,00)', 'ALLOWED', 'Dentro do limite automático de €300,00.', 'Política de Compras Operacionais', daysAgoIso(0, 9)],
    ['agent', agentComprasId, 'Agente de Compras', 'blocked_action', 'Tentativa de alteração de IBAN de fornecedor', 'BLOCKED', 'Restrição absoluta: alteração de dados bancários proibida a agentes.', 'Proteção Absoluta de Dados Bancários', daysAgoIso(1, 16)],
    ['agent', agentComprasId, 'Agente de Compras', 'blocked_action', 'Compra de servidor (€2.450,00)', 'BLOCKED', 'Excede o teto máximo de €1.000,00 sem exceção autorizada.', 'Política de Compras Operacionais', daysAgoIso(2, 10)],
    ['user', 'u-approver-1', 'Inês Ferreira', 'approval', 'Aprovação de compra de licenças (€480,00)', 'Aprovado', 'Orçamento comercial validado para o 4.º trimestre.', 'Política de Compras Operacionais', daysAgoIso(5, 12)],
    ['agent', agentComprasId, 'Agente de Compras', 'authorization_decision', 'Pedido de compra de equipamento de escritório (€500,00)', 'REQUIRES_APPROVAL', 'Valor €500,00 excede €300,00. Enviado para fila de aprovação.', 'Política de Compras Operacionais', iso(18)],
    ['user', 'u-operator-1', 'Diogo Martins', 'workflow_execution', 'Execução do fluxo Gestão de Compras Corporativas', 'Aguardar Aprovação', 'Fluxo pausado no nó de aprovação humana.', 'Política de Compras Operacionais', iso(18)],
  ] as const;

  for (const [aType, aId, aName, evType, action, result, reason, pol, ts] of auditEntries) {
    insertAudit.run(crypto.randomUUID(), companyId, aType, aId, aName, evType, action, result, reason, pol, ts);
  }

  seedIntegrationsForCompany(companyId);

  db.prepare(`
    INSERT INTO notifications (id, company_id, user_id, title, message, severity, is_read, created_at)
    VALUES (?, ?, null, ?, ?, 'warning', 0, ?)
  `).run(
    crypto.randomUUID(),
    companyId,
    'Aprovação pendente (€500,00)',
    'O Agente de Compras solicitou autorização para compra de equipamento de escritório.',
    iso(18)
  );
}
