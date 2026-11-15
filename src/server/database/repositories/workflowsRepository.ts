import crypto from 'node:crypto';
import type {
  Workflow,
  WorkflowEdge,
  WorkflowExecution,
  WorkflowNode,
  WorkflowNodeType,
} from '../../../shared/types.ts';
import { parseBoolCell, parseJsonCell, WORKSHEET_NAMES } from '../sheetSchema.ts';
import { executeSerializedMultiSheetWrite, TenantSheetRepository } from './baseRepository.ts';

export class WorkflowsRepository {
  private readonly companyId: string;
  private readonly workflowsRepo: TenantSheetRepository;
  private readonly nodesRepo: TenantSheetRepository;
  private readonly edgesRepo: TenantSheetRepository;
  private readonly executionsRepo: TenantSheetRepository;

  constructor(companyId: string) {
    this.companyId = companyId;
    this.workflowsRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.Workflows);
    this.nodesRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.WorkflowNodes);
    this.edgesRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.WorkflowEdges);
    this.executionsRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.WorkflowExecutions);
  }

  async listWorkflows(): Promise<Workflow[]> {
    const [wfs, nodes, edges] = await Promise.all([
      this.workflowsRepo.findAll(),
      this.nodesRepo.findAll(),
      this.edgesRepo.findAll(),
    ]);

    const nodesByWf = new Map<string, WorkflowNode[]>();
    for (const n of nodes) {
      const list = nodesByWf.get(n.workflow_id) || [];
      list.push({
        id: n.id,
        workflow_id: n.workflow_id,
        node_type: n.node_type as WorkflowNodeType,
        label: n.label,
        agent_id: n.agent_id || null,
        config: parseJsonCell<WorkflowNode['config']>(n.config_json, {}),
        position_x: Number(n.position_x || 0),
        position_y: Number(n.position_y || 0),
      });
      nodesByWf.set(n.workflow_id, list);
    }

    const edgesByWf = new Map<string, WorkflowEdge[]>();
    for (const e of edges) {
      const list = edgesByWf.get(e.workflow_id) || [];
      list.push({
        id: e.id,
        workflow_id: e.workflow_id,
        source_node_id: e.source_node_id,
        target_node_id: e.target_node_id,
        condition_label: e.condition_label || null,
      });
      edgesByWf.set(e.workflow_id, list);
    }

    return wfs
      .map((w) => ({
        id: w.id,
        company_id: w.company_id || this.companyId,
        name: w.name,
        description: w.description,
        status: (w.status as Workflow['status']) || 'draft',
        is_demo: parseBoolCell(w.is_demo),
        created_at: w.created_at,
        updated_at: w.updated_at,
        nodes: (nodesByWf.get(w.id) || []).sort((a, b) => a.position_x - b.position_x),
        edges: edgesByWf.get(w.id) || [],
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    const all = await this.listWorkflows();
    return all.find((w) => w.id === id) || null;
  }

  async createWorkflow(input: {
    name: string;
    description: string;
    status: Workflow['status'];
    nodes: Array<{
      id?: string;
      node_type: WorkflowNodeType;
      label: string;
      agent_id?: string | null;
      config?: WorkflowNode['config'];
      position_x?: number;
      position_y?: number;
    }>;
    edges: Array<{
      source_node_id: string;
      target_node_id: string;
      condition_label?: string | null;
    }>;
  }): Promise<string> {
    const wfId = crypto.randomUUID();
    const now = new Date().toISOString();
    const idMap = new Map<string, string>();

    const nodeInserts = input.nodes.map((n, i) => {
      const realId = crypto.randomUUID();
      idMap.set(String(n.id || i), realId);
      return {
        id: realId,
        company_id: this.companyId,
        workflow_id: wfId,
        node_type: n.node_type || 'agent_task',
        label: n.label || `Passo ${i + 1}`,
        agent_id: n.agent_id || '',
        config_json: JSON.stringify(n.config || {}),
        position_x: Number(n.position_x ?? i * 220 + 40),
        position_y: Number(n.position_y ?? 140),
        created_at: now,
      };
    });

    const edgeInserts = input.edges
      .map((e) => {
        const src = idMap.get(String(e.source_node_id));
        const dst = idMap.get(String(e.target_node_id));
        if (!src || !dst) return null;
        return {
          id: crypto.randomUUID(),
          company_id: this.companyId,
          workflow_id: wfId,
          source_node_id: src,
          target_node_id: dst,
          condition_label: e.condition_label ?? '',
          created_at: now,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    await executeSerializedMultiSheetWrite(this.companyId, [
      {
        worksheet: WORKSHEET_NAMES.Workflows,
        inserts: [
          {
            id: wfId,
            company_id: this.companyId,
            name: input.name,
            description: input.description,
            status: input.status,
            is_demo: false,
            created_at: now,
            updated_at: now,
          },
        ],
      },
      { worksheet: WORKSHEET_NAMES.WorkflowNodes, inserts: nodeInserts },
      { worksheet: WORKSHEET_NAMES.WorkflowEdges, inserts: edgeInserts },
    ]);

    return wfId;
  }

  async updateWorkflowStatus(id: string, status: Workflow['status']): Promise<boolean> {
    const existing = await this.workflowsRepo.findById(id);
    if (!existing) return false;
    await this.workflowsRepo.update(id, { status, updated_at: new Date().toISOString() });
    return true;
  }

  async listExecutions(limit = 25): Promise<WorkflowExecution[]> {
    const [execs, wfs] = await Promise.all([
      this.executionsRepo.findAll(),
      this.workflowsRepo.findAll(),
    ]);
    const wfNameMap = new Map(wfs.map((w) => [w.id, w.name]));

    return execs
      .map((ex) => ({
        id: ex.id,
        workflow_id: ex.workflow_id,
        workflow_name: wfNameMap.get(ex.workflow_id) || 'Fluxo',
        status: ex.status as WorkflowExecution['status'],
        input_summary: ex.input_summary,
        paused_node_id: ex.paused_node_id || null,
        approval_request_id: ex.approval_request_id || null,
        steps_log: parseJsonCell<WorkflowExecution['steps_log']>(ex.steps_log_json, []),
        created_at: ex.created_at,
        updated_at: ex.updated_at || ex.created_at,
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  async getExecutionById(id: string): Promise<WorkflowExecution | null> {
    const all = await this.listExecutions(200);
    return all.find((e) => e.id === id) || null;
  }

  async saveExecution(exec: {
    id?: string;
    workflowId: string;
    status: WorkflowExecution['status'];
    inputSummary: string;
    pausedNodeId?: string | null;
    approvalRequestId?: string | null;
    stepsLog: WorkflowExecution['steps_log'];
    triggeredBy: string;
  }): Promise<string> {
    const id = exec.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const existing = exec.id ? await this.executionsRepo.findById(exec.id) : null;
    if (existing) {
      await this.executionsRepo.update(id, {
        status: exec.status,
        paused_node_id: exec.pausedNodeId ?? '',
        approval_request_id: exec.approvalRequestId ?? '',
        steps_log_json: JSON.stringify(exec.stepsLog),
        updated_at: now,
      });
      return id;
    }

    await this.executionsRepo.insert({
      id,
      company_id: this.companyId,
      workflow_id: exec.workflowId,
      status: exec.status,
      input_summary: exec.inputSummary,
      paused_node_id: exec.pausedNodeId ?? '',
      approval_request_id: exec.approvalRequestId ?? '',
      steps_log_json: JSON.stringify(exec.stepsLog),
      triggered_by: exec.triggeredBy,
      created_at: now,
      updated_at: now,
    });
    return id;
  }
}
