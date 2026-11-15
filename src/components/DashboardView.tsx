import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  ShieldAlert,
  Clock,
  Ban,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { apiFetch } from '../utils/api';
import { formatDateTimePT, formatEUR, AGENT_STATUS_META } from '../utils/formatters';
import type { NavSectionId } from './Sidebar';

interface DashboardData {
  kpis: {
    total_agents: number;
    active_agents: number;
    running_agents: number;
    verified_actions: number;
    pending_approvals: number;
    blocked_actions: number;
  };
  activity_chart: Array<{ date: string; allowed: number; pending: number; blocked: number }>;
  agent_performance: Array<{
    id: string;
    name: string;
    category: string;
    status: string;
    completed_tasks: number;
    authorization_requests: number;
    blocked_actions: number;
  }>;
  pending_approvals: Array<{
    id: string;
    agent_name: string;
    requested_action: string;
    description: string;
    financial_value: number | null;
    policy_name: string;
    created_at: string;
    is_demo: number;
  }>;
  security_status: {
    agents_without_policies: number;
    agents_suspended_credentials: number;
    recent_security_incidents: number;
    policies_requiring_review: number;
  };
  recent_activity: Array<{
    id: string;
    actor_name: string;
    event_type: string;
    action: string;
    result: string;
    created_at: string;
    is_demo: number;
  }>;
}

