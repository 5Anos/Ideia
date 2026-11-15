import React, { useEffect, useState } from 'react';
import {
  Bot,
  Plus,
  Play,
  Pause,
  Copy,
  Archive,
  Eye,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
  X,
} from 'lucide-react';
import { apiFetch, isDatabaseNotConnectedError } from '../utils/api';
import { AGENT_STATUS_META, DECISION_META, formatDateTimePT, formatEUR } from '../utils/formatters';
import { DatabaseNotConnectedBanner } from './DatabaseNotConnectedBanner';
import type { Agent, AuthorizationRequestRecord, Policy } from '../shared/types';

interface MyAgentsViewProps {
  onTestAgent: (agentId: string) => void;
  onGoToWizard: () => void;
  onNavigateSettings?: () => void;
}

type DetailTab =
  | 'overview'
  | 'instructions'
  | 'tools'
  | 'permissions'
  | 'activity'
  | 'performance'
  | 'configuration';

export const MyAgentsView: React.FC<MyAgentsViewProps> = ({
  onTestAgent,
  onGoToWizard,
  onNavigateSettings,
}) => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dbDisconnected, setDbDisconnected] = useState(false);

  // Perfil detalhado (7 separadores)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<{
    agent: Agent;
    activity: AuthorizationRequestRecord[];
    versions: Array<{ id: string; version_number: number; model: string; provider: string; created_at: string }>;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);

  // Modal Registar Agente Externo
  const [showExternalModal, setShowExternalModal] = useState(false);
  const [extName, setExtName] = useState('');
  const [extProvider, setExtProvider] = useState('OpenAI');
  const [extModel, setExtModel] = useState('gpt-4.1');
  const [extIdentifier, setExtIdentifier] = useState('');
  const [extDesc, setExtDesc] = useState('');
  const [extPolicies, setExtPolicies] = useState<string[]>([]);
  const [extIssuedKey, setExtIssuedKey] = useState<string | null>(null);

  async function loadAgents() {
    setLoading(true);
    try {
      const [agRes, polRes] = await Promise.all([
        apiFetch<{ agents: Agent[] }>('/api/agents'),
        apiFetch<{ policies: Policy[] }>('/api/policies'),
      ]);
      setAgents(agRes.agents);
      setPolicies(polRes.policies);
      if (polRes.policies.length > 0 && extPolicies.length === 0) {
        setExtPolicies([polRes.policies[0].id]);
      }
      setError(null);
      setDbDisconnected(false);
    } catch (err) {
      setDbDisconnected(isDatabaseNotConnectedError(err));
      setError(err instanceof Error ? err.message : 'Erro ao carregar agentes.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAgents();
  }, []);

  async function openAgentDetail(agentId: string) {
    setSelectedAgentId(agentId);
    setActiveTab('overview');
    setRotatedKey(null);
    try {
      const res = await apiFetch<{
        agent: Agent;
        activity: AuthorizationRequestRecord[];
        versions: Array<{ id: string; version_number: number; model: string; provider: string; created_at: string }>;
      }>(`/api/agents/${agentId}`);
      setDetailData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao abrir perfil do agente.');
    }
  }

  async function changeStatus(agentId: string, status: string) {
    setError(null);
    try {
      await apiFetch(`/api/agents/${agentId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      await loadAgents();
      if (selectedAgentId === agentId) await openAgentDetail(agentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao alterar estado.');
    }
  }

  async function duplicateAgent(agentId: string) {
    setError(null);
    try {
      await apiFetch(`/api/agents/${agentId}/duplicate`, { method: 'POST' });
      await loadAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao duplicar agente.');
    }
  }

  async function toggleTool(agentId: string, toolId: string, isEnabled: boolean) {
    try {
      await apiFetch(`/api/agents/${agentId}/tools`, {
        method: 'PATCH',
        body: JSON.stringify({ tool_id: toolId, is_enabled: isEnabled }),
      });
      await openAgentDetail(agentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao atualizar ferramenta.');
    }
  }

  async function rotateCredential(agentId: string) {
    try {
      const res = await apiFetch<{ api_key: string }>(`/api/agents/${agentId}/credentials/rotate`, {
        method: 'POST',
      });
      setRotatedKey(res.api_key);
      await openAgentDetail(agentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao rodar credencial.');
    }
  }

  async function revokeCredential(agentId: string) {
    try {
      await apiFetch(`/api/agents/${agentId}/credentials/revoke`, { method: 'POST' });
      await openAgentDetail(agentId);
      await loadAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao revogar credencial.');
    }
  }

  async function handleRegisterExternal(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiFetch<{ agent: Agent; issued_api_key: string }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: extName,
          description: extDesc,
          category: 'Personalizado',
          objective: extDesc,
          origin: 'EXTERNAL',
          provider: extProvider,
          model: extModel,
          external_identifier: extIdentifier,
          status: extPolicies.length > 0 ? 'active' : 'draft',
          policy_ids: extPolicies,
        }),
      });
      setExtIssuedKey(res.issued_api_key);
      await loadAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao registar agente externo.');
    }
  }

  const filtered = agents.filter((a) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      a.name.toLowerCase().includes(q) ||
      a.category.toLowerCase().includes(q) ||
      a.provider.toLowerCase().includes(q)
    );
  });

  if (dbDisconnected) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Os Meus Agentes
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Ligue a Folha de Cálculo Google da empresa para consultar e gerir agentes.
          </p>
        </div>
        <DatabaseNotConnectedBanner message={error || undefined} onNavigateSettings={onNavigateSettings} />
      </div>
    );
  }

  if (detailData) {
    const ag = detailData.agent;
    const st = AGENT_STATUS_META[ag.status] || { label: ag.status, textClass: 'text-slate-600' };
    const tabs: Array<{ id: DetailTab; label: string }> = [
      { id: 'overview', label: 'Visão Geral' },
      { id: 'instructions', label: 'Instruções' },
      { id: 'tools', label: 'Ferramentas' },
      { id: 'permissions', label: 'Permissões' },
      { id: 'activity', label: 'Atividade' },
      { id: 'performance', label: 'Desempenho' },
      { id: 'configuration', label: 'Configuração' },
    ];

    return (
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <button
              type="button"
              onClick={() => {
                setDetailData(null);
                setSelectedAgentId(null);
              }}
              className="text-xs font-medium text-slate-600 hover:text-slate-900 mb-1"
            >
              ← Voltar para Os Meus Agentes
            </button>
            <h1 className="font-display text-2xl font-semibold text-slate-900">{ag.name}</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              ID: <span className="font-mono">{ag.id}</span> ·{' '}
              {ag.origin === 'EXTERNAL' ? 'Externo' : 'Criado no MANDATO'} · {ag.category} ·{' '}
              <span className={st.textClass}>{st.label}</span>
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onTestAgent(ag.id)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
            >
              <TerminalSquare className="w-3.5 h-3.5" />
              <span>Testar Agente</span>
            </button>
            {ag.status === 'active' || ag.status === 'running' ? (
              <button
                type="button"
                onClick={() => changeStatus(ag.id, 'suspended')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100"
              >
                <Pause className="w-3.5 h-3.5" />
                <span>Suspender</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => changeStatus(ag.id, 'active')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Ativar</span>
              </button>
            )}
          </div>
        </div>

        {/* 7 Separadores */}
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                activeTab === t.id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6">
          {activeTab === 'overview' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-slate-900">Identidade e Propósito</h3>
                <p className="text-slate-600 leading-relaxed">{ag.description}</p>
                <p className="text-slate-600">
                  <span className="font-semibold text-slate-800">Objetivo:</span> {ag.objective}
                </p>
                <p className="text-slate-600">
                  <span className="font-semibold text-slate-800">Provedor / Modelo:</span> {ag.provider} ·{' '}
                  <span className="font-mono">{ag.model}</span>
                </p>
              </div>
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-slate-900">Estado de Segurança</h3>
                <p className="text-slate-700">
                  Políticas atribuídas: <span className="font-mono font-semibold">{ag.policies?.length || 0}</span>
                </p>
                <p className="text-slate-700">
                  Estado de segurança:{' '}
                  <span className={ag.security_status === 'protected' ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold'}>
                    {ag.security_status === 'protected'
                      ? 'Protegido'
                      : ag.security_status === 'needs_policy'
                      ? 'Sem política'
                      : 'Credenciais suspensas'}
                  </span>
                </p>
                <p className="text-slate-700">
                  Última atividade: <span className="font-mono">{formatDateTimePT(ag.last_activity_at)}</span>
                </p>
              </div>
            </div>
          )}

          {activeTab === 'instructions' && (
            <div className="space-y-4 text-xs">
              <div>
                <p className="font-semibold text-slate-900">Papel</p>
                <p className="text-slate-600 mt-0.5">{ag.instructions.role}</p>
              </div>
              <div>
                <p className="font-semibold text-slate-900">Responsabilidades</p>
                <ul className="list-disc pl-5 mt-1 space-y-1 text-slate-600">
                  {(ag.instructions.responsibilities || []).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="font-semibold text-slate-900">Restrições configuradas</p>
                <ul className="list-disc pl-5 mt-1 space-y-1 text-red-700">
                  {(ag.instructions.restrictions || []).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {activeTab === 'tools' && (
            <div className="divide-y divide-slate-100">
              {(ag.tools || []).map((tool) => (
                <div key={tool.id} className="py-3 flex items-center justify-between gap-4 text-xs">
                  <div>
                    <p className="font-medium text-slate-900">
                      {tool.tool_name} <span className="text-slate-500">· {tool.category} · Risco {tool.risk_level}</span>
                    </p>
                    <p className="font-mono text-[11px] text-slate-400">{tool.tool_key}</p>
                  </div>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={tool.is_enabled}
                      onChange={(e) => toggleTool(ag.id, tool.id, e.target.checked)}
                      className="rounded border-slate-300 text-slate-900"
                    />
                    <span className="text-slate-700">{tool.is_enabled ? 'Ativa' : 'Desativada'}</span>
                  </label>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'permissions' && (
            <div className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                  <p className="font-semibold text-slate-900">Limites Financeiros do Agente</p>
                  <p className="mt-1 text-slate-600">
                    Automático até: <span className="font-mono font-semibold">{formatEUR(ag.permissions_summary.max_auto_financial_limit_eur)}</span>
                  </p>
                  <p className="mt-0.5 text-slate-600">
                    Com aprovação até: <span className="font-mono font-semibold">{formatEUR(ag.permissions_summary.max_approval_financial_limit_eur)}</span>
                  </p>
                </div>
                <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                  <p className="font-semibold text-slate-900">Ações Sempre Bloqueadas</p>
                  <p className="mt-1 font-mono text-red-700">
                    {(ag.permissions_summary.always_blocked_actions || []).join(', ') || 'bank_details_update'}
                  </p>
                </div>
              </div>
              <div>
                <p className="font-semibold text-slate-900 mb-2">Políticas Associadas</p>
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                  {(ag.policies || []).map((p) => (
                    <div key={p.id} className="p-3 flex justify-between">
                      <span className="font-medium text-slate-900">{p.name}</span>
                      <span className="font-mono text-slate-500">{p.action_type}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'activity' && (
            <div className="divide-y divide-slate-100 text-xs">
              {detailData.activity.length === 0 ? (
                <p className="py-6 text-center text-slate-500">Ainda sem pedidos de autorização registados.</p>
              ) : (
                detailData.activity.map((act) => {
                  const dm = DECISION_META[act.decision] || { label: act.decision, textClass: 'text-slate-700' };
                  return (
                    <div key={act.id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <p className="font-medium text-slate-900">{act.description}</p>
                        <p className="text-slate-500">
                          {act.action_type}
                          {act.amount !== null ? ` · ${formatEUR(act.amount)}` : ''}
                          {act.is_simulation ? ' · Simulação' : ''}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className={dm.textClass}>{dm.label}</p>
                        <p className="font-mono text-[11px] text-slate-400">{formatDateTimePT(act.created_at)}</p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {activeTab === 'performance' && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
              <div className="p-4 rounded-lg border border-slate-200">
                <p className="text-slate-500">Total de ações</p>
                <p className="text-2xl font-mono font-semibold text-slate-900 mt-1">{ag.actions_count}</p>
              </div>
              <div className="p-4 rounded-lg border border-slate-200">
                <p className="text-slate-500">Autorizadas</p>
                <p className="text-2xl font-mono font-semibold text-emerald-700 mt-1">
                  {detailData.activity.filter((a) => a.decision === 'ALLOWED').length}
                </p>
              </div>
              <div className="p-4 rounded-lg border border-slate-200">
                <p className="text-slate-500">Bloqueadas por política</p>
                <p className="text-2xl font-mono font-semibold text-red-700 mt-1">
                  {detailData.activity.filter((a) => a.decision === 'BLOCKED').length}
                </p>
              </div>
            </div>
          )}

          {activeTab === 'configuration' && (
            <div className="space-y-5 text-xs">
              <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-900">Credenciais API do Agente (Hash SHA-256)</p>
                    <p className="text-slate-500 mt-0.5">
                      Prefixo atual: <span className="font-mono">{ag.credential_prefix || '—'}</span> · Estado:{' '}
                      <span className="font-semibold">{ag.credential_status || '—'}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => rotateCredential(ag.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-100"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Rodar Chave</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => revokeCredential(ag.id)}
                      className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100"
                    >
                      Revogar
                    </button>
                  </div>
                </div>
                {rotatedKey && (
                  <div className="mt-3 p-2.5 bg-white border border-emerald-300 rounded-md font-mono text-xs text-slate-900 select-all">
                    Nova chave (guarde agora): {rotatedKey}
                  </div>
                )}
              </div>

              <div>
                <p className="font-semibold text-slate-900 mb-2">Histórico de Versões</p>
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                  {detailData.versions.map((v) => (
                    <div key={v.id} className="p-3 flex justify-between">
                      <span className="font-mono font-medium">v{v.version_number} · {v.provider} / {v.model}</span>
                      <span className="font-mono text-slate-500">{formatDateTimePT(v.created_at)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Os Meus Agentes
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Gerir agentes criados no MANDATO e agentes externos registados via gateway.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              setExtIssuedKey(null);
              setShowExternalModal(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span>Registar Agente Externo</span>
          </button>
          <button
            type="button"
            onClick={onGoToWizard}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Criar Agente</span>
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
          {error}
        </div>
      )}

      {/* Barra de pesquisa e alternador de vista */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Pesquisar agente por nome, área ou provedor..."
          className="w-full sm:w-80 px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
        />
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start">
          <button
            type="button"
            onClick={() => setViewMode('table')}
            className={`px-3 py-1 text-xs font-medium rounded-md ${
              viewMode === 'table' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            Tabela
          </button>
          <button
            type="button"
            onClick={() => setViewMode('cards')}
            className={`px-3 py-1 text-xs font-medium rounded-md ${
              viewMode === 'cards' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            Cartões
          </button>
        </div>
      </div>

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl h-64 animate-pulse" />
      ) : viewMode === 'table' ? (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 bg-slate-50/70">
                <th className="py-3 px-4">Agente</th>
                <th className="py-3 px-3">Origem</th>
                <th className="py-3 px-3">Provedor / Modelo</th>
                <th className="py-3 px-3">Estado</th>
                <th className="py-3 px-3">Segurança</th>
                <th className="py-3 px-3 text-right">Ações</th>
                <th className="py-3 px-4 text-right">Operações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {filtered.map((ag) => {
                const st = AGENT_STATUS_META[ag.status] || { label: ag.status, textClass: 'text-slate-600' };
                return (
                  <tr key={ag.id} className="hover:bg-slate-50/80">
                    <td className="py-3 px-4">
                      <p className="font-semibold text-slate-900">{ag.name}</p>
                      <p className="text-[11px] text-slate-500">{ag.category}</p>
                    </td>
                    <td className="py-3 px-3 text-slate-700">
                      {ag.origin === 'EXTERNAL' ? 'Externo' : 'Criado no MANDATO'}
                    </td>
                    <td className="py-3 px-3">
                      <p className="text-slate-800">{ag.provider}</p>
                      <p className="font-mono text-[11px] text-slate-500">{ag.model}</p>
                    </td>
                    <td className={`py-3 px-3 ${st.textClass}`}>{st.label}</td>
                    <td className="py-3 px-3">
                      <span
                        className={
                          ag.security_status === 'protected'
                            ? 'text-emerald-700 font-medium'
                            : 'text-red-700 font-medium'
                        }
                      >
                        {ag.security_status === 'protected' ? 'Protegido' : 'Requer revisão'}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900">
                      {ag.actions_count}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          title={`Ver ${ag.name}`}
                          aria-label={`Ver ${ag.name}`}
                          onClick={() => openAgentDetail(ag.id)}
                          className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title={`Testar ${ag.name}`}
                          aria-label={`Testar ${ag.name}`}
                          onClick={() => onTestAgent(ag.id)}
                          className="p-1.5 text-slate-600 hover:text-emerald-700 hover:bg-emerald-50 rounded-md"
                        >
                          <TerminalSquare className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title={`Duplicar ${ag.name}`}
                          aria-label={`Duplicar ${ag.name}`}
                          onClick={() => duplicateAgent(ag.id)}
                          className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        {ag.status === 'active' || ag.status === 'running' ? (
                          <button
                            type="button"
                            title={`Suspender ${ag.name}`}
                            aria-label={`Suspender ${ag.name}`}
                            onClick={() => changeStatus(ag.id, 'suspended')}
                            className="p-1.5 text-amber-700 hover:bg-amber-50 rounded-md"
                          >
                            <Pause className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            title={`Ativar ${ag.name}`}
                            aria-label={`Ativar ${ag.name}`}
                            onClick={() => changeStatus(ag.id, 'active')}
                            className="p-1.5 text-emerald-700 hover:bg-emerald-50 rounded-md"
                          >
                            <Play className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {ag.status !== 'archived' && (
                          <button
                            type="button"
                            title={`Arquivar ${ag.name}`}
                            aria-label={`Arquivar ${ag.name}`}
                            onClick={() => changeStatus(ag.id, 'archived')}
                            className="p-1.5 text-slate-500 hover:text-red-700 hover:bg-red-50 rounded-md"
                          >
                            <Archive className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((ag) => {
            const st = AGENT_STATUS_META[ag.status] || { label: ag.status, textClass: 'text-slate-600' };
            return (
              <div key={ag.id} className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-display text-sm font-semibold text-slate-900">{ag.name}</h3>
                    <span className={`text-xs ${st.textClass}`}>{st.label}</span>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">
                    {ag.category} · {ag.origin === 'EXTERNAL' ? 'Externo' : 'Criado no MANDATO'}
                  </p>
                  <p className="text-xs text-slate-600 mt-3 line-clamp-2">{ag.description}</p>
                </div>
                <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                  <span className="font-mono text-[11px] text-slate-500">{ag.model}</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openAgentDetail(ag.id)}
                      className="font-medium text-slate-800 hover:underline"
                    >
                      Perfil
                    </button>
                    <button
                      type="button"
                      onClick={() => onTestAgent(ag.id)}
                      className="font-medium text-emerald-700 hover:underline"
                    >
                      Testar
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal Registo de Agente Externo */}
      {showExternalModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-slate-900">Registar Agente Externo</h2>
              <button
                type="button"
                aria-label="Fechar janela"
                onClick={() => setShowExternalModal(false)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {extIssuedKey ? (
              <div className="space-y-4">
                <p className="text-xs text-emerald-800 font-medium">
                  Agente externo registado com sucesso. Utilize a credencial abaixo no cabeçalho Authorization: Bearer ao chamar POST /api/v1/authorize.
                </p>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg font-mono text-xs break-all select-all">
                  {extIssuedKey}
                </div>
                <button
                  type="button"
                  onClick={() => setShowExternalModal(false)}
                  className="w-full py-2 text-xs font-medium text-white bg-slate-900 rounded-lg"
                >
                  Concluir
                </button>
              </div>
            ) : (
              <form onSubmit={handleRegisterExternal} className="space-y-3 text-xs">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Nome do agente *</label>
                  <input
                    type="text"
                    required
                    value={extName}
                    onChange={(e) => setExtName(e.target.value)}
                    placeholder="Ex: Bot ERP Faturação"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Sistema / Provedor</label>
                    <select
                      value={extProvider}
                      onChange={(e) => setExtProvider(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                    >
                      <option value="OpenAI">OpenAI</option>
                      <option value="Google Gemini">Google Gemini</option>
                      <option value="Anthropic">Anthropic</option>
                      <option value="Microsoft">Microsoft</option>
                      <option value="Personalizado">Sistema Personalizado</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Identificador externo</label>
                    <input
                      type="text"
                      value={extIdentifier}
                      onChange={(e) => setExtIdentifier(e.target.value)}
                      placeholder="ext-erp-02"
                      className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Descrição *</label>
                  <textarea
                    rows={2}
                    required
                    value={extDesc}
                    onChange={(e) => setExtDesc(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Políticas atribuídas</label>
                  <div className="max-h-32 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                    {policies.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 p-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={extPolicies.includes(p.id)}
                          onChange={(e) => {
                            if (e.target.checked) setExtPolicies((prev) => [...prev, p.id]);
                            else setExtPolicies((prev) => prev.filter((id) => id !== p.id));
                          }}
                        />
                        <span>{p.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowExternalModal(false)}
                    className="px-3.5 py-2 border border-slate-300 rounded-lg text-slate-700"
                  >
                    Cancelar
                  </button>
                  <button type="submit" className="px-4 py-2 bg-slate-900 text-white rounded-lg font-medium">
                    Emitir Credencial e Registar
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
