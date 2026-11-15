import React, { useEffect, useState } from 'react';
import { Shield, RefreshCw, Lock, CheckCircle2, AlertTriangle, ExternalLink } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { formatDateTimePT } from '../utils/formatters';
import type { PlatformTenantSummary, SheetsConnectionStatus } from '../shared/types';

interface PlatformAuditEntry {
  id: string;
  actor_user_id: string | null;
  actor_email: string;
  company_id: string | null;
  event_type: string;
  detail: string;
  created_at: string;
}

const STATUS_BADGE: Record<SheetsConnectionStatus, string> = {
  'Ligado': 'bg-emerald-50 text-emerald-800 border-emerald-200',
  'Não configurado': 'bg-slate-100 text-slate-700 border-slate-200',
  'A aguardar autorização': 'bg-amber-50 text-amber-800 border-amber-200',
  'Erro de autenticação': 'bg-red-50 text-red-800 border-red-200',
  'Sem acesso à folha': 'bg-red-50 text-red-800 border-red-200',
  'Estrutura inválida': 'bg-amber-50 text-amber-800 border-amber-200',
  'Ligação expirada': 'bg-red-50 text-red-800 border-red-200',
};

export const PlatformAdminView: React.FC = () => {
  const [tenants, setTenants] = useState<PlatformTenantSummary[]>([]);
  const [auditLogs, setAuditLogs] = useState<PlatformAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadPlatformData() {
    setLoading(true);
    try {
      const res = await apiFetch<{
        tenants: PlatformTenantSummary[];
        platform_audit_logs: PlatformAuditEntry[];
      }>('/api/platform/tenants');
      setTenants(res.tenants);
      setAuditLogs(res.platform_audit_logs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar metadados da plataforma.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPlatformData();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Administração da Plataforma
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Monitorização técnica multi-tenant restrita a administradores autorizados da plataforma MANDATO.
          </p>
        </div>

        <button
          type="button"
          onClick={loadPlatformData}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 self-start"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Atualizar Metadados</span>
        </button>
      </div>

      {/* Aviso estrito de privacidade multi-tenant */}
      <div className="p-4 rounded-xl bg-slate-900 text-slate-100 border border-slate-800 flex items-start gap-3 text-xs">
        <Lock className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
        <div className="space-y-1">
          <p className="font-semibold text-white">
            Isolamento Estrito: Apenas Metadados de Ligação (Zero Conteúdo Empresarial)
          </p>
          <p className="text-slate-300 leading-relaxed">
            Este painel apresenta exclusivamente o estado da ligação Google Sheets, identificadores de folha e datas de sincronização. Os agentes, políticas, aprovações, registos de auditoria e fluxos operacionais residem apenas na Folha de Cálculo Google de cada empresa.
          </p>
        </div>
      </div>

      {error && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl h-64 animate-pulse" />
      ) : (
        <>
          {/* Tabela de Empresas */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-slate-700" />
                <h2 className="font-display text-sm font-semibold text-slate-900">
                  Empresas Registadas ({tenants.length})
                </h2>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-500 uppercase">
                    <th className="py-2.5 px-4">Empresa</th>
                    <th className="py-2.5 px-4">Plano</th>
                    <th className="py-2.5 px-4">Conta Google Verificada</th>
                    <th className="py-2.5 px-4">Folha de Cálculo</th>
                    <th className="py-2.5 px-4">Estado da Ligação</th>
                    <th className="py-2.5 px-4">Esquema</th>
                    <th className="py-2.5 px-4">Último Teste / Escrita</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {tenants.map((t) => (
                    <tr key={t.company_id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4">
                        <p className="font-semibold text-slate-900">{t.company_name}</p>
                        <p className="text-[11px] font-mono text-slate-500">
                          {t.slug}
                          {t.is_demo ? ' · Demo' : ''}
                        </p>
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-700">{t.subscription_plan}</td>
                      <td className="py-3 px-4">
                        <p className="font-mono text-slate-800">{t.verified_google_email || '—'}</p>
                        {t.entered_google_email && t.entered_google_email !== t.verified_google_email && (
                          <p className="text-[11px] text-slate-500">
                            Indicada: {t.entered_google_email}
                          </p>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {t.spreadsheet_id ? (
                          <div>
                            <p className="font-medium text-slate-900">{t.spreadsheet_name || 'Folha selecionada'}</p>
                            <a
                              href={`https://docs.google.com/spreadsheets/d/${t.spreadsheet_id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 font-mono text-[11px] text-slate-500 hover:text-slate-900"
                            >
                              <span>{t.spreadsheet_id.slice(0, 18)}…</span>
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        ) : (
                          <span className="text-slate-400">Não associada</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-semibold ${
                            STATUS_BADGE[t.connection_status] || 'bg-slate-100 text-slate-700 border-slate-200'
                          }`}
                        >
                          {t.connection_status}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        {t.schema_valid ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Válido
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-700 font-medium">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            Pendente
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-[11px] font-mono text-slate-600">
                        <p>Teste: {t.last_connection_test ? formatDateTimePT(t.last_connection_test) : '—'}</p>
                        <p>Escrita: {t.last_successful_write ? formatDateTimePT(t.last_successful_write) : '—'}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Auditoria do Plano de Controlo */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <h2 className="font-display text-sm font-semibold text-slate-900">
              Registo de Auditoria do Plano de Controlo (Últimos 40 eventos)
            </h2>
            <div className="divide-y divide-slate-100 text-xs">
              {auditLogs.length === 0 ? (
                <p className="text-slate-500 py-4">Sem eventos de plataforma registados.</p>
              ) : (
                auditLogs.map((ev) => (
                  <div key={ev.id} className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <span className="font-mono text-[11px] text-slate-500 mr-2">{ev.event_type}</span>
                      <span className="text-slate-900 font-medium">{ev.detail}</span>
                    </div>
                    <div className="text-[11px] font-mono text-slate-500 shrink-0">
                      {ev.actor_email} · {formatDateTimePT(ev.created_at)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
