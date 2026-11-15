import crypto from 'node:crypto';
import type {
  ApprovalRequestRecord,
  ApprovalStatus,
  AuthorizationDecision,
  AuthorizationRequestRecord,
  RiskLevel,
} from '../../../shared/types.ts';
import {
  parseBoolCell,
  parseJsonCell,
  parseNumberCell,
  WORKSHEET_NAMES,
} from '../sheetSchema.ts';
import { executeSerializedMultiSheetWrite, TenantSheetRepository } from './baseRepository.ts';

export interface IdempotencyRecord {
  id: string;
  company_id: string;
  idempotency_key: string;
  authorization_request_id: string;
  decision: AuthorizationDecision;
  response: Record<string, unknown>;
  created_at: string;
}

export class ApprovalsRepository {
  private readonly companyId: string;
  private readonly authReqRepo: TenantSheetRepository;
  private readonly approvalReqRepo: TenantSheetRepository;
  private readonly decisionsRepo: TenantSheetRepository;
  private readonly agentsRepo: TenantSheetRepository;
  private readonly idempotencyRepo: TenantSheetRepository;

  constructor(companyId: string) {
    this.companyId = companyId;
    this.authReqRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.AuthorizationRequests);
    this.approvalReqRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.ApprovalRequests);
    this.decisionsRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.ApprovalDecisions);
    this.agentsRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.Agents);
    this.idempotencyRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.IdempotencyRecords);
  }

  async listAuthorizationRequests(agentId?: string): Promise<AuthorizationRequestRecord[]> {
    const [rows, agents] = await Promise.all([
      this.authReqRepo.findAll(),
      this.agentsRepo.findAll(),
    ]);
    const agentNameMap = new Map(agents.map((a) => [a.id, a.name]));

    return rows
      .filter((r) => !agentId || r.agent_id === agentId)
      .map((r) => ({
        id: r.id,
        company_id: r.company_id || this.companyId,
        agent_id: r.agent_id,
        agent_name: agentNameMap.get(r.agent_id) || 'Agente',
        action_type: r.action_type,
        tool_name: r.tool_name || null,
        description: r.description,
        amount: parseNumberCell(r.amount),
        currency: r.currency || 'EUR',
        resource_id: r.resource_id || null,
        idempotency_key: r.idempotency_key || null,
        decision: r.decision as AuthorizationDecision,
        reason: r.reason,
        policy_id: r.policy_id || null,
        is_simulation: parseBoolCell(r.is_simulation),
        is_demo: parseBoolCell(r.is_demo),
        created_at: r.created_at,
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async findIdempotencyRecord(idempotencyKey: string): Promise<IdempotencyRecord | null> {
    const rows = await this.idempotencyRepo.findByField('idempotency_key', idempotencyKey);
    const hit = rows[0];
    if (hit) {
      return {
        id: hit.id,
        company_id: hit.company_id || this.companyId,
        idempotency_key: hit.idempotency_key,
        authorization_request_id: hit.authorization_request_id,
        decision: hit.decision as AuthorizationDecision,
        response: parseJsonCell<Record<string, unknown>>(hit.response_json, {}),
        created_at: hit.created_at,
      };
    }

    // Fallback: verificar AuthorizationRequests diretamente
    const existingAuth = (await this.authReqRepo.findByField('idempotency_key', idempotencyKey))[0];
    if (!existingAuth) return null;

    if (existingAuth.decision === 'REQUIRES_APPROVAL') {
      const aprs = await this.approvalReqRepo.findByField('authorization_request_id', existingAuth.id);
      return {
        id: existingAuth.id,
        company_id: this.companyId,
        idempotency_key: idempotencyKey,
        authorization_request_id: existingAuth.id,
        decision: 'REQUIRES_APPROVAL',
        response: {
          decision: 'REQUIRES_APPROVAL',
          approval_request_id: aprs[0]?.id ?? null,
        },
        created_at: existingAuth.created_at,
      };
    }

    return {
      id: existingAuth.id,
      company_id: this.companyId,
      idempotency_key: idempotencyKey,
      authorization_request_id: existingAuth.id,
      decision: existingAuth.decision as AuthorizationDecision,
      response:
        existingAuth.decision === 'ALLOWED'
          ? { decision: 'ALLOWED', authorization_id: existingAuth.id }
          : { decision: 'BLOCKED', reason: existingAuth.reason },
      created_at: existingAuth.created_at,
    };
  }

  async recordAuthorizationAndOptionalApproval(input: {
    agentId: string;
    actionType: string;
    toolName: string | null;
    description: string;
    amount: number | null;
    currency: string;
    resourceId: string | null;
    idempotencyKey: string | null;
    decision: AuthorizationDecision;
    reason: string;
    policyId: string | null;
    policyName: string | null;
    riskLevel: RiskLevel;
    isSimulation: boolean;
    createApproval: boolean;
    workflowExecutionId?: string | null;
    expiresInHours?: number;
  }): Promise<{ authorizationId: string; approvalRequestId: string | null }> {
    const now = new Date();
    const nowIso = now.toISOString();
    const authId = crypto.randomUUID();
    const approvalId = input.createApproval ? crypto.randomUUID() : null;
    const expiresAt = new Date(now.getTime() + (input.expiresInHours ?? 72) * 3_600_000).toISOString();

    const batches: Array<{
      worksheet: (typeof WORKSHEET_NAMES)[keyof typeof WORKSHEET_NAMES];
      inserts: Array<Record<string, unknown>>;
    }> = [
      {
        worksheet: WORKSHEET_NAMES.AuthorizationRequests,
        inserts: [
          {
            id: authId,
            company_id: this.companyId,
            agent_id: input.agentId,
            action_type: input.actionType,
            tool_name: input.toolName ?? '',
            description: input.description,
            amount: input.amount ?? '',
            currency: input.currency || 'EUR',
            resource_id: input.resourceId ?? '',
            idempotency_key: input.idempotencyKey ?? '',
            decision: input.decision,
            reason: input.reason,
            policy_id: input.policyId ?? '',
            is_simulation: input.isSimulation,
            is_demo: false,
            created_at: nowIso,
          },
        ],
      },
    ];

    if (approvalId) {
      batches.push({
        worksheet: WORKSHEET_NAMES.ApprovalRequests,
        inserts: [
          {
            id: approvalId,
            company_id: this.companyId,
            authorization_request_id: authId,
            agent_id: input.agentId,
            requested_action: input.actionType,
            description: input.description,
            financial_value: input.amount ?? '',
            currency: input.currency || 'EUR',
            policy_name: input.policyName || 'Política de Governação',
            risk_level: input.riskLevel,
            status: 'Pendente',
            info_requested_note: '',
            expires_at: expiresAt,
            workflow_execution_id: input.workflowExecutionId ?? '',
            is_demo: false,
            created_at: nowIso,
            updated_at: nowIso,
          },
        ],
      });
    }

    if (input.idempotencyKey) {
      const responsePayload =
        input.decision === 'ALLOWED'
          ? { decision: 'ALLOWED', authorization_id: authId }
          : input.decision === 'REQUIRES_APPROVAL'
          ? { decision: 'REQUIRES_APPROVAL', approval_request_id: approvalId }
          : { decision: 'BLOCKED', reason: input.reason };

      batches.push({
        worksheet: WORKSHEET_NAMES.IdempotencyRecords,
        inserts: [
          {
            id: crypto.randomUUID(),
            company_id: this.companyId,
            idempotency_key: input.idempotencyKey,
            authorization_request_id: authId,
            decision: input.decision,
            response_json: JSON.stringify(responsePayload),
            created_at: nowIso,
          },
        ],
      });
    }

    await executeSerializedMultiSheetWrite(this.companyId, batches);
    return { authorizationId: authId, approvalRequestId: approvalId };
  }

  async listApprovalRequests(): Promise<ApprovalRequestRecord[]> {
    const [rows, decisions, agents] = await Promise.all([
      this.approvalReqRepo.findAll(),
      this.decisionsRepo.findAll(),
      this.agentsRepo.findAll(),
    ]);

    const agentNameMap = new Map(agents.map((a) => [a.id, a.name]));
    const decisionsByApproval = new Map<string, ApprovalRequestRecord['decision_history']>();
    for (const d of decisions) {
      const list = decisionsByApproval.get(d.approval_request_id) || [];
      list.push({
        id: d.id,
        approver_name: d.approver_name,
        decision: d.decision,
        justification: d.justification,
        policy_applied: d.policy_applied,
        created_at: d.created_at,
      });
      decisionsByApproval.set(d.approval_request_id, list);
    }

    const nowMs = Date.now();
    return rows
      .map((r) => {
        const exp = r.expires_at ? Date.parse(r.expires_at) : NaN;
        const effectiveStatus: ApprovalStatus =
          r.status === 'Pendente' && Number.isFinite(exp) && exp < nowMs
            ? 'Expirado'
            : (r.status as ApprovalStatus);

        return {
          id: r.id,
          company_id: r.company_id || this.companyId,
          authorization_request_id: r.authorization_request_id,
          agent_id: r.agent_id,
          agent_name: agentNameMap.get(r.agent_id) || 'Agente',
          requested_action: r.requested_action,
          description: r.description,
          financial_value: parseNumberCell(r.financial_value),
          currency: r.currency || 'EUR',
          policy_name: r.policy_name,
          risk_level: (r.risk_level as RiskLevel) || 'medium',
          status: effectiveStatus,
          info_requested_note: r.info_requested_note || null,
          expires_at: r.expires_at || null,
          workflow_execution_id: r.workflow_execution_id || null,
          is_demo: parseBoolCell(r.is_demo),
          created_at: r.created_at,
          updated_at: r.updated_at,
          decision_history: (decisionsByApproval.get(r.id) || []).sort((a, b) =>
            b.created_at.localeCompare(a.created_at)
          ),
        };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getApprovalById(id: string): Promise<ApprovalRequestRecord | null> {
    const all = await this.listApprovalRequests();
    return all.find((a) => a.id === id) || null;
  }

  async markApprovalExpired(id: string): Promise<void> {
    await this.approvalReqRepo.update(id, {
      status: 'Expirado',
      updated_at: new Date().toISOString(),
    });
  }

  async applyApprovalDecision(input: {
    approvalId: string;
    approverId: string;
    approverName: string;
    decision: 'Aprovado' | 'Rejeitado' | 'Informacao_Solicitada';
    justification: string;
    policyApplied: string;
    existingInfoNote: string | null;
  }): Promise<ApprovalStatus> {
    const now = new Date().toISOString();
    const nextStatus: ApprovalStatus =
      input.decision === 'Aprovado'
        ? 'Aprovado'
        : input.decision === 'Rejeitado'
        ? 'Rejeitado'
        : 'Pendente';

    await executeSerializedMultiSheetWrite(this.companyId, [
      {
        worksheet: WORKSHEET_NAMES.ApprovalRequests,
        updates: [
          {
            id: input.approvalId,
            patch: {
              status: nextStatus,
              info_requested_note:
                input.decision === 'Informacao_Solicitada'
                  ? input.justification
                  : input.existingInfoNote ?? '',
              updated_at: now,
            },
          },
        ],
      },
      {
        worksheet: WORKSHEET_NAMES.ApprovalDecisions,
        inserts: [
          {
            id: crypto.randomUUID(),
            company_id: this.companyId,
            approval_request_id: input.approvalId,
            approver_id: input.approverId,
            approver_name: input.approverName,
            decision: input.decision,
            justification: input.justification,
            policy_applied: input.policyApplied,
            created_at: now,
          },
        ],
      },
    ]);

    return nextStatus;
  }
}
