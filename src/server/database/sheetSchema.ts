export const WORKSHEET_NAMES = {
  CompanySettings: 'CompanySettings',
  Users: 'Users',
  CompanyMembers: 'CompanyMembers',
  Agents: 'Agents',
  AgentVersions: 'AgentVersions',
  AgentCredentials: 'AgentCredentials',
  AgentTools: 'AgentTools',
  Policies: 'Policies',
  PolicyAssignments: 'PolicyAssignments',
  AuthorizationRequests: 'AuthorizationRequests',
  ApprovalRequests: 'ApprovalRequests',
  ApprovalDecisions: 'ApprovalDecisions',
  Workflows: 'Workflows',
  WorkflowNodes: 'WorkflowNodes',
  WorkflowEdges: 'WorkflowEdges',
  WorkflowExecutions: 'WorkflowExecutions',
  Integrations: 'Integrations',
  Notifications: 'Notifications',
  AuditLogs: 'AuditLogs',
  IdempotencyRecords: 'IdempotencyRecords',
} as const;

export type WorksheetName = (typeof WORKSHEET_NAMES)[keyof typeof WORKSHEET_NAMES];

export const WORKSHEET_HEADERS: Record<WorksheetName, readonly string[]> = {
  CompanySettings: [
    'id',
    'company_id',
    'name',
    'slug',
    'nif',
    'sector',
    'subscription_plan',
    'is_demo',
    'retention_days',
    'created_at',
    'updated_at',
  ],
  Users: [
    'id',
    'company_id',
    'email',
    'full_name',
    'job_title',
    'avatar_initials',
    'created_at',
    'updated_at',
  ],
  CompanyMembers: [
    'id',
    'company_id',
    'user_id',
    'email',
    'full_name',
    'job_title',
    'role',
    'status',
    'created_at',
    'updated_at',
  ],
  Agents: [
    'id',
    'company_id',
    'name',
    'description',
    'category',
    'objective',
    'origin',
    'provider',
    'model',
    'external_identifier',
    'status',
    'security_status',
    'avatar_icon',
    'instructions_json',
    'permissions_summary_json',
    'actions_count',
    'last_activity_at',
    'is_demo',
    'created_by',
    'created_at',
    'updated_at',
  ],
  AgentVersions: [
    'id',
    'company_id',
    'agent_id',
    'version_number',
    'instructions_json',
    'model',
    'provider',
    'created_by',
    'created_at',
  ],
  AgentCredentials: [
    'id',
    'company_id',
    'agent_id',
    'key_prefix',
    'key_hash',
    'status',
    'last_used_at',
    'created_at',
  ],
  AgentTools: [
    'id',
    'company_id',
    'agent_id',
    'tool_key',
    'tool_name',
    'category',
    'risk_level',
    'is_enabled',
    'requires_approval',
    'created_at',
  ],
  Policies: [
    'id',
    'company_id',
    'name',
    'description',
    'action_type',
    'rule_type',
    'max_auto_amount',
    'max_approval_amount',
    'currency',
    'conditions_json',
    'is_absolute_restriction',
    'status',
    'is_demo',
    'created_at',
    'updated_at',
  ],
  PolicyAssignments: [
    'id',
    'company_id',
    'policy_id',
    'agent_id',
    'created_at',
  ],
  AuthorizationRequests: [
    'id',
    'company_id',
    'agent_id',
    'action_type',
    'tool_name',
    'description',
    'amount',
    'currency',
    'resource_id',
    'idempotency_key',
    'decision',
    'reason',
    'policy_id',
    'is_simulation',
    'is_demo',
    'created_at',
  ],
  ApprovalRequests: [
    'id',
    'company_id',
    'authorization_request_id',
    'agent_id',
    'requested_action',
    'description',
    'financial_value',
    'currency',
    'policy_name',
    'risk_level',
    'status',
    'info_requested_note',
    'expires_at',
    'workflow_execution_id',
    'is_demo',
    'created_at',
    'updated_at',
  ],
  ApprovalDecisions: [
    'id',
    'company_id',
    'approval_request_id',
    'approver_id',
    'approver_name',
    'decision',
    'justification',
    'policy_applied',
    'created_at',
  ],
  Workflows: [
    'id',
    'company_id',
    'name',
    'description',
    'status',
    'is_demo',
    'created_at',
    'updated_at',
  ],
  WorkflowNodes: [
    'id',
    'company_id',
    'workflow_id',
    'node_type',
    'label',
    'agent_id',
    'config_json',
    'position_x',
    'position_y',
    'created_at',
  ],
  WorkflowEdges: [
    'id',
    'company_id',
    'workflow_id',
    'source_node_id',
    'target_node_id',
    'condition_label',
    'created_at',
  ],
  WorkflowExecutions: [
    'id',
    'company_id',
    'workflow_id',
    'status',
    'input_summary',
    'paused_node_id',
    'approval_request_id',
    'steps_log_json',
    'triggered_by',
    'created_at',
    'updated_at',
  ],
  Integrations: [
    'id',
    'company_id',
    'provider_key',
    'name',
    'category',
    'description',
    'status',
    'required_credentials_json',
    'capabilities_json',
    'documentation_summary',
    'created_at',
    'updated_at',
  ],
  Notifications: [
    'id',
    'company_id',
    'user_id',
    'title',
    'message',
    'severity',
    'read_at',
    'created_at',
  ],
  AuditLogs: [
    'id',
    'company_id',
    'actor_type',
    'actor_id',
    'actor_name',
    'event_type',
    'action',
    'result',
    'reason',
    'related_policy',
    'metadata_json',
    'is_demo',
    'created_at',
  ],
  IdempotencyRecords: [
    'id',
    'company_id',
    'idempotency_key',
    'authorization_request_id',
    'decision',
    'response_json',
    'created_at',
  ],
};

export const ALL_WORKSHEET_NAMES: WorksheetName[] = Object.keys(WORKSHEET_HEADERS) as WorksheetName[];

export function columnIndexToLetter(indexZeroBased: number): string {
  let n = indexZeroBased + 1;
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

export function serializeCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function parseBoolCell(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  const s = String(raw ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'sim';
}

export function parseNumberCell(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseJsonCell<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

export function serializeRowObject(
  worksheet: WorksheetName,
  record: Record<string, unknown>
): string[] {
  const headers = WORKSHEET_HEADERS[worksheet];
  return headers.map((col) => serializeCellValue(record[col]));
}

export function deserializeRowArray(
  worksheet: WorksheetName,
  rowValues: unknown[]
): Record<string, string> {
  const headers = WORKSHEET_HEADERS[worksheet];
  const obj: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) {
    obj[headers[i]] = rowValues[i] !== undefined && rowValues[i] !== null ? String(rowValues[i]) : '';
  }
  return obj;
}

export interface SchemaValidationReport {
  valid: boolean;
  missingWorksheets: WorksheetName[];
  headerMismatches: Array<{
    worksheet: WorksheetName;
    missingColumns: string[];
    expectedColumns: string[];
    actualColumns: string[];
  }>;
}
