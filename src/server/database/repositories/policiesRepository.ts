import crypto from 'node:crypto';
import type { Policy } from '../../../shared/types.ts';
import {
  parseBoolCell,
  parseJsonCell,
  parseNumberCell,
  WORKSHEET_NAMES,
} from '../sheetSchema.ts';
import { executeSerializedMultiSheetWrite, TenantSheetRepository } from './baseRepository.ts';

export class PoliciesRepository {
  private readonly companyId: string;
  private readonly policiesRepo: TenantSheetRepository;
  private readonly assignmentsRepo: TenantSheetRepository;

  constructor(companyId: string) {
    this.companyId = companyId;
    this.policiesRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.Policies);
    this.assignmentsRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.PolicyAssignments);
  }

  private hydratePolicy(row: Record<string, string>, assignedAgentIds?: string[]): Policy {
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
      ...(assignedAgentIds ? { assigned_agent_ids: assignedAgentIds } : {}),
    };
  }

  async listPolicies(): Promise<Policy[]> {
    const [policyRows, assignmentRows] = await Promise.all([
      this.policiesRepo.findAll(),
      this.assignmentsRepo.findAll(),
    ]);
    const mapByPolicy = new Map<string, string[]>();
    for (const a of assignmentRows) {
      const list = mapByPolicy.get(a.policy_id) || [];
      list.push(a.agent_id);
      mapByPolicy.set(a.policy_id, list);
    }
    return policyRows
      .map((r) => this.hydratePolicy(r, mapByPolicy.get(r.id) || []))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getPolicyById(id: string): Promise<Policy | null> {
    const row = await this.policiesRepo.findById(id);
    if (!row) return null;
    const assigns = await this.assignmentsRepo.findByField('policy_id', id);
    return this.hydratePolicy(row, assigns.map((a) => a.agent_id));
  }

  async listAssignmentsForAgent(agentId: string): Promise<string[]> {
    const assigns = await this.assignmentsRepo.findByField('agent_id', agentId);
    return assigns.map((a) => a.policy_id);
  }

  async listAllAssignments(): Promise<Array<{ id: string; policy_id: string; agent_id: string }>> {
    const rows = await this.assignmentsRepo.findAll();
    return rows.map((r) => ({ id: r.id, policy_id: r.policy_id, agent_id: r.agent_id }));
  }

  async createPolicy(input: {
    name: string;
    description: string;
    actionType: string;
    ruleType: Policy['rule_type'];
    maxAutoAmount: number | null;
    maxApprovalAmount: number | null;
    conditions?: Policy['conditions'];
    isAbsoluteRestriction: boolean;
    agentIds?: string[];
  }): Promise<Policy> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const policyRecord = {
      id,
      company_id: this.companyId,
      name: input.name,
      description: input.description,
      action_type: input.actionType,
      rule_type: input.ruleType,
      max_auto_amount: input.maxAutoAmount ?? '',
      max_approval_amount: input.maxApprovalAmount ?? '',
      currency: 'EUR',
      conditions_json: JSON.stringify(input.conditions || {}),
      is_absolute_restriction: input.isAbsoluteRestriction,
      status: 'active',
      is_demo: false,
      created_at: now,
      updated_at: now,
    };

    const agentIds = Array.from(new Set(input.agentIds || []));
    const assignmentRecords = agentIds.map((agId) => ({
      id: crypto.randomUUID(),
      company_id: this.companyId,
      policy_id: id,
      agent_id: agId,
      created_at: now,
    }));

    const agentUpdates = agentIds.map((agId) => ({
      id: agId,
      patch: { security_status: 'protected', updated_at: now },
    }));

    await executeSerializedMultiSheetWrite(this.companyId, [
      { worksheet: WORKSHEET_NAMES.Policies, inserts: [policyRecord] },
      { worksheet: WORKSHEET_NAMES.PolicyAssignments, inserts: assignmentRecords },
      { worksheet: WORKSHEET_NAMES.Agents, updates: agentUpdates },
    ]);

    return {
      id,
      company_id: this.companyId,
      name: input.name,
      description: input.description,
      action_type: input.actionType,
      rule_type: input.ruleType,
      max_auto_amount: input.maxAutoAmount,
      max_approval_amount: input.maxApprovalAmount,
      currency: 'EUR',
      conditions: input.conditions || {},
      is_absolute_restriction: input.isAbsoluteRestriction,
      status: 'active',
      is_demo: false,
      created_at: now,
      updated_at: now,
      assigned_agent_ids: agentIds,
    };
  }

  async updatePolicy(
    id: string,
    patch: {
      status?: Policy['status'];
      maxAutoAmount?: number | null;
      maxApprovalAmount?: number | null;
    }
  ): Promise<Policy | null> {
    const existing = await this.policiesRepo.findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updated = await this.policiesRepo.update(id, {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.maxAutoAmount !== undefined ? { max_auto_amount: patch.maxAutoAmount ?? '' } : {}),
      ...(patch.maxApprovalAmount !== undefined ? { max_approval_amount: patch.maxApprovalAmount ?? '' } : {}),
      updated_at: now,
    });
    if (!updated) return null;
    const assigns = await this.assignmentsRepo.findByField('policy_id', id);
    return this.hydratePolicy(updated, assigns.map((a) => a.agent_id));
  }
}
