import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, HelpCircle, GitBranch, Clock } from 'lucide-react';
import { apiFetch, isDatabaseNotConnectedError } from '../utils/api';
import { formatDateTimePT, formatEUR, RISK_LABELS } from '../utils/formatters';
import { DatabaseNotConnectedBanner } from './DatabaseNotConnectedBanner';
import type { ApprovalRequestRecord, ApprovalStatus } from '../shared/types';

interface ApprovalsViewProps {
  onApprovalsUpdated: () => void;
  onNavigateSettings?: () => void;
}

export const ApprovalsView: React.FC<ApprovalsViewProps> = ({
  onApprovalsUpdated,
  onNavigateSettings,
}) => {
  const [approvals, setApprovals] = useState<ApprovalRequestRecord[]>([]);
  const [statusFilter, setStatusFilter] = useState<'Todos' | ApprovalStatus>('Todos');
  const [justifications, setJustifications] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [dbDisconnected, setDbDisconnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  async function loadApprovals() {
    setLoading(true);
    try {
      const res = await apiFetch<{ approvals: ApprovalRequestRecord[] }>('/api/approvals');
      setApprovals(res.approvals);
      setError(null);
      setDbDisconnected(false);
    } catch (err) {
      setDbDisconnected(isDatabaseNotConnectedError(err));
      setError(err instanceof Error ? err.message : 'Erro ao carregar aprovações.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadApprovals();
  }, []);

  async function handleDecision(
    approvalId: string,
    decision: 'Aprovado' | 'Rejeitado' | 'Informacao_Solicitada'
  ) {
    const justification = (justifications[approvalId] || '').trim();
    if (!justification) {
      setError('Indique uma justificação obrigatória antes de registar a decisão.');
      return;
    }
    setError(null);
    setFeedback(null);
    try {
      const res = await apiFetch<{ status: string; note: string }>(`/api/approvals/${approvalId}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, justification }),
      });
      setFeedback(res.note);
      setJustifications((prev) => ({ ...prev, [approvalId]: '' }));
      await loadApprovals();
      onApprovalsUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao registar decisão.');
    }
  }

  const filtered =
    statusFilter === 'Todos' ? approvals : approvals.filter((a) => a.status === statusFilter);

  if (dbDisconnected) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Pedidos de Aprovação
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Controlo humano obrigatório para ações financeiras ou operacionais sensíveis.
          </p>
        </div>
        <DatabaseNotConnectedBanner message={error || undefined} onNavigateSettings={onNavigateSettings} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Pedidos de Aprovação
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Controlo humano obrigatório para ações financeiras ou operacionais sensíveis. A aprovação regista a autorização e retoma fluxos de trabalho em pausa.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg self-start">
          {(['Todos', 'Pendente', 'Aprovado', 'Rejeitado', 'Expirado'] as const).map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                statusFilter === st ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
          {error}
        </div>
      )}
      {feedback && (
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
          {feedback}
        </div>
      )}

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl h-64 animate-pulse" />
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-xs text-slate-500">
          Sem pedidos de aprovação no filtro selecionado.
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((apr) => {
            const risk = RISK_LABELS[apr.risk_level] || { label: apr.risk_level, textClass: 'text-slate-600' };
            const statusColor =
              apr.status === 'Pendente'
                ? 'text-amber-700'
                : apr.status === 'Aprovado'
                ? 'text-emerald-700'
                : apr.status === 'Expirado'
                ? 'text-slate-500'
                : 'text-red-700';

            return (
              <div key={apr.id} className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                      <span className="font-mono">ID: {apr.id}</span>
                      <span aria-hidden="true">·</span>
                      <span>{apr.agent_name}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatDateTimePT(apr.created_at)}</span>
                      {apr.expires_at && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            Expira: {formatDateTimePT(apr.expires_at)}
                          </span>
                        </>
                      )}
                      {apr.workflow_execution_id && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1 text-slate-700 font-medium">
                            <GitBranch className="w-3 h-3" />
                            Fluxo em pausa
                          </span>
                        </>
                      )}
                    </div>
                    <h2 className="font-display text-base font-semibold text-slate-900">
                      {apr.description}
                    </h2>
                    <p className="text-xs text-slate-600">
                      Ação solicitada: <span className="font-mono">{apr.requested_action}</span> · Política aplicada:{' '}
                      <span className="font-medium text-slate-800">{apr.policy_name}</span>
                    </p>
                  </div>

                  <div className="flex items-center gap-6 shrink-0">
                    <div className="text-right">
                      <p className="text-[11px] text-slate-500">Valor</p>
                      <p className="text-base font-mono tabular-nums font-semibold text-slate-900">
                        {apr.financial_value !== null ? formatEUR(apr.financial_value) : '—'}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[11px] text-slate-500">Risco</p>
                      <p className={`text-xs font-semibold ${risk.textClass}`}>{risk.label}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[11px] text-slate-500">Estado</p>
                      <p className={`text-xs font-semibold ${statusColor}`}>{apr.status}</p>
                    </div>
                  </div>
                </div>

                {apr.info_requested_note && (
                  <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                    Pedido de esclarecimento: {apr.info_requested_note}
                  </div>
                )}

                {apr.status === 'Pendente' && (
                  <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                    <input
                      type="text"
                      aria-label={`Justificação para ${apr.id}`}
                      value={justifications[apr.id] || ''}
                      onChange={(e) =>
                        setJustifications((prev) => ({ ...prev, [apr.id]: e.target.value }))
                      }
                      placeholder="Justificação obrigatória da decisão para registo de auditoria..."
                      className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleDecision(apr.id, 'Aprovado')}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 whitespace-nowrap"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Aprovar</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDecision(apr.id, 'Rejeitado')}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-red-700 rounded-lg hover:bg-red-800 whitespace-nowrap"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Rejeitar</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDecision(apr.id, 'Informacao_Solicitada')}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
                      >
                        <HelpCircle className="w-3.5 h-3.5" />
                        <span>Pedir Info</span>
                      </button>
                    </div>
                  </div>
                )}

                {apr.decision_history && apr.decision_history.length > 0 && (
                  <div className="pt-3 border-t border-slate-100 space-y-1.5 text-xs">
                    <p className="font-semibold text-slate-800">Histórico de Decisões</p>
                    {apr.decision_history.map((d) => (
                      <p key={d.id} className="text-slate-600">
                        <span className="font-mono text-[11px] text-slate-400">{formatDateTimePT(d.created_at)}</span> ·{' '}
                        <span className="font-semibold text-slate-900">{d.approver_name}</span> ({d.decision}):{' '}
                        {d.justification}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
