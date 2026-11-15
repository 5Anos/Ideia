import type {
  Agent,
  AuthorizationDecision,
  Policy,
  Workflow,
  WorkflowEdge,
  WorkflowExecution,
  WorkflowNode,
} from '../shared/types.ts';
import { evaluateAuthorization } from './policyEngine.ts';
import type { TenantDatabaseContext } from './database/databaseManager.ts';

function evaluateConditionExpression(expr: string | undefined, amount: number | null): boolean {
  if (!expr || !expr.trim()) return true;
  const normalized = expr.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'sim') return true;
  if (normalized === 'false' || normalized === 'não' || normalized === 'nao') return false;

  const match = normalized.match(/^amount\s*(>=|<=|>|<|==|!=)\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return true;
  if (amount === null || !Number.isFinite(amount)) return false;

  const op = match[1];
  const rhs = Number(match[2]);
  if (op === '>') return amount > rhs;
  if (op === '>=') return amount >= rhs;
  if (op === '<') return amount < rhs;
  if (op === '<=') return amount <= rhs;
  if (op === '==') return amount === rhs;
  if (op === '!=') return amount !== rhs;
  return false;
}

function pickNextEdge(
  edges: WorkflowEdge[],
  sourceNodeId: string,
  branchOutcome?: string | null
): WorkflowEdge | null {
  const outgoing = edges.filter((e) => e.source_node_id === sourceNodeId);
  if (outgoing.length === 0) return null;

  if (branchOutcome) {
    const targetLabel = branchOutcome.trim().toLowerCase();
    const aliases: Record<string, string[]> = {
      true: ['true', 'sim', 'verdadeiro', 'yes', 'aprovado'],
      false: ['false', 'não', 'nao', 'falso', 'no', 'rejeitado'],
      aprovado: ['aprovado', 'approved', 'sim', 'true', 'ok'],
      rejeitado: ['rejeitado', 'rejected', 'não', 'nao', 'false'],
    };
    const candidates = aliases[targetLabel] || [targetLabel];
    const matched = outgoing.find(
      (e) => e.condition_label && candidates.includes(e.condition_label.trim().toLowerCase())
    );
    if (matched) return matched;
  }

  return outgoing.find((e) => !e.condition_label) || outgoing[0] || null;
}

export interface RunWorkflowParams {
  tenantDb: TenantDatabaseContext;
  workflow: Workflow;
  agents: Agent[];
  policies: Policy[];
  actorUserId: string;
  actorName: string;
  overrideAmount: number | null;
  inputSummary: string;
  executionId?: string;
  resumeFromNodeId?: string | null;
  resumeBranchDecision?: 'Aprovado' | 'Rejeitado' | null;
  initialStepsLog?: WorkflowExecution['steps_log'];
}

export interface RunWorkflowResult {
  executionId: string;
  status: WorkflowExecution['status'];
  pausedNodeId: string | null;
  approvalRequestId: string | null;
  stepsLog: WorkflowExecution['steps_log'];
}

