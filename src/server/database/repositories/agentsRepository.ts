import crypto from 'node:crypto';
import type {
  Agent,
  AgentInstructions,
  AgentPermissionsConfig,
  AgentTool,
  Policy,
} from '../../../shared/types.ts';
import { TOOL_CATALOG } from '../../seedTemplates.ts';
import { generateAgentCredential } from '../../security.ts';
import { parseBoolCell, parseJsonCell, parseNumberCell, WORKSHEET_NAMES } from '../sheetSchema.ts';
import { executeSerializedMultiSheetWrite, TenantSheetRepository } from './baseRepository.ts';

export interface AgentVersionRecord {
  id: string;
  company_id: string;
  agent_id: string;
  version_number: number;
  instructions: string;
  model: string;
  provider: string;
  created_by: string;
  created_at: string;
}

export class AgentsRepository {
  private readonly companyId: string;
  private readonly agentsRepo: TenantSheetRepository;
  private readonly versionsRepo: TenantSheetRepository;
  private readonly credentialsRepo: TenantSheetRepository;
  private readonly toolsRepo: TenantSheetRepository;
  private readonly policiesRepo: TenantSheetRepository;
  private readonly policyAssignmentsRepo: TenantSheetRepository;

  constructor(companyId: string) {
    this.companyId = companyId;
    this.agentsRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.Agents);
    this.versionsRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.AgentVersions);
    this.credentialsRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.AgentCredentials);
    this.toolsRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.AgentTools);
    this.policiesRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.Policies);
    this.policyAssignmentsRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.PolicyAssignments);
  }

  private hydratePolicy(row: Record<string, string>): Policy {
    return {
      id: row.id,
      company_id: row.company_id || this.companyId,
      name: row.name,
      description: row.description,
      action_type: row.action_type,
      rule_type: row.rule_type as Policy['rule_type'],
      max_auto_amount: parseNumberCell(row.max_auto_amount),
      max_approval_amount: parseNumberCell(row.max_approval_amount),
      currency: row.currency || 'EUR',
      conditions: parseJsonCell<Policy['conditions']>(row.conditions_json, {}),
      is_absolute_restriction: parseBoolCell(row.is_absolute_restriction),
      status: (row.status as Policy['status']) || 'active',
      is_demo: parseBoolCell(row.is_demo),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private hydrateAgentRow(
    row: Record<string, string>,
    tools: AgentTool[],
    policies: Policy[],
    cred: { key_prefix: string; status: 'active' | 'revoked' | 'suspended' } | null
  ): Agent {
    return {
      id: row.id,
      company_id: row.company_id || this.companyId,
      name: row.name,
      description: row.description,
      category: row.category,
      objective: row.objective,
      origin: (row.origin as Agent['origin']) || 'MANDATO',
      provider: row.provider,
      model: row.model,
      external_identifier: row.external_identifier || null,
      status: (row.status as Agent['status']) || 'draft',
      security_status: (row.security_status as Agent['security_status']) || 'needs_policy',
      avatar_icon: row.avatar_icon || 'bot',
      instructions: parseJsonCell<AgentInstructions>(row.instructions_json, {
        role: row.name,
        objective: row.objective,
        responsibilities: [],
        behaviour: '',
        communication_style: '',
        rules: [],
        restrictions: [],
        expected_output: '',
      }),
      permissions_summary: parseJsonCell<AgentPermissionsConfig>(row.permissions_summary_json, {
        read_permissions: [],
        write_permissions: [],
        max_auto_financial_limit_eur: 0,
        max_approval_financial_limit_eur: 0,
        allowed_resources: [],
        restricted_resources: [],
        actions_requiring_approval: [],
        always_blocked_actions: [],
      }),
      actions_count: Number(row.actions_count || 0),
      last_activity_at: row.last_activity_at || null,
      is_demo: parseBoolCell(row.is_demo),
      created_at: row.created_at,
      updated_at: row.updated_at,
      tools: tools.sort((a, b) => a.tool_name.localeCompare(b.tool_name)),
      policies,
      credential_prefix: cred?.key_prefix ?? null,
      credential_status: cred?.status ?? null,
    };
  }

  async listAgents(): Promise<Agent[]> {
    const [agentRows, toolRows, policyRows, assignRows, credRows] = await Promise.all([
      this.agentsRepo.findAll(),
      this.toolsRepo.findAll(),
      this.policiesRepo.findAll(),
      this.policyAssignmentsRepo.findAll(),
      this.credentialsRepo.findAll(),
    ]);

    const policyById = new Map<string, Policy>(
      policyRows.map((p) => [p.id, this.hydratePolicy(p)])
    );

    const toolsByAgent = new Map<string, AgentTool[]>();
    for (const t of toolRows) {
      const list = toolsByAgent.get(t.agent_id) || [];
      list.push({
        id: t.id,
        agent_id: t.agent_id,
        tool_key: t.tool_key,
        tool_name: t.tool_name,
        category: t.category,
        risk_level: t.risk_level as AgentTool['risk_level'],
        is_enabled: parseBoolCell(t.is_enabled),
        requires_approval: parseBoolCell(t.requires_approval),
      });
      toolsByAgent.set(t.agent_id, list);
    }

    const policiesByAgent = new Map<string, Policy[]>();
    for (const a of assignRows) {
      const pol = policyById.get(a.policy_id);
      if (!pol) continue;
      const list = policiesByAgent.get(a.agent_id) || [];
      list.push(pol);
      policiesByAgent.set(a.agent_id, list);
    }

    const latestCredByAgent = new Map<string, { key_prefix: string; status: 'active' | 'revoked' | 'suspended'; created_at: string }>();
    for (const c of credRows) {
      const prev = latestCredByAgent.get(c.agent_id);
      if (!prev || c.created_at > prev.created_at) {
        latestCredByAgent.set(c.agent_id, {
          key_prefix: c.key_prefix,
          status: (c.status as 'active' | 'revoked' | 'suspended') || 'active',
          created_at: c.created_at,
        });
      }
    }

    return agentRows
      .map((row) =>
        this.hydrateAgentRow(
          row,
          toolsByAgent.get(row.id) || [],
          policiesByAgent.get(row.id) || [],
          latestCredByAgent.get(row.id) || null
        )
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getAgentById(id: string): Promise<Agent | null> {
    const all = await this.listAgents();
    return all.find((a) => a.id === id) || null;
  }

  async countNonArchivedAgents(): Promise<number> {
    const rows = await this.agentsRepo.findAll();
    return rows.filter((r) => r.status !== 'archived').length;
  }

  async listVersions(agentId: string): Promise<AgentVersionRecord[]> {
    const rows = await this.versionsRepo.findByField('agent_id', agentId);
    return rows
      .map((r) => ({
        id: r.id,
        company_id: r.company_id || this.companyId,
        agent_id: r.agent_id,
        version_number: Number(r.version_number || 1),
        instructions: r.instructions_json,
        model: r.model,
        provider: r.provider,
        created_by: r.created_by,
        created_at: r.created_at,
      }))
      .sort((a, b) => b.version_number - a.version_number);
  }

  async createAgent(input: {
    name: string;
    description: string;
    category: string;
    objective: string;
    origin: Agent['origin'];
    provider: string;
    model: string;
    externalIdentifier: string | null;
    status: Agent['status'];
    avatarIcon: string;
    instructions: AgentInstructions;
    permissionsSummary: AgentPermissionsConfig;
    policyIds: string[];
    selectedTools: Array<{ tool_key: string; is_enabled: boolean; requires_approval: boolean }>;
    createdBy: string;
  }): Promise<{ agent: Agent; rawApiKey: string; keyHash: string }> {
    const agentId = crypto.randomUUID();
    const now = new Date().toISOString();
    const cred = generateAgentCredential(input.origin === 'EXTERNAL' ? 'mdt_ext' : 'mdt_live');

    const existingPolicies = await this.policiesRepo.findAll();
    const validPolicyIdSet = new Set(existingPolicies.map((p) => p.id));
    const validPolicyIds = Array.from(new Set(input.policyIds.filter((pid) => validPolicyIdSet.has(pid))));
    const secStatus: Agent['security_status'] = validPolicyIds.length > 0 ? 'protected' : 'needs_policy';

    const selectionMap = new Map(input.selectedTools.map((t) => [t.tool_key, t]));
    const toolRows = TOOL_CATALOG.map((catTool) => {
      const picked = selectionMap.get(catTool.tool_key);
      return {
        id: crypto.randomUUID(),
        company_id: this.companyId,
        agent_id: agentId,
        tool_key: catTool.tool_key,
        tool_name: catTool.tool_name,
        category: catTool.category,
        risk_level: catTool.risk_level,
        is_enabled: picked ? Boolean(picked.is_enabled) : false,
        requires_approval: picked ? Boolean(picked.requires_approval) : catTool.default_requires_approval,
        created_at: now,
      };
    });

    const assignmentRows = validPolicyIds.map((pid) => ({
      id: crypto.randomUUID(),
      company_id: this.companyId,
      policy_id: pid,
      agent_id: agentId,
      created_at: now,
    }));

    await executeSerializedMultiSheetWrite(this.companyId, [
      {
        worksheet: WORKSHEET_NAMES.Agents,
        inserts: [
          {
            id: agentId,
            company_id: this.companyId,
            name: input.name,
            description: input.description,
            category: input.category,
            objective: input.objective,
            origin: input.origin,
            provider: input.provider,
            model: input.model,
            external_identifier: input.externalIdentifier ?? '',
            status: input.status,
            security_status: secStatus,
            avatar_icon: input.avatarIcon,
            instructions_json: JSON.stringify(input.instructions),
            permissions_summary_json: JSON.stringify(input.permissionsSummary),
            actions_count: 0,
            last_activity_at: '',
            is_demo: false,
            created_by: input.createdBy,
            created_at: now,
            updated_at: now,
          },
        ],
      },
      {
        worksheet: WORKSHEET_NAMES.AgentVersions,
        inserts: [
          {
            id: crypto.randomUUID(),
            company_id: this.companyId,
            agent_id: agentId,
            version_number: 1,
            instructions_json: JSON.stringify(input.instructions),
            model: input.model,
            provider: input.provider,
            created_by: input.createdBy,
            created_at: now,
          },
        ],
      },
      {
        worksheet: WORKSHEET_NAMES.AgentCredentials,
        inserts: [
          {
            id: crypto.randomUUID(),
            company_id: this.companyId,
            agent_id: agentId,
            key_prefix: cred.keyPrefix,
            key_hash: cred.keyHash,
            status: 'active',
            last_used_at: '',
            created_at: now,
          },
        ],
      },
      { worksheet: WORKSHEET_NAMES.AgentTools, inserts: toolRows },
      { worksheet: WORKSHEET_NAMES.PolicyAssignments, inserts: assignmentRows },
    ]);

    const created = (await this.getAgentById(agentId))!;
    return { agent: created, rawApiKey: cred.rawKey, keyHash: cred.keyHash };
  }

  async updateAgent(
    id: string,
    patch: {
      name?: string;
      description?: string;
      provider?: string;
      model?: string;
      instructions?: AgentInstructions;
      permissions_summary?: AgentPermissionsConfig;
      updatedBy: string;
    }
  ): Promise<Agent | null> {
    const existing = await this.agentsRepo.findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const nextInstructions = patch.instructions ? JSON.stringify(patch.instructions) : existing.instructions_json;
    const nextPerms = patch.permissions_summary
      ? JSON.stringify(patch.permissions_summary)
      : existing.permissions_summary_json;
    const nextModel = patch.model ?? existing.model;
    const nextProvider = patch.provider ?? existing.provider;

    const versions = await this.versionsRepo.findByField('agent_id', id);
    const maxVer = versions.reduce((m, v) => Math.max(m, Number(v.version_number || 0)), 0);

    await executeSerializedMultiSheetWrite(this.companyId, [
      {
        worksheet: WORKSHEET_NAMES.Agents,
        updates: [
          {
            id,
            patch: {
              name: patch.name ?? existing.name,
              description: patch.description ?? existing.description,
              provider: nextProvider,
              model: nextModel,
              instructions_json: nextInstructions,
              permissions_summary_json: nextPerms,
              updated_at: now,
            },
          },
        ],
      },
      {
        worksheet: WORKSHEET_NAMES.AgentVersions,
        inserts: [
          {
            id: crypto.randomUUID(),
            company_id: this.companyId,
            agent_id: id,
            version_number: maxVer + 1,
            instructions_json: nextInstructions,
            model: nextModel,
            provider: nextProvider,
            created_by: patch.updatedBy,
            created_at: now,
          },
        ],
      },
    ]);

    return this.getAgentById(id);
  }

  async updateAgentStatus(id: string, status: Agent['status']): Promise<Agent | null> {
    const existing = await this.agentsRepo.findById(id);
    if (!existing) return null;
    await this.agentsRepo.update(id, { status, updated_at: new Date().toISOString() });
    return this.getAgentById(id);
  }

  async duplicateAgent(sourceId: string, createdBy: string): Promise<{ agent: Agent; keyHash: string } | null> {
    const source = await this.getAgentById(sourceId);
    if (!source) return null;

    const newId = crypto.randomUUID();
    const now = new Date().toISOString();
    const cred = generateAgentCredential('mdt_live');
    const copyName = `${source.name} (Cópia)`;

    const toolRows = (source.tools || []).map((t) => ({
      id: crypto.randomUUID(),
      company_id: this.companyId,
      agent_id: newId,
      tool_key: t.tool_key,
      tool_name: t.tool_name,
      category: t.category,
      risk_level: t.risk_level,
      is_enabled: t.is_enabled,
      requires_approval: t.requires_approval,
      created_at: now,
    }));

    const policyRows = (source.policies || []).map((p) => ({
      id: crypto.randomUUID(),
      company_id: this.companyId,
      policy_id: p.id,
      agent_id: newId,
      created_at: now,
    }));

    await executeSerializedMultiSheetWrite(this.companyId, [
      {
        worksheet: WORKSHEET_NAMES.Agents,
        inserts: [
          {
            id: newId,
            company_id: this.companyId,
            name: copyName,
            description: source.description,
            category: source.category,
            objective: source.objective,
            origin: source.origin,
            provider: source.provider,
            model: source.model,
            external_identifier: '',
            status: 'draft',
            security_status: source.security_status,
            avatar_icon: source.avatar_icon,
            instructions_json: JSON.stringify(source.instructions),
            permissions_summary_json: JSON.stringify(source.permissions_summary),
            actions_count: 0,
            last_activity_at: '',
            is_demo: false,
            created_by: createdBy,
            created_at: now,
            updated_at: now,
          },
        ],
      },
      {
        worksheet: WORKSHEET_NAMES.AgentCredentials,
        inserts: [
          {
            id: crypto.randomUUID(),
            company_id: this.companyId,
            agent_id: newId,
            key_prefix: cred.keyPrefix,
            key_hash: cred.keyHash,
            status: 'active',
            last_used_at: '',
            created_at: now,
          },
        ],
      },
      { worksheet: WORKSHEET_NAMES.AgentTools, inserts: toolRows },
      { worksheet: WORKSHEET_NAMES.PolicyAssignments, inserts: policyRows },
    ]);

    const created = (await this.getAgentById(newId))!;
    return { agent: created, keyHash: cred.keyHash };
  }

  async updateAgentTool(
    agentId: string,
    toolId: string,
    isEnabled: boolean,
    requiresApproval: boolean
  ): Promise<{ agent: Agent; toolName: string } | null> {
    const tool = await this.toolsRepo.findById(toolId);
    if (!tool || tool.agent_id !== agentId) return null;
    await this.toolsRepo.update(toolId, {
      is_enabled: isEnabled,
      requires_approval: requiresApproval,
    });
    const updatedAgent = await this.getAgentById(agentId);
    if (!updatedAgent) return null;
    return { agent: updatedAgent, toolName: tool.tool_name };
  }

  async rotateCredential(agentId: string): Promise<{
    agent: Agent;
    rawKey: string;
    keyPrefix: string;
    keyHash: string;
  } | null> {
    const agent = await this.getAgentById(agentId);
    if (!agent) return null;
    const cred = generateAgentCredential(agent.origin === 'EXTERNAL' ? 'mdt_ext' : 'mdt_live');
    const now = new Date().toISOString();
    const existingCreds = await this.credentialsRepo.findByField('agent_id', agentId);

    await executeSerializedMultiSheetWrite(this.companyId, [
      {
        worksheet: WORKSHEET_NAMES.AgentCredentials,
        updates: existingCreds.map((c) => ({ id: c.id, patch: { status: 'revoked' } })),
        inserts: [
          {
            id: crypto.randomUUID(),
            company_id: this.companyId,
            agent_id: agentId,
            key_prefix: cred.keyPrefix,
            key_hash: cred.keyHash,
            status: 'active',
            last_used_at: '',
            created_at: now,
          },
        ],
      },
      {
        worksheet: WORKSHEET_NAMES.Agents,
        updates: [{ id: agentId, patch: { security_status: 'protected', updated_at: now } }],
      },
    ]);

    return {
      agent: (await this.getAgentById(agentId))!,
      rawKey: cred.rawKey,
      keyPrefix: cred.keyPrefix,
      keyHash: cred.keyHash,
    };
  }

  async revokeCredentials(agentId: string): Promise<Agent | null> {
    const agent = await this.getAgentById(agentId);
    if (!agent) return null;
    const now = new Date().toISOString();
    const existingCreds = await this.credentialsRepo.findByField('agent_id', agentId);

    await executeSerializedMultiSheetWrite(this.companyId, [
      {
        worksheet: WORKSHEET_NAMES.AgentCredentials,
        updates: existingCreds.map((c) => ({ id: c.id, patch: { status: 'revoked' } })),
      },
      {
        worksheet: WORKSHEET_NAMES.Agents,
        updates: [{ id: agentId, patch: { security_status: 'credentials_suspended', updated_at: now } }],
      },
    ]);

    return this.getAgentById(agentId);
  }

  async findCredentialByHash(keyHash: string): Promise<Record<string, string> | null> {
    const rows = await this.credentialsRepo.findByField('key_hash', keyHash);
    return rows[0] || null;
  }

  async recordAgentExecution(agentId: string, credentialId?: string): Promise<void> {
    const existing = await this.agentsRepo.findById(agentId);
    if (!existing) return;
    const now = new Date().toISOString();
    const currentCount = Number(existing.actions_count || 0);

    const batches: Array<{
      worksheet: (typeof WORKSHEET_NAMES)[keyof typeof WORKSHEET_NAMES];
      updates: Array<{ id: string; patch: Record<string, unknown> }>;
    }> = [
      {
        worksheet: WORKSHEET_NAMES.Agents,
        updates: [{ id: agentId, patch: { actions_count: currentCount + 1, last_activity_at: now } }],
      },
    ];
    if (credentialId) {
      batches.push({
        worksheet: WORKSHEET_NAMES.AgentCredentials,
        updates: [{ id: credentialId, patch: { last_used_at: now } }],
      });
    }
    await executeSerializedMultiSheetWrite(this.companyId, batches);
  }
}