interface DashboardViewProps {
  isDemoCompany: boolean;
  onNavigate: (section: NavSectionId) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({ isDemoCompany, onNavigate }) => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiFetch<DashboardData>('/api/dashboard')
      .then((res) => {
        if (active) {
          setData(res);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Erro ao carregar painel.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div key={idx} className="bg-white border border-slate-200 rounded-xl p-4 h-24 animate-pulse" />
          ))}
        </div>
        <div className="bg-white border border-slate-200 rounded-xl h-72 animate-pulse" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-white border border-red-200 rounded-xl p-6 text-sm text-red-700">
        {error || 'Não foi possível carregar os dados da visão geral.'}
      </div>
    );
  }

  const maxDayTotal = Math.max(
    1,
    ...data.activity_chart.map((d) => d.allowed + d.pending + d.blocked)
  );

  const kpiCards = [
    { label: 'Total de agentes', value: data.kpis.total_agents, tone: 'text-slate-900' },
    { label: 'Agentes ativos', value: data.kpis.active_agents, tone: 'text-emerald-700' },
    { label: 'Agentes em execução', value: data.kpis.running_agents, tone: 'text-slate-900' },
    { label: 'Ações verificadas', value: data.kpis.verified_actions, tone: 'text-slate-900' },
    { label: 'Aprovações pendentes', value: data.kpis.pending_approvals, tone: 'text-amber-700' },
    { label: 'Ações bloqueadas', value: data.kpis.blocked_actions, tone: 'text-red-700' },
  ];

  return (
    <div className="space-y-6">
      {/* Cabeçalho contextual */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Visão Geral de Governação
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Monitorização operacional dos agentes, autorizações e controlo humano em tempo real.
            {isDemoCompany ? ' · Dados de Demonstração ativos' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onNavigate('create-agent')}
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            Criar Novo Agente
          </button>
        </div>
      </div>

      {/* 6 KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {kpiCards.map((card) => (
          <div key={card.label} className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">{card.label}</p>
            <p className={`mt-2 text-2xl font-semibold font-mono tabular-nums ${card.tone}`}>
              {card.value}
            </p>
          </div>
        ))}
      </div>

      {/* A. Gráfico de Atividade Diária + D. Estado de Segurança */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-4 border-b border-slate-100">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900">
                Atividade Diária de Autorizações
              </h2>
              <p className="text-xs text-slate-500">Últimos 7 dias por decisão do motor MANDATO</p>
            </div>
            <div className="flex items-center gap-4 text-xs text-slate-600">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-emerald-600 inline-block" />
                Permitidas
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-amber-500 inline-block" />
                Pendentes
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-red-600 inline-block" />
                Bloqueadas
              </span>
            </div>
          </div>

          <div className="mt-6 h-52 flex items-end justify-between gap-3">
            {data.activity_chart.map((day) => {
              const total = day.allowed + day.pending + day.blocked;
              const allowedH = Math.round((day.allowed / maxDayTotal) * 160);
              const pendingH = Math.round((day.pending / maxDayTotal) * 160);
              const blockedH = Math.round((day.blocked / maxDayTotal) * 160);
              return (
                <div key={day.date} className="flex-1 flex flex-col items-center gap-2">
                  <div className="w-full max-w-[44px] h-44 flex flex-col justify-end gap-0.5">
                    {total === 0 ? (
                      <div className="w-full h-1 bg-slate-100 rounded-xs" />
                    ) : (
                      <>
                        {day.blocked > 0 && (
                          <div
                            title={`${day.blocked} bloqueadas`}
                            style={{ height: `${Math.max(6, blockedH)}px` }}
                            className="w-full bg-red-600 rounded-t-xs"
                          />
                        )}
                        {day.pending > 0 && (
                          <div
                            title={`${day.pending} pendentes`}
                            style={{ height: `${Math.max(6, pendingH)}px` }}
                            className="w-full bg-amber-500"
                          />
                        )}
                        {day.allowed > 0 && (
                          <div
                            title={`${day.allowed} permitidas`}
                            style={{ height: `${Math.max(6, allowedH)}px` }}
                            className="w-full bg-emerald-600 rounded-b-xs"
                          />
                        )}
                      </>
                    )}
                  </div>
                  <div className="text-center">
                    <p className="text-[11px] font-mono tabular-nums text-slate-600">{day.date}</p>
                    <p className="text-[11px] font-mono tabular-nums text-slate-400">{total}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* D. Estado de Segurança */}
        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900">Estado de Segurança</h2>
            <p className="text-xs text-slate-500 mt-0.5">Indicadores de conformidade empresarial</p>

            <div className="mt-5 divide-y divide-slate-100">
              <div className="py-3 flex items-center justify-between">
                <span className="text-xs text-slate-700">Agentes sem políticas</span>
                <span
                  className={`text-sm font-mono tabular-nums font-semibold ${
                    data.security_status.agents_without_policies > 0 ? 'text-red-700' : 'text-emerald-700'
                  }`}
                >
                  {data.security_status.agents_without_policies}
                </span>
              </div>
              <div className="py-3 flex items-center justify-between">
                <span className="text-xs text-slate-700">Credenciais suspensas</span>
                <span
                  className={`text-sm font-mono tabular-nums font-semibold ${
                    data.security_status.agents_suspended_credentials > 0 ? 'text-amber-700' : 'text-emerald-700'
                  }`}
                >
                  {data.security_status.agents_suspended_credentials}
                </span>
              </div>
              <div className="py-3 flex items-center justify-between">
                <span className="text-xs text-slate-700">Incidentes recentes bloqueados</span>
                <span className="text-sm font-mono tabular-nums font-semibold text-slate-900">
                  {data.security_status.recent_security_incidents}
                </span>
              </div>
              <div className="py-3 flex items-center justify-between">
                <span className="text-xs text-slate-700">Políticas a requerer revisão</span>
                <span
                  className={`text-sm font-mono tabular-nums font-semibold ${
                    data.security_status.policies_requiring_review > 0 ? 'text-amber-700' : 'text-emerald-700'
                  }`}
                >
                  {data.security_status.policies_requiring_review}
                </span>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onNavigate('policies')}
            className="mt-4 w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>Rever Políticas e Permissões</span>
          </button>
        </div>
      </div>

      {/* B. Desempenho dos Agentes + C. Aprovações Pendentes */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex items-center justify-between pb-4 border-b border-slate-100">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900">Desempenho dos Agentes</h2>
              <p className="text-xs text-slate-500">Agentes mais ativos, autorizações e bloqueios</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('my-agents')}
              className="text-xs font-medium text-slate-700 hover:text-slate-900 inline-flex items-center gap-1"
            >
              <span>Ver todos</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500">
                  <th className="py-2 pr-3">Agente</th>
                  <th className="py-2 px-3">Estado</th>
                  <th className="py-2 px-3 text-right">Tarefas</th>
                  <th className="py-2 px-3 text-right">Pedidos</th>
                  <th className="py-2 pl-3 text-right">Bloqueios</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {data.agent_performance.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-slate-500">
                      Nenhum agente ativo registado.
                    </td>
                  </tr>
                ) : (
                  data.agent_performance.map((ag) => {
                    const st = AGENT_STATUS_META[ag.status] || { label: ag.status, textClass: 'text-slate-600' };
                    return (
                      <tr key={ag.id} className="hover:bg-slate-50/80">
                        <td className="py-2.5 pr-3">
                          <p className="font-medium text-slate-900">{ag.name}</p>
                          <p className="text-[11px] text-slate-500">{ag.category}</p>
                        </td>
                        <td className={`py-2.5 px-3 ${st.textClass}`}>{st.label}</td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-900">
                          {ag.completed_tasks}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                          {ag.authorization_requests}
                        </td>
                        <td className="py-2.5 pl-3 text-right font-mono tabular-nums text-red-700">
                          {ag.blocked_actions}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* C. Aprovações Pendentes */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-900">
                  Aprovações Pendentes
                </h2>
                <p className="text-xs text-slate-500">Pedidos a aguardar decisão humana</p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('approvals')}
                className="text-xs font-medium text-slate-700 hover:text-slate-900 inline-flex items-center gap-1"
              >
                <span>Gerir fila</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="mt-4 divide-y divide-slate-100">
              {data.pending_approvals.length === 0 ? (
                <div className="py-8 text-center">
                  <CheckCircle2 className="w-6 h-6 text-emerald-600 mx-auto" />
                  <p className="text-xs text-slate-500 mt-2">Sem pedidos pendentes de autorização.</p>
                </div>
              ) : (
                data.pending_approvals.slice(0, 4).map((apr) => (
                  <div key={apr.id} className="py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-slate-900 truncate">{apr.description}</p>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          {apr.agent_name} · {formatDateTimePT(apr.created_at)}
                          {apr.is_demo ? ' · Demonstração' : ''}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs font-mono tabular-nums font-semibold text-amber-700">
                          {apr.financial_value !== null ? formatEUR(apr.financial_value) : 'Ação'}
                        </p>
                        <p className="text-[11px] text-amber-700">Pendente</p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => onNavigate('approvals')}
            className="mt-4 w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-amber-900 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors"
          >
            <Clock className="w-3.5 h-3.5" />
            <span>Abrir Pedidos de Aprovação</span>
          </button>
        </div>
      </div>

      {/* E. Atividade Recente */}
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex items-center justify-between pb-4 border-b border-slate-100">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900">Atividade Recente</h2>
            <p className="text-xs text-slate-500">Últimos eventos registados na trilha de auditoria</p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('audit')}
            className="text-xs font-medium text-slate-700 hover:text-slate-900 inline-flex items-center gap-1"
          >
            <span>Auditoria completa</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="mt-4 divide-y divide-slate-100">
          {data.recent_activity.map((ev) => {
            const isBlocked = ev.result === 'BLOCKED' || ev.event_type === 'blocked_action';
            const isPending = ev.result === 'REQUIRES_APPROVAL' || ev.result === 'Aguardar Aprovação';
            return (
              <div key={ev.id} className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2.5 min-w-0">
                  {isBlocked ? (
                    <Ban className="w-4 h-4 text-red-600 shrink-0" />
                  ) : isPending ? (
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <span className="font-medium text-slate-900">{ev.action}</span>
                    <span className="text-slate-500"> · {ev.actor_name}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0 text-[11px] font-mono tabular-nums text-slate-500">
                  <span
                    className={
                      isBlocked ? 'text-red-700 font-semibold' : isPending ? 'text-amber-700 font-semibold' : 'text-emerald-700'
                    }
                  >
                    {ev.result}
                  </span>
                  <span>{formatDateTimePT(ev.created_at)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
