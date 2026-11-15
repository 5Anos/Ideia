export type UserRole = 'OWNER' | 'ADMIN' | 'APPROVER' | 'OPERATOR' | 'VIEWER';

export type SubscriptionPlan = 'STARTER' | 'PROFESSIONAL' | 'BUSINESS';

export type AgentStatus = 'draft' | 'active' | 'running' | 'suspended' | 'archived';

export type AgentOrigin = 'MANDATO' | 'EXTERNAL';

export type SecurityStatus = 'protected' | 'needs_policy' | 'credentials_suspended';

export type AuthorizationDecision = 'ALLOWED' | 'REQUIRES_APPROVAL' | 'BLOCKED';

export type ApprovalStatus = 'Pendente' | 'Aprovado' | 'Rejeitado' | 'Expirado' | 'Cancelado';

export type PolicyRuleType =
  | 'financial_threshold'
  | 'block_always'
  | 'require_approval'
  | 'allow_if_verified';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type BusinessCategory =
  | 'Financeiro'
  | 'Administrativo'
  | 'Compras'
  | 'Atendimento ao Cliente'
  | 'Recursos Humanos'
  | 'Marketing'
  | 'Vendas'
  | 'Gestão de Projetos'
  | 'Análise de Dados'
  | 'Personalizado';

export interface Company {
  id: string;
  name: string;
  slug: string;
  nif: string;
  sector: string;
  subscription_plan: SubscriptionPlan;
  is_demo: boolean;
  retention_days: number;
  created_at: string;
}

export interface UserSession {
  user_id: string;
  email: string;
  full_name: string;
  job_title: string;
  role: UserRole;
  company_id: string;
  company_name: string;
  subscription_plan: SubscriptionPlan;
  is_demo_company: boolean;
}

export interface CompanyMember {
  id: string;
  company_id: string;
  user_id: string;
  email: string;
  full_name: string;
  job_title: string;
  role: UserRole;
  status: 'active' | 'invited' | 'suspended';
  created_at: string;
}

export interface AgentInstructions {
  role: string;
  objective: string;
  responsibilities: string[];
  behaviour: string;
  communication_style: string;
  rules: string[];
  restrictions: string[];
  expected_output: string;
}

export interface AgentPermissionsConfig {
  read_permissions: string[];
  write_permissions: string[];
  max_auto_financial_limit_eur: number;
  max_approval_financial_limit_eur: number;
  allowed_resources: string[];
  restricted_resources: string[];
  actions_requiring_approval: string[];
  always_blocked_actions: string[];
}

export interface AgentTool {
  id: string;
  agent_id: string;
  tool_key: string;
  tool_name: string;
  category: string;
  risk_level: RiskLevel;
  is_enabled: boolean;
  requires_approval: boolean;
}

export interface Agent {
  id: string;
  company_id: string;
  name: string;
  description: string;
  category: BusinessCategory | string;
  objective: string;
  origin: AgentOrigin;
  provider: string;
  model: string;
  external_identifier?: string | null;
  status: AgentStatus;
  security_status: SecurityStatus;
  avatar_icon: string;
  instructions: AgentInstructions;
  permissions_summary: AgentPermissionsConfig;
  actions_count: number;
  last_activity_at: string | null;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
  tools?: AgentTool[];
  policies?: Policy[];
  credential_prefix?: string | null;
  credential_status?: 'active' | 'revoked' | 'suspended' | null;
}

export interface AgentTemplate {
  id: string;
  name: string;
  category: BusinessCategory | string;
  description: string;
  objective: string;
  suggested_instructions: AgentInstructions;
  suggested_tools: Array<{
    tool_key: string;
    tool_name: string;
    category: string;
    risk_level: RiskLevel;
    default_enabled: boolean;
    requires_approval: boolean;
  }>;
  suggested_permissions: AgentPermissionsConfig;
  recommended_restrictions: string[];
}

export interface Policy {
  id: string;
  company_id: string;
  name: string;
  description: string;
  action_type: string;
  rule_type: PolicyRuleType;
  max_auto_amount: number | null;
  max_approval_amount: number | null;
  currency: string;
  conditions: {
    require_verified_destination?: boolean;
    exception_approved?: boolean;
    allowed_roles?: string[];
  };
  is_absolute_restriction: boolean;
  status: 'active' | 'review_required' | 'inactive';
  is_demo: boolean;
  created_at: string;
  updated_at: string;
}

export interface AuthorizationRequestRecord {
  id: string;
  company_id: string;
  agent_id: string;
  agent_name?: string;
  action_type: string;
  tool_name: string | null;
  description: string;
  amount: number | null;
  currency: string;
  resource_id: string | null;
  idempotency_key: string | null;
  decision: AuthorizationDecision;
  reason: string;
  policy_id: string | null;
  policy_name?: string | null;
  is_simulation: boolean;
  is_demo: boolean;
  created_at: string;
}

export interface ApprovalRequestRecord {
  id: string;
  company_id: string;
  authorization_request_id: string;
  agent_id: string;
  agent_name?: string;
  requested_action: string;
  description: string;
  financial_value: number | null;
  currency: string;
  policy_name: string;
  risk_level: RiskLevel;
  status: ApprovalStatus;
  info_requested_note: string | null;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
  decision_history?: Array<{
    id: string;
    approver_name: string;
    decision: string;
    justification: string;
    policy_applied: string;
    created_at: string;
  }>;
}

export type WorkflowNodeType =
  | 'start'
  | 'agent_task'
  | 'condition'
  | 'human_approval'
  | 'notification'
  | 'end';

export interface WorkflowNode {
  id: string;
  workflow_id: string;
  node_type: WorkflowNodeType;
  label: string;
  agent_id: string | null;
  config: {
    action_type?: string;
    amount?: number;
    description?: string;
    condition_expression?: string;
    recipient?: string;
  };
  position_x: number;
  position_y: number;
}

export interface WorkflowEdge {
  id: string;
  workflow_id: string;
  source_node_id: string;
  target_node_id: string;
  condition_label?: string | null;
}

export interface Workflow {
  id: string;
  company_id: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'suspended';
  is_demo: boolean;
  created_at: string;
  updated_at: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowExecution {
  id: string;
  workflow_id: string;
  workflow_name?: string;
  status: 'completed' | 'awaiting_approval' | 'blocked' | 'failed';
  input_summary: string;
  steps_log: Array<{
    node_id: string;
    label: string;
    node_type: WorkflowNodeType;
    status: string;
    decision?: AuthorizationDecision;
    detail: string;
    timestamp: string;
  }>;
  created_at: string;
}

export interface IntegrationItem {
  id: string;
  company_id: string;
  provider_key: string;
  name: string;
  category: 'ai_provider' | 'business_system';
  description: string;
  status: 'configured' | 'not_configured' | 'error';
  required_credentials: string[];
  capabilities: string[];
  documentation_summary: string;
  models?: Array<{
    id: string;
    name: string;
    available: boolean;
    note?: string;
  }>;
}

export interface AuditLogRecord {
  id: string;
  company_id: string;
  actor_type: 'user' | 'agent' | 'system';
  actor_id: string;
  actor_name: string;
  event_type: string;
  action: string;
  result: string;
  reason: string;
  related_policy: string | null;
  is_demo: boolean;
  created_at: string;
}
