import React, { useEffect, useState } from 'react';
import { Plus, ShieldAlert, Lock } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { formatEUR } from '../utils/formatters';
import type { Agent, Policy, PolicyRuleType } from '../shared/types';

export const PoliciesView: React.FC = () => {
  const [policies, setPolicies] = useState<Array<Policy & { assigned_agent_ids?: string[] }>>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Formulário nova política
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [actionType, setActionType] = useState('purchase_order');
  const [ruleType, setRuleType] = useState<PolicyRuleType>('financial_threshold');
  const [maxAuto, setMaxAuto] = useState('300');
  const [maxApproval, setMaxApproval] = useState('1000');
  const [isAbsolute, setIsAbsolute] = useState(false);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);

  async function loadAll() {
    setLoading(true);
    try {
      const [polRes, agRes] = await Promise.all([
        apiFetch<{ policies: Array<Policy & { assigned_agent_ids?: string[] }> }>('/api/policies'),
        apiFetch<{ agents: Agent[] }>('/api/agents'),
      ]);
      setPolicies(polRes.policies);
      setAgents(agRes.agents.filter((a) => a.status !== 'archived'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar políticas.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function handleCreatePolicy(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/policies', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description,
          action_type: actionType,
          rule_type: ruleType,
          max_auto_amount: ruleType === 'financial_threshold' ? Number(maxAuto) : null,
          max_approval_amount: ruleType === 'financial_threshold' ? Number(maxApproval) : null,
          is_absolute_restriction: isAbsolute || ruleType === 'block_always',
          agent_ids: selectedAgents,
        }),
      });
      setShowForm(false);
      setName('');
      setDescription('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao criar política.');
    }
  }

  async function toggleStatus(pol: Policy) {
    setError(null);
    try {
      await apiFetch(`/api/policies/${pol.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: pol.status === 'active' ? 'inactive' : 'active',
        }),
      });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível alterar a política.');
    }
  }

  const ruleLabel: Record<PolicyRuleType, string> = {
    financial_threshold: 'Limites Financeiros',
    block_always: 'Bloqueio Absoluto',
    require_approval: 'Aprovação Obrigatória',
    allow_if_verified: 'Permitir se Verificado',
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Políticas e Permissões
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Regras avaliadas no servidor antes de qualquer ação sensível. Regra base: negar por omissão (Default-to-Deny).
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap self-start"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Nova Política</span>
        </button>
      </div>

      {error && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
          {error}
        </div>
      )}

      {showForm && (
        <form onSubmit={handleCreatePolicy} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 text-xs">
          <h2 className="font-display text-base font-semibold text-slate-900">Criar Política de Autorização</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block font-medium text-slate-700 mb-1">Nome da política *</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Limite de Despesas de Viagem"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Tipo de ação (action_type) *</label>
              <input
                type="text"
                required
                value={actionType}
                onChange={(e) => setActionType(e.target.value)}
                placeholder="purchase_order, refund, send_message..."
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Tipo de regra</label>
              <select
                value={ruleType}
                onChange={(e) => setRuleType(e.target.value as PolicyRuleType)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              >
                <option value="financial_threshold">Limites Financeiros (EUR)</option>
                <option value="require_approval">Exigir Sempre Aprovação</option>
                <option value="block_always">Bloqueio Absoluto</option>
                <option value="allow_if_verified">Permitir se Verificado</option>
              </select>
            </div>
            {ruleType === 'financial_threshold' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Auto até (EUR)</label>
                  <input
                    type="number"
                    value={maxAuto}
                    onChange={(e) => setMaxAuto(e.target.value)}
                    className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Aprovação até (EUR)</label>
                  <input
                    type="number"
                    value={maxApproval}
                    onChange={(e) => setMaxApproval(e.target.value)}
                    className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
            )}
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">Descrição</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">Aplicar aos agentes</label>
            <div className="flex flex-wrap gap-3">
              {agents.map((ag) => (
                <label key={ag.id} className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={selectedAgents.includes(ag.id)}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedAgents((p) => [...p, ag.id]);
                      else setSelectedAgents((p) => p.filter((id) => id !== ag.id));
                    }}
                  />
                  <span>{ag.name}</span>
                </label>
              ))}
            </div>
          </div>
          <label className="inline-flex items-center gap-2 text-red-800">
            <input type="checkbox" checked={isAbsolute} onChange={(e) => setIsAbsolute(e.target.checked)} />
            <span>Restrição absoluta (não pode ser ultrapassada nem por aprovação humana)</span>
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="px-3.5 py-2 border border-slate-300 rounded-lg">
              Cancelar
            </button>
            <button type="submit" className="px-4 py-2 bg-slate-900 text-white rounded-lg font-medium">
              Guardar Política
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl h-64 animate-pulse" />
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 bg-slate-50/70">
                <th className="py-3 px-4">Política</th>
                <th className="py-3 px-3">Ação</th>
                <th className="py-3 px-3">Regra</th>
                <th className="py-3 px-3">Limites (EUR)</th>
                <th className="py-3 px-3">Agentes</th>
                <th className="py-3 px-3">Estado</th>
                <th className="py-3 px-4 text-right">Controlo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {policies.map((pol) => (
                <tr key={pol.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4 max-w-xs">
                    <div className="flex items-center gap-1.5">
                      {pol.is_absolute_restriction ? (
                        <Lock className="w-3.5 h-3.5 text-red-700 shrink-0" />
                      ) : (
                        <ShieldAlert className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      )}
                      <span className="font-semibold text-slate-900">{pol.name}</span>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">{pol.description}</p>
                  </td>
                  <td className="py-3 px-3 font-mono text-slate-700">{pol.action_type}</td>
                  <td className="py-3 px-3 text-slate-700">{ruleLabel[pol.rule_type]}</td>
                  <td className="py-3 px-3 font-mono tabular-nums text-slate-700">
                    {pol.rule_type === 'financial_threshold'
                      ? `Auto ≤ ${formatEUR(pol.max_auto_amount)} · Aprov ≤ ${formatEUR(pol.max_approval_amount)}`
                      : pol.is_absolute_restriction
                      ? 'Sempre bloqueado'
                      : 'Aprovação humana'}
                  </td>
                  <td className="py-3 px-3 font-mono tabular-nums text-slate-700">
                    {pol.assigned_agent_ids?.length ?? 0}
                  </td>
                  <td className="py-3 px-3">
                    <span
                      className={
                        pol.status === 'active'
                          ? 'text-emerald-700 font-medium'
                          : pol.status === 'review_required'
                          ? 'text-amber-700 font-medium'
                          : 'text-slate-500'
                      }
                    >
                      {pol.status === 'active'
                        ? 'Ativa'
                        : pol.status === 'review_required'
                        ? 'Requer revisão'
                        : 'Inativa'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <button
                      type="button"
                      onClick={() => toggleStatus(pol)}
                      className="text-xs font-medium text-slate-700 hover:text-slate-900 underline"
                    >
                      {pol.status === 'active' ? 'Desativar' : 'Ativar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
