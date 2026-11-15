import React, { useEffect, useState } from 'react';
import { Play, Plus, Pause, GitBranch, CheckCircle2, Clock, Ban, Trash2 } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { formatDateTimePT } from '../utils/formatters';
import type { Agent, Workflow, WorkflowExecution, WorkflowNode, WorkflowNodeType } from '../shared/types';

const NODE_TYPE_LABELS: Record<WorkflowNodeType, string> = {
  start: 'Início',
  agent_task: 'Tarefa de Agente',
  condition: 'Condição / Política',
  human_approval: 'Aprovação Humana',
  notification: 'Notificação',
  end: 'Fim',
};

const EXEC_STATUS_LABELS: Record<string, string> = {
  completed: 'Concluído',
  awaiting_approval: 'Aguardar Aprovação',
  blocked: 'Bloqueado',
  failed: 'Falhou',
};

export const WorkflowsView: React.FC = () => {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Modo criação de novo fluxo
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftNodes, setDraftNodes] = useState<WorkflowNode[]>([]);

  // Execução de teste
  const [execAmount, setExecAmount] = useState('500');
  const [execSummary, setExecSummary] = useState('Pedido de compra operacional via fluxo');
  const [lastExecResult, setLastExecResult] = useState<{
    status: string;
    steps_log: WorkflowExecution['steps_log'];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadAll() {
    setLoading(true);
    try {
      const [wfRes, agRes] = await Promise.all([
        apiFetch<{ workflows: Workflow[]; executions: WorkflowExecution[] }>('/api/workflows'),
        apiFetch<{ agents: Agent[] }>('/api/agents'),
      ]);
      setWorkflows(wfRes.workflows);
      setExecutions(wfRes.executions);
      setAgents(agRes.agents.filter((a) => a.status !== 'archived'));
      if (wfRes.workflows.length > 0 && !selectedWorkflowId) {
        setSelectedWorkflowId(wfRes.workflows[0].id);
        setSelectedNodeId(wfRes.workflows[0].nodes[0]?.id ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar fluxos.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  function startNewWorkflow() {
    setCreating(true);
    setDraftName('Novo Fluxo de Aprovação');
    setDraftDesc('Sequência governada de tarefas de agente e validação humana.');
    const n1: WorkflowNode = {
      id: 'tmp-1',
      workflow_id: 'new',
      node_type: 'start',
      label: 'Início do Processo',
      agent_id: null,
      config: {},
      position_x: 40,
      position_y: 120,
    };
    const n2: WorkflowNode = {
      id: 'tmp-2',
      workflow_id: 'new',
      node_type: 'agent_task',
      label: 'Executar Tarefa do Agente',
      agent_id: agents[0]?.id || null,
      config: { action_type: 'purchase_order', amount: 500, description: 'Solicitação automática de compra' },
      position_x: 260,
      position_y: 120,
    };
    const n3: WorkflowNode = {
      id: 'tmp-3',
      workflow_id: 'new',
      node_type: 'human_approval',
      label: 'Aprovação Humana',
      agent_id: null,
      config: {},
      position_x: 480,
      position_y: 120,
    };
    const n4: WorkflowNode = {
      id: 'tmp-4',
      workflow_id: 'new',
      node_type: 'end',
      label: 'Conclusão',
      agent_id: null,
      config: {},
      position_x: 700,
      position_y: 120,
    };
    setDraftNodes([n1, n2, n3, n4]);
    setSelectedNodeId('tmp-2');
  }

  function addDraftNode(nodeType: WorkflowNodeType) {
    const idx = draftNodes.length;
    const newNode: WorkflowNode = {
      id: `tmp-${Date.now()}`,
      workflow_id: 'new',
      node_type: nodeType,
      label: NODE_TYPE_LABELS[nodeType],
      agent_id: nodeType === 'agent_task' ? agents[0]?.id || null : null,
      config: nodeType === 'agent_task' ? { action_type: 'read_info', description: 'Tarefa configurada' } : {},
      position_x: idx * 220 + 40,
      position_y: 120,
    };
    setDraftNodes((prev) => [...prev, newNode]);
    setSelectedNodeId(newNode.id);
  }

  async function saveDraftWorkflow(targetStatus: 'draft' | 'active') {
    setError(null);
    try {
      const edges = draftNodes.slice(0, -1).map((n, idx) => ({
        source_node_id: n.id,
        target_node_id: draftNodes[idx + 1].id,
      }));
      const res = await apiFetch<{ id: string }>('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: draftName,
          description: draftDesc,
          status: targetStatus,
          nodes: draftNodes,
          edges,
        }),
      });
      setCreating(false);
      setSelectedWorkflowId(res.id);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao guardar fluxo.');
    }
  }

  async function toggleWorkflowStatus(wf: Workflow, nextStatus: 'active' | 'suspended') {
    setError(null);
    try {
      await apiFetch(`/api/workflows/${wf.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao alterar estado.');
    }
  }

  async function executeWorkflow(wfId: string) {
    setError(null);
    try {
      const res = await apiFetch<{ status: string; steps_log: WorkflowExecution['steps_log'] }>(
        `/api/workflows/${wfId}/execute`,
        {
          method: 'POST',
          body: JSON.stringify({
            amount: execAmount ? Number(execAmount) : undefined,
            input_summary: execSummary,
          }),
        }
      );
      setLastExecResult(res);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao executar fluxo.');
    }
  }

  const activeWorkflow = workflows.find((w) => w.id === selectedWorkflowId) || null;
  const displayedNodes = creating ? draftNodes : activeWorkflow?.nodes || [];
  const selectedNode = displayedNodes.find((n) => n.id === selectedNodeId) || null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Fluxos de Trabalho
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Orquestre múltiplos agentes em processos sequenciais sujeitos às políticas de autorização MANDATO.
          </p>
        </div>
        <button
          type="button"
          onClick={startNewWorkflow}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap self-start"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Novo Fluxo</span>
        </button>
      </div>

      {error && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl h-72 animate-pulse" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Lista de fluxos */}
          <div className="lg:col-span-3 bg-white border border-slate-200 rounded-xl p-4 space-y-2">
            <p className="text-xs font-semibold text-slate-900 pb-2 border-b border-slate-100">
              Fluxos Configurados
            </p>
            {workflows.map((wf) => (
              <button
                key={wf.id}
                type="button"
                onClick={() => {
                  setCreating(false);
                  setSelectedWorkflowId(wf.id);
                  setSelectedNodeId(wf.nodes[0]?.id ?? null);
                }}
                className={`w-full text-left p-3 rounded-lg border text-xs transition-colors ${
                  !creating && selectedWorkflowId === wf.id
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 hover:bg-slate-50 text-slate-800'
                }`}
              >
                <p className="font-semibold">{wf.name}</p>
                <p className={`text-[11px] mt-0.5 ${!creating && selectedWorkflowId === wf.id ? 'text-slate-300' : 'text-slate-500'}`}>
                  {wf.status === 'active' ? 'Ativo' : wf.status === 'suspended' ? 'Suspenso' : 'Rascunho'} · {wf.nodes.length} nós
                </p>
              </button>
            ))}
          </div>

          {/* Editor / Canvas Visual */}
          <div className="lg:col-span-9 space-y-6">
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              {creating ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input
                      type="text"
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder="Nome do fluxo"
                      className="px-3 py-2 text-sm font-semibold border border-slate-300 rounded-lg"
                    />
                    <input
                      type="text"
                      value={draftDesc}
                      onChange={(e) => setDraftDesc(e.target.value)}
                      placeholder="Descrição do processo"
                      className="px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <span className="text-[11px] text-slate-500">Adicionar nó:</span>
                    {(['agent_task', 'condition', 'human_approval', 'notification', 'end'] as WorkflowNodeType[]).map((nt) => (
                      <button
                        key={nt}
                        type="button"
                        onClick={() => addDraftNode(nt)}
                        className="px-2.5 py-1 text-xs bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-md"
                      >
                        + {NODE_TYPE_LABELS[nt]}
                      </button>
                    ))}
                  </div>
                </div>
              ) : activeWorkflow ? (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h2 className="font-display text-base font-semibold text-slate-900">{activeWorkflow.name}</h2>
                    <p className="text-xs text-slate-500 mt-0.5">{activeWorkflow.description}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {activeWorkflow.status === 'active' ? (
                      <button
                        type="button"
                        onClick={() => toggleWorkflowStatus(activeWorkflow, 'suspended')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-lg"
                      >
                        <Pause className="w-3.5 h-3.5" />
                        <span>Suspender</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleWorkflowStatus(activeWorkflow, 'active')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg"
                      >
                        <Play className="w-3.5 h-3.5" />
                        <span>Ativar</span>
                      </button>
                    )}
                  </div>
                </div>
              ) : null}

              {/* Canvas responsivo com ligações */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 flex flex-wrap items-center gap-3">
                {displayedNodes.map((node, idx) => {
                  const isSel = node.id === selectedNodeId;
                  const borderTone =
                    node.node_type === 'human_approval'
                      ? 'border-amber-300 bg-amber-50/40'
                      : node.node_type === 'condition'
                      ? 'border-slate-400 bg-white'
                      : 'border-slate-200 bg-white';
                  return (
                    <React.Fragment key={node.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedNodeId(node.id)}
                        className={`w-[175px] text-left p-3 rounded-lg border transition-colors ${
                          isSel ? 'ring-2 ring-slate-900 border-slate-900 bg-white' : borderTone
                        }`}
                      >
                        <p className="text-[11px] font-medium text-slate-500">
                          {NODE_TYPE_LABELS[node.node_type]}
                        </p>
                        <p className="text-xs font-semibold text-slate-900 mt-1 line-clamp-2">{node.label}</p>
                      </button>
                      {idx < displayedNodes.length - 1 && (
                        <div className="hidden sm:flex items-center shrink-0 text-slate-400" aria-hidden="true">
                          <div className="w-4 h-px bg-slate-300" />
                          <span className="text-xs">→</span>
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>

              {/* Inspetor de propriedades do nó */}
              {selectedNode && (
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-900">
                      Propriedades do Nó: {NODE_TYPE_LABELS[selectedNode.node_type]}
                    </span>
                    {creating && draftNodes.length > 2 && (
                      <button
                        type="button"
                        onClick={() => {
                          setDraftNodes((prev) => prev.filter((n) => n.id !== selectedNode.id));
                          setSelectedNodeId(null);
                        }}
                        className="inline-flex items-center gap-1 text-red-700 hover:underline"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Remover</span>
                      </button>
                    )}
                  </div>

                  {creating ? (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-slate-600 mb-1">Etiqueta</label>
                        <input
                          type="text"
                          value={selectedNode.label}
                          onChange={(e) =>
                            setDraftNodes((prev) =>
                              prev.map((n) => (n.id === selectedNode.id ? { ...n, label: e.target.value } : n))
                            )
                          }
                          className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-md"
                        />
                      </div>
                      {selectedNode.node_type === 'agent_task' && (
                        <>
                          <div>
                            <label className="block text-slate-600 mb-1">Agente</label>
                            <select
                              value={selectedNode.agent_id || ''}
                              onChange={(e) =>
                                setDraftNodes((prev) =>
                                  prev.map((n) => (n.id === selectedNode.id ? { ...n, agent_id: e.target.value } : n))
                                )
                              }
                              className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-md"
                            >
                              {agents.map((ag) => (
                                <option key={ag.id} value={ag.id}>
                                  {ag.name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-slate-600 mb-1">Tipo de ação</label>
                            <select
                              value={selectedNode.config.action_type || 'purchase_order'}
                              onChange={(e) =>
                                setDraftNodes((prev) =>
                                  prev.map((n) =>
                                    n.id === selectedNode.id
                                      ? { ...n, config: { ...n.config, action_type: e.target.value } }
                                      : n
                                  )
                                )
                              }
                              className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-md"
                            >
                              <option value="read_supplier">Consultar fornecedores (read_supplier)</option>
                              <option value="purchase_order">Ordem de compra (purchase_order)</option>
                              <option value="refund">Reembolso (refund)</option>
                              <option value="send_message">Enviar mensagem (send_message)</option>
                            </select>
                          </div>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="text-slate-600">
                      <p>Etiqueta: <strong className="text-slate-900">{selectedNode.label}</strong></p>
                      {selectedNode.agent_id && (
                        <p className="mt-1">
                          Agente associado: <strong className="text-slate-900">{agents.find((a) => a.id === selectedNode.agent_id)?.name || selectedNode.agent_id}</strong>
                        </p>
                      )}
                      {selectedNode.config.action_type && (
                        <p className="mt-1 font-mono">Ação avaliada: {selectedNode.config.action_type}</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {creating ? (
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setCreating(false)}
                    className="px-3.5 py-2 text-xs border border-slate-300 rounded-lg text-slate-700"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => saveDraftWorkflow('draft')}
                    className="px-3.5 py-2 text-xs border border-slate-300 rounded-lg text-slate-800 bg-white"
                  >
                    Guardar Rascunho
                  </button>
                  <button
                    type="button"
                    onClick={() => saveDraftWorkflow('active')}
                    className="px-4 py-2 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800"
                  >
                    Guardar e Ativar Fluxo
                  </button>
                </div>
              ) : activeWorkflow ? (
                <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-end gap-3">
                  <div className="flex-1">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Descrição do pedido de execução
                    </label>
                    <input
                      type="text"
                      value={execSummary}
                      onChange={(e) => setExecSummary(e.target.value)}
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div className="w-36">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Montante (EUR)
                    </label>
                    <input
                      type="number"
                      value={execAmount}
                      onChange={(e) => setExecAmount(e.target.value)}
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={activeWorkflow.status !== 'active'}
                    onClick={() => executeWorkflow(activeWorkflow.id)}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                  >
                    <GitBranch className="w-3.5 h-3.5" />
                    <span>Executar Fluxo</span>
                  </button>
                </div>
              ) : null}

              {lastExecResult && (
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
                  <p className="font-semibold text-slate-900">
                    Resultado da Execução: <span className="font-mono">{lastExecResult.status}</span>
                  </p>
                  <div className="space-y-1.5">
                    {lastExecResult.steps_log.map((s, idx) => (
                      <div key={idx} className="flex items-start gap-2">
                        {s.decision === 'BLOCKED' ? (
                          <Ban className="w-3.5 h-3.5 text-red-600 mt-0.5 shrink-0" />
                        ) : s.status === 'awaiting_approval' ? (
                          <Clock className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
                        ) : (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 mt-0.5 shrink-0" />
                        )}
                        <div>
                          <span className="font-medium text-slate-900">{s.label}:</span>{' '}
                          <span className="text-slate-600">{s.detail}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Histórico de Execuções */}
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <h3 className="font-display text-sm font-semibold text-slate-900 pb-3 border-b border-slate-100">
                Histórico de Execuções de Fluxos
              </h3>
              <div className="mt-3 divide-y divide-slate-100 text-xs">
                {executions.map((ex) => (
                  <div key={ex.id} className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-slate-900">{ex.workflow_name} · {ex.input_summary}</p>
                      <p className="text-[11px] text-slate-500">{ex.steps_log.length} passos registados</p>
                    </div>
                    <div className="text-right font-mono text-[11px]">
                      <span
                        className={
                          ex.status === 'blocked'
                            ? 'text-red-700 font-semibold'
                            : ex.status === 'awaiting_approval'
                            ? 'text-amber-700 font-semibold'
                            : 'text-emerald-700 font-semibold'
                        }
                      >
                        {EXEC_STATUS_LABELS[ex.status] || ex.status}
                      </span>
                      <p className="text-slate-400">{formatDateTimePT(ex.created_at)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
