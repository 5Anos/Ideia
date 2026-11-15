import React, { useEffect, useState } from 'react';
import { Download, Lock } from 'lucide-react';
import { apiFetch, getStoredToken, isDatabaseNotConnectedError } from '../utils/api';
import { formatDateTimePT } from '../utils/formatters';
import { DatabaseNotConnectedBanner } from './DatabaseNotConnectedBanner';
import type { AuditLogRecord } from '../shared/types';

interface AuditLogsViewProps {
  onNavigateSettings?: () => void;
}

export const AuditLogsView: React.FC<AuditLogsViewProps> = ({ onNavigateSettings }) => {
  const [logs, setLogs] = useState<AuditLogRecord[]>([]);
  const [search, setSearch] = useState('');
  const [eventType, setEventType] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dbDisconnected, setDbDisconnected] = useState(false);

  async function loadLogs() {
    setLoading(true);
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (eventType) params.set('event_type', eventType);
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);

    try {
      const res = await apiFetch<{ logs: AuditLogRecord[] }>(`/api/audit-logs?${params.toString()}`);
      setLogs(res.logs);
      setDbDisconnected(false);
      setError(null);
    } catch (err) {
      setDbDisconnected(isDatabaseNotConnectedError(err));
      setError(err instanceof Error ? err.message : 'Erro ao carregar registos de auditoria.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLogs();
  }, [eventType, fromDate, toDate]);

  async function handleExportCsv() {
    const token = getStoredToken();
    const res = await fetch('/api/audit-logs/export.csv', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mandato_auditoria.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (dbDisconnected) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Histórico e Auditoria
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Registos imutáveis (append-only) armazenados na folha de cálculo da empresa.
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
            Histórico e Auditoria
          </h1>
          <p className="text-xs text-slate-500 mt-1 inline-flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5 text-slate-400" />
            <span>Registos imutáveis (append-only) de todas as ações, decisões de política, aprovações e alterações de credenciais.</span>
          </p>
        </div>

        <button
          type="button"
          onClick={handleExportCsv}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap self-start"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Exportar CSV</span>
        </button>
      </div>

      {/* Filtros */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          loadLogs();
        }}
        className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs"
      >
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Pesquisar ator, ação ou motivo..."
          className="lg:col-span-2 px-3 py-2 border border-slate-300 rounded-lg"
        />
        <select
          aria-label="Filtrar por tipo de evento"
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
          className="px-3 py-2 border border-slate-300 rounded-lg bg-white"
        >
          <option value="">Todos os eventos</option>
          <option value="authorization_decision">Decisão de Autorização</option>
          <option value="blocked_action">Ação Bloqueada</option>
          <option value="approval">Aprovação</option>
          <option value="rejection">Rejeição</option>
          <option value="agent_created">Criação de Agente</option>
          <option value="policy_created">Criação de Política</option>
          <option value="policy_modified">Alteração de Política</option>
          <option value="credential_rotated">Rotação de Credencial</option>
          <option value="workflow_execution">Execução de Fluxo</option>
          <option value="user_permission_changed">Permissões de Utilizador</option>
        </select>
        <input
          type="date"
          aria-label="Data inicial"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          className="px-3 py-2 font-mono border border-slate-300 rounded-lg"
        />
        <div className="flex gap-2">
          <input
            type="date"
            aria-label="Data final"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="flex-1 px-3 py-2 font-mono border border-slate-300 rounded-lg"
          />
          <button
            type="submit"
            className="px-3 py-2 bg-slate-900 text-white rounded-lg font-medium shrink-0"
          >
            Filtrar
          </button>
        </div>
      </form>

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl h-72 animate-pulse" />
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 bg-slate-50/70">
                <th className="py-3 px-4">Data e Hora</th>
                <th className="py-3 px-3">Ator</th>
                <th className="py-3 px-3">Evento / Ação</th>
                <th className="py-3 px-3">Resultado</th>
                <th className="py-3 px-4">Motivo / Política</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500">
                    Nenhum registo encontrado com os filtros atuais.
                  </td>
                </tr>
              ) : (
                logs.map((log) => {
                  const resColor =
                    log.result === 'BLOCKED' || log.result === 'Rejeitado'
                      ? 'text-red-700 font-semibold'
                      : log.result === 'REQUIRES_APPROVAL' || log.result === 'Aguardar Aprovação'
                      ? 'text-amber-700 font-semibold'
                      : 'text-emerald-700 font-semibold';
                  return (
                    <tr key={log.id} className="hover:bg-slate-50/80">
                      <td className="py-3 px-4 font-mono tabular-nums text-[11px] text-slate-600 whitespace-nowrap">
                        {formatDateTimePT(log.created_at)}
                      </td>
                      <td className="py-3 px-3">
                        <p className="font-medium text-slate-900">{log.actor_name}</p>
                        <p className="text-[11px] text-slate-400">{log.actor_type}</p>
                      </td>
                      <td className="py-3 px-3">
                        <p className="font-medium text-slate-900">{log.action}</p>
                        <p className="font-mono text-[11px] text-slate-400">{log.event_type}</p>
                      </td>
                      <td className={`py-3 px-3 whitespace-nowrap ${resColor}`}>{log.result}</td>
                      <td className="py-3 px-4 text-slate-600 max-w-md">
                        <p>{log.reason}</p>
                        {log.related_policy && (
                          <p className="text-[11px] text-slate-400 mt-0.5">Política: {log.related_policy}</p>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
