-- MANDATO — Migração Inicial PostgreSQL / Supabase
-- Arquitetura multi-empresa com isolamento por tenant e Row Level Security (RLS)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Empresas (Tenants)
CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  nif TEXT,
  sector TEXT,
  subscription_plan TEXT NOT NULL DEFAULT 'PROFESSIONAL' CHECK (subscription_plan IN ('STARTER', 'PROFESSIONAL', 'BUSINESS')),
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  retention_days INTEGER NOT NULL DEFAULT 365,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Perfis de Utilizadores
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  job_title TEXT,
  avatar_initials TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Membros da Empresa & RBAC
CREATE TABLE IF NOT EXISTS company_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'APPROVER', 'OPERATOR', 'VIEWER')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, user_id)
);

-- 4. Agentes de IA (Internos e Externos)
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  objective TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'MANDATO' CHECK (origin IN ('MANDATO', 'EXTERNAL')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  external_identifier TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'running', 'suspended', 'archived')),
  security_status TEXT NOT NULL DEFAULT 'protected' CHECK (security_status IN ('protected', 'needs_policy', 'credentials_suspended')),
  avatar_icon TEXT NOT NULL DEFAULT 'bot',
  instructions JSONB NOT NULL DEFAULT '{}'::jsonb,
  permissions_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  actions_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMPTZ,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Versões de Agentes
CREATE TABLE IF NOT EXISTS agent_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  instructions JSONB NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Credenciais de Agentes (apenas hash criptográfico)
CREATE TABLE IF NOT EXISTS agent_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'suspended')),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Ferramentas dos Agentes
CREATE TABLE IF NOT EXISTS agent_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_key TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  category TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  requires_approval BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Modelos de Agentes (Templates)
CREATE TABLE IF NOT EXISTS agent_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  objective TEXT NOT NULL,
  suggested_instructions JSONB NOT NULL,
  suggested_tools JSONB NOT NULL,
  suggested_permissions JSONB NOT NULL,
  recommended_restrictions JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Políticas de Governação e Segurança
CREATE TABLE IF NOT EXISTS policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  action_type TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('financial_threshold', 'block_always', 'require_approval', 'allow_if_verified')),
  max_auto_amount NUMERIC(12,2),
  max_approval_amount NUMERIC(12,2),
  currency TEXT NOT NULL DEFAULT 'EUR',
  conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_absolute_restriction BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'review_required', 'inactive')),
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. Atribuição de Políticas a Agentes
CREATE TABLE IF NOT EXISTS policy_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  policy_id UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(policy_id, agent_id)
);

-- 11. Pedidos de Autorização (Gateway & Interno)
CREATE TABLE IF NOT EXISTS authorization_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  tool_name TEXT,
  description TEXT NOT NULL,
  amount NUMERIC(12,2),
  currency TEXT DEFAULT 'EUR',
  resource_id TEXT,
  idempotency_key TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('ALLOWED', 'REQUIRES_APPROVAL', 'BLOCKED')),
  reason TEXT NOT NULL,
  policy_id UUID REFERENCES policies(id),
  is_simulation BOOLEAN NOT NULL DEFAULT FALSE,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, idempotency_key)
);

-- 12. Pedidos de Aprovação Humana
CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  authorization_request_id UUID NOT NULL REFERENCES authorization_requests(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  requested_action TEXT NOT NULL,
  description TEXT NOT NULL,
  financial_value NUMERIC(12,2),
  currency TEXT DEFAULT 'EUR',
  policy_name TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'Pendente' CHECK (status IN ('Pendente', 'Aprovado', 'Rejeitado', 'Expirado', 'Cancelado')),
  info_requested_note TEXT,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 13. Decisões de Aprovação
CREATE TABLE IF NOT EXISTS approval_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  approval_request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  approver_id UUID NOT NULL REFERENCES profiles(id),
  approver_name TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('Aprovado', 'Rejeitado', 'Informacao_Solicitada')),
  justification TEXT NOT NULL,
  policy_applied TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 14. Fluxos de Trabalho
CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'suspended')),
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 15. Nós de Fluxo de Trabalho
CREATE TABLE IF NOT EXISTS workflow_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL CHECK (node_type IN ('start', 'agent_task', 'condition', 'human_approval', 'notification', 'end')),
  label TEXT NOT NULL,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  position_x INTEGER NOT NULL DEFAULT 0,
  position_y INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 16. Ligações de Fluxo de Trabalho
CREATE TABLE IF NOT EXISTS workflow_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  source_node_id UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  target_node_id UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  condition_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 17. Execuções de Fluxo de Trabalho
CREATE TABLE IF NOT EXISTS workflow_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('completed', 'awaiting_approval', 'blocked', 'failed')),
  input_summary TEXT NOT NULL,
  steps_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  triggered_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 18. Integrações
CREATE TABLE IF NOT EXISTS integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider_key TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('ai_provider', 'business_system')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_configured' CHECK (status IN ('configured', 'not_configured', 'error')),
  required_credentials JSONB NOT NULL DEFAULT '[]'::jsonb,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  documentation_summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, provider_key)
);

-- 19. Notificações
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20. Registo de Auditoria (Append-Only)
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  reason TEXT NOT NULL,
  related_policy TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para isolamento e desempenho multi-tenant
CREATE INDEX IF NOT EXISTS idx_company_members_company ON company_members(company_id);
CREATE INDEX IF NOT EXISTS idx_company_members_user ON company_members(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_company ON agents(company_id);
CREATE INDEX IF NOT EXISTS idx_policies_company ON policies(company_id);
CREATE INDEX IF NOT EXISTS idx_auth_req_company ON authorization_requests(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_req_company ON approval_requests(company_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_company ON audit_logs(company_id, created_at DESC);

-- Ativar Row Level Security (RLS) em todas as tabelas multi-tenant
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorization_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Função auxiliar de isolamento por empresa
CREATE OR REPLACE FUNCTION is_company_member(target_company UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM company_members
    WHERE company_id = target_company
      AND user_id = auth.uid()
      AND status = 'active'
  );
$$ LANGUAGE sql SECURITY DEFINER;

-- Políticas RLS de Isolamento Estrito
CREATE POLICY tenant_isolation_companies ON companies FOR SELECT USING (is_company_member(id));
CREATE POLICY tenant_isolation_agents ON agents FOR ALL USING (is_company_member(company_id));
CREATE POLICY tenant_isolation_policies ON policies FOR ALL USING (is_company_member(company_id));
CREATE POLICY tenant_isolation_auth_requests ON authorization_requests FOR ALL USING (is_company_member(company_id));
CREATE POLICY tenant_isolation_approvals ON approval_requests FOR ALL USING (is_company_member(company_id));
CREATE POLICY tenant_isolation_workflows ON workflows FOR ALL USING (is_company_member(company_id));
CREATE POLICY tenant_isolation_audit_select ON audit_logs FOR SELECT USING (is_company_member(company_id));
CREATE POLICY tenant_isolation_audit_insert ON audit_logs FOR INSERT WITH CHECK (is_company_member(company_id));
-- Nota: audit_logs não tem política de UPDATE ou DELETE (append-only).