export async function executeOrResumeWorkflowGraph(params: RunWorkflowParams): Promise<RunWorkflowResult> {
  const { tenantDb, workflow, agents, policies, actorUserId, actorName, overrideAmount, inputSummary } = params;
  const now = () => new Date().toISOString();

  const nodeMap = new Map<string, WorkflowNode>(workflow.nodes.map((n) => [n.id, n]));
  const agentMap = new Map<string, Agent>(agents.map((a) => [a.id, a]));
  const stepsLog: WorkflowExecution['steps_log'] = [...(params.initialStepsLog || [])];

  let currentNode: WorkflowNode | null = null;
  let forceNextOutcome: string | null = null;

  if (params.resumeFromNodeId) {
    const pausedNode = nodeMap.get(params.resumeFromNodeId) || null;
    if (!pausedNode) {
      return {
        executionId: params.executionId || '',
        status: 'failed',
        pausedNodeId: null,
        approvalRequestId: null,
        stepsLog,
      };
    }

    const decisionOutcome = params.resumeBranchDecision === 'Rejeitado' ? 'Rejeitado' : 'Aprovado';
    stepsLog.push({
      node_id: pausedNode.id,
      label: pausedNode.label,
      node_type: pausedNode.node_type,
      status: decisionOutcome === 'Aprovado' ? 'completed' : 'rejected',
      detail:
        decisionOutcome === 'Aprovado'
          ? `Aprovação humana concedida por ${actorName}. Fluxo retomado.`
          : `Pedido rejeitado por ${actorName}. A encaminhar para ramo de rejeição.`,
      timestamp: now(),
    });

    const nextEdge = pickNextEdge(workflow.edges, pausedNode.id, decisionOutcome);
    if (!nextEdge) {
      const finalStatus: WorkflowExecution['status'] = decisionOutcome === 'Rejeitado' ? 'blocked' : 'completed';
      const execId = await tenantDb.workflows.saveExecution({
        id: params.executionId,
        workflowId: workflow.id,
        status: finalStatus,
        inputSummary,
        pausedNodeId: null,
        approvalRequestId: null,
        stepsLog,
        triggeredBy: actorUserId,
      });
      return { executionId: execId, status: finalStatus, pausedNodeId: null, approvalRequestId: null, stepsLog };
    }
    currentNode = nodeMap.get(nextEdge.target_node_id) || null;
  } else {
    currentNode =
      workflow.nodes.find((n) => n.node_type === 'start') || workflow.nodes[0] || null;
  }

  let finalStatus: WorkflowExecution['status'] = 'completed';
  let pausedNodeId: string | null = null;
  let createdApprovalId: string | null = null;
  const executionIdDraft = params.executionId || crypto.randomUUID();
  const visitedCount = new Map<string, number>();

  while (currentNode) {
    const seen = (visitedCount.get(currentNode.id) || 0) + 1;
    if (seen > 3) {
      finalStatus = 'failed';
      stepsLog.push({
        node_id: currentNode.id,
        label: currentNode.label,
        node_type: currentNode.node_type,
        status: 'failed',
        detail: 'Ciclo detetado no grafo do fluxo de trabalho.',
        timestamp: now(),
      });
      break;
    }
    visitedCount.set(currentNode.id, seen);
    forceNextOutcome = null;

    if (currentNode.node_type === 'start') {
      stepsLog.push({
        node_id: currentNode.id,
        label: currentNode.label,
        node_type: 'start',
        status: 'completed',
        detail: 'Início da execução do fluxo.',
        timestamp: now(),
      });
    } else if (currentNode.node_type === 'condition') {
      const evalAmount = overrideAmount !== null ? overrideAmount : currentNode.config.amount ?? null;
      const condPassed = evaluateConditionExpression(currentNode.config.condition_expression, evalAmount);
      forceNextOutcome = condPassed ? 'true' : 'false';
      stepsLog.push({
        node_id: currentNode.id,
        label: currentNode.label,
        node_type: 'condition',
        status: 'completed',
        detail: `Condição "${currentNode.config.condition_expression || 'default'}" avaliada como ${condPassed ? 'Verdadeira' : 'Falsa'}.`,
        timestamp: now(),
      });
    } else if (currentNode.node_type === 'notification') {
      await tenantDb.settings.createNotification({
        title: `Fluxo "${workflow.name}"`,
        message: currentNode.config.description || `${currentNode.label}: ${inputSummary}`,
        severity: 'info',
      });
      stepsLog.push({
        node_id: currentNode.id,
        label: currentNode.label,
        node_type: 'notification',
        status: 'completed',
        detail: `Notificação enviada (${currentNode.config.recipient || 'equipa operacional'}).`,
        timestamp: now(),
      });
    } else if (currentNode.node_type === 'human_approval') {
      const approvalAgentId = workflow.nodes.find((n) => n.agent_id)?.agent_id || agents[0]?.id || '';
      const evalAmount = overrideAmount !== null ? overrideAmount : currentNode.config.amount ?? null;
      const rec = await tenantDb.approvals.recordAuthorizationAndOptionalApproval({
        agentId: approvalAgentId,
        actionType: currentNode.config.action_type || 'workflow_human_approval',
        toolName: null,
        description: `${workflow.name} — ${currentNode.label}: ${inputSummary}`,
        amount: evalAmount,
        currency: 'EUR',
        resourceId: workflow.id,
        idempotencyKey: null,
        decision: 'REQUIRES_APPROVAL',
        reason: 'Ponto de aprovação humana explícita no fluxo de trabalho.',
        policyId: null,
        policyName: 'Aprovação Humana de Fluxo',
        riskLevel: 'medium',
        isSimulation: false,
        createApproval: true,
        workflowExecutionId: executionIdDraft,
      });

      finalStatus = 'awaiting_approval';
      pausedNodeId = currentNode.id;
      createdApprovalId = rec.approvalRequestId;
      stepsLog.push({
        node_id: currentNode.id,
        label: currentNode.label,
        node_type: 'human_approval',
        status: 'awaiting_approval',
        decision: 'REQUIRES_APPROVAL',
        detail: 'Fluxo em pausa a aguardar validação humana na fila de aprovações.',
        timestamp: now(),
      });
      break;
    } else if (currentNode.node_type === 'agent_task') {
      const agent = currentNode.agent_id ? agentMap.get(currentNode.agent_id) || null : null;
      if (!agent) {
        finalStatus = 'blocked';
        stepsLog.push({
          node_id: currentNode.id,
          label: currentNode.label,
          node_type: 'agent_task',
          status: 'blocked',
          decision: 'BLOCKED',
          detail: 'Agente associado não encontrado ou pertencente a outra empresa.',
          timestamp: now(),
        });
        break;
      }

      const evalAmount = overrideAmount !== null ? overrideAmount : currentNode.config.amount ?? null;
      const actionType = currentNode.config.action_type || 'read_info';
      const evalRes = evaluateAuthorization({
        agent,
        agentTools: agent.tools || [],
        policies,
        request: {
          action_type: actionType,
          description: currentNode.config.description || `${workflow.name}: ${currentNode.label}`,
          amount: evalAmount,
          currency: 'EUR',
        },
      });

      const recorded = await tenantDb.approvals.recordAuthorizationAndOptionalApproval({
        agentId: agent.id,
        actionType,
        toolName: null,
        description: `${workflow.name} — ${currentNode.config.description || currentNode.label}`,
        amount: evalAmount,
        currency: 'EUR',
        resourceId: workflow.id,
        idempotencyKey: null,
        decision: evalRes.decision,
        reason: evalRes.reason,
        policyId: evalRes.matchedPolicy?.id ?? null,
        policyName: evalRes.matchedPolicy?.name ?? 'Política de Fluxo',
        riskLevel: evalRes.riskLevel,
        isSimulation: false,
        createApproval: evalRes.decision === 'REQUIRES_APPROVAL',
        workflowExecutionId: evalRes.decision === 'REQUIRES_APPROVAL' ? executionIdDraft : null,
      });

      await tenantDb.agents.recordAgentExecution(agent.id);

      if (evalRes.decision === 'BLOCKED') {
        finalStatus = 'blocked';
        stepsLog.push({
          node_id: currentNode.id,
          label: currentNode.label,
          node_type: 'agent_task',
          status: 'blocked',
          decision: 'BLOCKED',
          detail: evalRes.reason,
          timestamp: now(),
        });
        break;
      } else if (evalRes.decision === 'REQUIRES_APPROVAL') {
        finalStatus = 'awaiting_approval';
        pausedNodeId = currentNode.id;
        createdApprovalId = recorded.approvalRequestId;
        stepsLog.push({
          node_id: currentNode.id,
          label: currentNode.label,
          node_type: 'agent_task',
          status: 'awaiting_approval',
          decision: 'REQUIRES_APPROVAL',
          detail: evalRes.reason,
          timestamp: now(),
        });
        break;
      } else {
        stepsLog.push({
          node_id: currentNode.id,
          label: currentNode.label,
          node_type: 'agent_task',
          status: 'completed',
          decision: 'ALLOWED' as AuthorizationDecision,
          detail: evalRes.reason,
          timestamp: now(),
        });
      }
    } else if (currentNode.node_type === 'end') {
      stepsLog.push({
        node_id: currentNode.id,
        label: currentNode.label,
        node_type: 'end',
        status: 'completed',
        detail: 'Fluxo concluído com sucesso.',
        timestamp: now(),
      });
      break;
    }

    const nextEdge = pickNextEdge(workflow.edges, currentNode.id, forceNextOutcome);
    if (!nextEdge) {
      // Fallback caso o fluxo tenha sido criado sem arestas explícitas (compatibilidade linear)
      const idx = workflow.nodes.findIndex((n) => n.id === currentNode!.id);
      if (workflow.edges.length === 0 && idx >= 0 && idx < workflow.nodes.length - 1) {
        currentNode = workflow.nodes[idx + 1];
      } else {
        currentNode = null;
      }
    } else {
      currentNode = nodeMap.get(nextEdge.target_node_id) || null;
    }
  }

  const savedId = await tenantDb.workflows.saveExecution({
    id: executionIdDraft,
    workflowId: workflow.id,
    status: finalStatus,
    inputSummary,
    pausedNodeId,
    approvalRequestId: createdApprovalId,
    stepsLog,
    triggeredBy: actorUserId,
  });

  await tenantDb.audit.appendAuditEvent({
    actorType: 'user',
    actorId: actorUserId,
    actorName: actorName,
    eventType: params.resumeFromNodeId ? 'workflow_resumed' : 'workflow_execution',
    action: `${params.resumeFromNodeId ? 'Retoma' : 'Execução'} do fluxo "${workflow.name}"`,
    result: finalStatus,
    reason: inputSummary,
  });

  return {
    executionId: savedId,
    status: finalStatus,
    pausedNodeId,
    approvalRequestId: createdApprovalId,
    stepsLog,
  };
}
