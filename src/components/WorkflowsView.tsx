import React, { useEffect, useState } from 'react';
import { Play, Plus, Pause, GitBranch, CheckCircle2, Clock, Ban, Trash2 } from 'lucide-react';
import { apiFetch, isDatabaseNotConnectedError } from '../utils/api';
import { formatDateTimePT } from '../utils/formatters';
import { DatabaseNotConnectedBanner } from './DatabaseNotConnectedBanner';
import type { Agent, Workflow, WorkflowExecution, WorkflowNode, WorkflowNodeType } from '../shared/types';

interface WorkflowsViewProps {
  onNavigateSettings?: () => void;
}

interface DraftEdge {
  id: string;
  source_node_id: string;
  target_node_id: string;
  condition_label: string;
}

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

export const WorkflowsView: React.FC<WorkflowsViewProps> = ({ onNavigateSettings }) => {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Modo criação de novo fluxo com arestas e ramos
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftNodes, setDraftNodes] = useState<WorkflowNode[]>([]);
  const [draftEdges, setDraftEdges] = useState<DraftEdge[]>([]);
  const [edgeSource, setEdgeSource] = useState('');
  const [edgeTarget, setEdgeTarget] = useState('');
  const [edgeLabel, setEdgeLabel] = useState('');

  // Execução de teste
  const [execAmount, setExecAmount] = useState('500');
  const [execSummary, setExecSummary] = useState('Pedido de compra operacional via fluxo');
  const [lastExecResult, setLastExecResult] = useState<{
    status: string;
    approval_request_id?: string | null;
    steps_log: WorkflowExecution['steps_log'];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dbDisconnected, setDbDisconnected] = useState(false);
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
      setDbDisconnected(false);
      setError(null);
      if (wfRes.workflows.length > 0 && !selectedWorkflowId) {
        setSelectedWorkflowId(wfRes.workflows[0].id);
        setSelectedNodeId(wfRes.workflows[0].nodes[0]?.id ?? null);
      }
    } catch (err) {
      setDbDisconnected(isDatabaseNotConnectedError(err));
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
    setDraftName('Novo Fluxo com Condição e Aprovação');
    setDraftDesc('Sequência governada com verificação de limiar e aprovação humana.');
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
    setDraftEdges([
      { id: 'e-1', source_node_id: 'tmp-1', target_node_id: 'tmp-2', condition_label: '' },
      { id: 'e-2', source_node_id: 'tmp-2', target_node_id: 'tmp-3', condition_label: '' },
      { id: 'e-3', source_node_id: 'tmp-3', target_node_id: 'tmp-4', condition_label: 'Aprovado' },
    ]);
    setEdgeSource('tmp-1');
    setEdgeTarget('tmp-2');
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
      config:
        nodeType === 'agent_task'
          ? { action_type: 'read_info', description: 'Tarefa configurada' }
          : nodeType === 'condition'
          ? { condition_expression: 'amount > 300' }
          : nodeType === 'notification'
          ? { recipient: 'Equipa Financeira', description: 'Fluxo concluído' }
          : {},
      position_x: idx * 220 + 40,
      position_y: 120,
    };
    const prevLast = draftNodes[draftNodes.length - 1];
    setDraftNodes((prev) => [...prev, newNode]);
    if (prevLast) {
      setDraftEdges((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          source_node_id: prevLast.id,
          target_node_id: newNode.id,
          condition_label: prevLast.node_type === 'human_approval' ? 'Aprovado' : '',
        },
      ]);
    }
    setSelectedNodeId(newNode.id);
  }

  function addDraftEdge() {
    if (!edgeSource || !edgeTarget || edgeSource === edgeTarget) return;
    setDraftEdges((prev) => [
      ...prev,
      {
        id: `e-${Date.now()}`,
        source_node_id: edgeSource,
        target_node_id: edgeTarget,
        condition_label: edgeLabel.trim(),
      },
    ]);
    setEdgeLabel('');
  }

  async function saveDraftWorkflow(targetStatus: 'draft' | 'active') {
    setError(null);
    try {
      const edgesToSave =
        draftEdges.length > 0
          ? draftEdges.map((e) => ({
              source_node_id: e.source_node_id,
              target_node_id: e.target_node_id,
              condition_label: e.condition_label || undefined,
            }))
          : draftNodes.slice(0, -1).map((n, idx) => ({
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
          edges: edgesToSave,
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
      const res = await apiFetch<{
        status: string;
        approval_request_id?: string | null;
        steps_log: WorkflowExecution['steps_log'];
      }>(`/api/workflows/${wfId}/execute`, {
        method: 'POST',
        body: JSON.stringify({
          amount: execAmount ? Number(execAmount) : undefined,
          input_summary: execSummary,
        }),
      });
      setLastExecResult(res);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao executar fluxo.');
    }
  }

  if (dbDisconnected) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Fluxos de Trabalho
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Orquestre múltiplos agentes em processos governados por políticas e aprovação humana.
          </p>
        </div>
        <DatabaseNotConnectedBanner message={error || undefined} onNavigateSettings={onNavigateSettings} />
      </div>
    );
  }

  const activeWorkflow = workflows.find((w) => w.id === selectedWorkflowId) || null;
  const displayedNodes = creating ? draftNodes : activeWorkflow?.nodes || [];
  const displayedEdges = creating ? draftEdges : activeWorkflow?.edges || [];
  const selectedNode = displayedNodes.find((n) => n.id === selectedNodeId) || null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Fluxos de Trabalho
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Orquestre múltiplos agentes em grafos com condições, pausas para aprovação humana e retoma automática após decisão.
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
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold truncate">{wf.name}</p>
                  {wf.status === 'suspended' && (
                    <span className="text-[10px] font-semibold text-amber-600">Suspenso</span>
                  )}
                </div>
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
                      aria-label="Nome do fluxo"
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder="Nome do fluxo"
                      className="px-3 py-2 text-sm font-semibold border border-slate-300 rounded-lg"
                    />
                    <input
                      type="text"
                      aria-label="Descrição do fluxo"
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

              {/* Canvas responsivo com nós e ligações */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex flex-wrap items-center gap-3">
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
                          className={`w-[180px] text-left p-3 rounded-lg border transition-colors ${
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

                {/* Arestas configuradas (ramos condicionais e de aprovação) */}
                {displayedEdges.length > 0 && (
                  <div className="pt-3 border-t border-slate-200/80 text-[11px] text-slate-600 flex flex-wrap gap-2">
                    {displayedEdges.map((edge) => {
                      const src = displayedNodes.find((n) => n.id === edge.source_node_id);
                      const tgt = displayedNodes.find((n) => n.id === edge.target_node_id);
                      return (
                        <span
                          key={edge.id}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-slate-200 rounded-md font-mono"
                        >
                          <span>{src?.label || edge.source_node_id}</span>
                          <span>→</span>
                          {edge.condition_label && (
                            <span className="font-semibold text-emerald-700">[{edge.condition_label}]</span>
                          )}
                          <span>{tgt?.label || edge.target_node_id}</span>
                          {creating && (
                            <button
                              type="button"
                              aria-label="Remover ligação"
                              onClick={() =>
                                setDraftEdges((prev) => prev.filter((item) => item.id !== edge.id))
                              }
                              className="text-red-600 hover:text-red-800 ml-1"
                            >
                              ×
                            </button>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}

                {creating && draftNodes.length >= 2 && (
                  <div className="pt-2 border-t border-slate-200 flex flex-wrap items-end gap-2 text-xs">
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">Origem</label>
                      <select
                        value={edgeSource}
                        onChange={(e) => setEdgeSource(e.target.value)}
                        className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-md"
                      >
                        {draftNodes.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">Destino</label>
                      <select
                        value={edgeTarget}
                        onChange={(e) => setEdgeTarget(e.target.value)}
                        className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-md"
                      >
                        {draftNodes.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">Ramo / Condição</label>
                      <select
                        value={edgeLabel}
                        onChange={(e) => setEdgeLabel(e.target.value)}
                        className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-md"
                      >
                        <option value="">Padrão (sequencial)</option>
                        <option value="true">Verdadeiro (true)</option>
                        <option value="false">Falso (false)</option>
                        <option value="Aprovado">Aprovado</option>
                        <option value="Rejeitado">Rejeitado</option>
                      </select>
                    </div>
                    <button
                      type="button"
                      onClick={addDraftEdge}
                      className="px-3 py-1.5 bg-slate-900 text-white rounded-md font-medium hover:bg-slate-800"
                    >
                      + Ligação
                    </button>
                  </div>
                )}
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
                          setDraftEdges((prev) =>
                            prev.filter(
                              (e) => e.source_node_id !== selectedNode.id && e.target_node_id !== selectedNode.id
                            )
                          );
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
                              <option value="read_info">Consultar informação (read_info)</option>
                              <option value="purchase_order">Ordem de compra (purchase_order)</option>
                              <option value="refund">Reembolso (refund)</option>
                              <option value="send_message">Enviar mensagem (send_message)</option>
                            </select>
                          </div>
                        </>
                      )}
                      {selectedNode.node_type === 'condition' && (
                        <div className="sm:col-span-2">
                          <label className="block text-slate-600 mb-1">
                            Expressão condicional (ex: <span className="font-mono">amount &gt; 300</span>)
                          </label>
                          <input
                            type="text"
                            value={selectedNode.config.condition_expression || ''}
                            onChange={(e) =>
                              setDraftNodes((prev) =>
                                prev.map((n) =>
                                  n.id === selectedNode.id
                                    ? { ...n, config: { ...n.config, condition_expression: e.target.value } }
                                    : n
                                )
                              )
                            }
                            placeholder="amount > 300"
                            className="w-full px-2.5 py-1.5 font-mono bg-white border border-slate-300 rounded-md"
                          />
                        </div>
                      )}
                      {selectedNode.node_type === 'notification' && (
                        <div className="sm:col-span-2">
                          <label className="block text-slate-600 mb-1">Destinatário da notificação</label>
                          <input
                            type="text"
                            value={selectedNode.config.recipient || ''}
                            onChange={(e) =>
                              setDraftNodes((prev) =>
                                prev.map((n) =>
                                  n.id === selectedNode.id
                                    ? { ...n, config: { ...n.config, recipient: e.target.value } }
                                    : n
                                )
                              )
                            }
                            placeholder="Direção Financeira"
                            className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-md"
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-slate-600 space-y-1">
                      <p>Etiqueta: <strong className="text-slate-900">{selectedNode.label}</strong></p>
                      {selectedNode.agent_id && (
                        <p>
                          Agente associado:{' '}
                          <strong className="text-slate-900">
                            {agents.find((a) => a.id === selectedNode.agent_id)?.name || selectedNode.agent_id}
                          </strong>
                        </p>
                      )}
                      {selectedNode.config.action_type && (
                        <p className="font-mono">Ação avaliada: {selectedNode.config.action_type}</p>
                      )}
                      {selectedNode.config.condition_expression && (
                        <p className="font-mono">Expressão: {selectedNode.config.condition_expression}</p>
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
                    Resultado da Execução:{' '}
                    <span className="font-mono">{EXEC_STATUS_LABELS[lastExecResult.status] || lastExecResult.status}</span>
                  </p>
                  {lastExecResult.approval_request_id && (
                    <p className="text-amber-800">
                      Pedido de aprovação criado (<span className="font-mono">{lastExecResult.approval_request_id}</span>). Quando aprovado ou rejeitado em <strong>9. Pedidos de Aprovação</strong>, o fluxo é retomado automaticamente.
                    </p>
                  )}
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
                      <p className="text-[11px] text-slate-500">
                        {ex.steps_log.length} passos registados
                        {ex.paused_node_id ? ` · Em pausa no nó ${ex.paused_node_id}` : ''}
                      </p>
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
