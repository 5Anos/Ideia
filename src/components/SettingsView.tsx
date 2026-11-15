import React, { useEffect, useState } from 'react';
import {
  Database,
  Check,
  HardDrive,
  RefreshCw,
  UploadCloud,
  DownloadCloud,
  Trash2,
  LogOut,
  AlertTriangle,
} from 'lucide-react';
import { apiFetch, getStoredToken } from '../utils/api';
import { formatDateTimePT, formatEUR } from '../utils/formatters';
import {
  getGoogleDriveAccessToken,
  initGoogleDriveAuth,
  signInWithCompanyGoogleDrive,
  signOutGoogleDrive,
} from '../utils/googleDriveAuth';
import { GoogleSignInButton } from './GoogleSignInButton';
import type { Company, SubscriptionPlan, UserRole } from '../shared/types';

interface DriveFileSummary {
  id: string;
  name: string;
  modifiedTime: string;
  sizeBytes: number;
}

interface DriveConfirmAction {
  type: 'sync' | 'restore' | 'delete';
  fileId?: string;
  fileName?: string;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
}

interface SettingsViewProps {
  currentUserRole: UserRole;
  onCompanyUpdated: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ currentUserRole, onCompanyUpdated }) => {
  const [company, setCompany] = useState<Company | null>(null);
  const [plans, setPlans] = useState<
    Record<
      SubscriptionPlan,
      {
        label: string;
        audience: string;
        monthlyPriceEur: number;
        maxAgents: number;
        maxUsers: number;
        workflowsEnabled: boolean;
        advancedGovernance: boolean;
        retentionDays: number;
      }
    >
  >({} as never);
  const [dbMode, setDbMode] = useState('');
  const [supabaseConfigured, setSupabaseConfigured] = useState(false);

  const [name, setName] = useState('');
  const [nif, setNif] = useState('');
  const [sector, setSector] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Estado Google Drive da Empresa
  const [driveToken, setDriveToken] = useState<string | null>(() => getGoogleDriveAccessToken());
  const [driveAccount, setDriveAccount] = useState<{ email: string; displayName: string } | null>(null);
  const [driveFiles, setDriveFiles] = useState<DriveFileSummary[]>([]);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveBusy, setDriveBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<DriveConfirmAction | null>(null);

  const canEdit = currentUserRole === 'OWNER';

  async function loadSettings() {
    const [compRes, sysRes] = await Promise.all([
      apiFetch<{ company: Company; plans: typeof plans }>('/api/company'),
      apiFetch<{ database_mode: string; supabase_configured: boolean }>('/api/system/status'),
    ]);
    setCompany(compRes.company);
    setPlans(compRes.plans);
    setName(compRes.company.name);
    setNif(compRes.company.nif || '');
    setSector(compRes.company.sector || '');
    setDbMode(sysRes.database_mode);
    setSupabaseConfigured(sysRes.supabase_configured);
  }

  async function driveApiRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
    const sessionToken = getStoredToken();
    const res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        'X-Google-Access-Token': token,
        ...(init?.headers || {}),
      },
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || `Erro (${res.status})`);
    }
    return data;
  }

  async function refreshDriveFiles(token: string) {
    setDriveLoading(true);
    try {
      const data = await driveApiRequest<{
        account: { email: string; displayName: string };
        files: DriveFileSummary[];
      }>('/api/company/drive/status', token);
      setDriveAccount(data.account);
      setDriveFiles(data.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar estado da Google Drive.');
    } finally {
      setDriveLoading(false);
    }
  }

  useEffect(() => {
    loadSettings();
    const unsub = initGoogleDriveAuth(
      (_user, token) => {
        setDriveToken(token);
        if (canEdit) refreshDriveFiles(token);
      },
      () => {
        setDriveToken(null);
        setDriveAccount(null);
        setDriveFiles([]);
      }
    );
    const existing = getGoogleDriveAccessToken();
    if (existing && canEdit) {
      setDriveToken(existing);
      refreshDriveFiles(existing);
    }
    return unsub;
  }, [canEdit]);

  async function handleConnectGoogleDrive() {
    setError(null);
    setMessage(null);
    setDriveLoading(true);
    try {
      const res = await signInWithCompanyGoogleDrive();
      if (res?.accessToken) {
        setDriveToken(res.accessToken);
        await refreshDriveFiles(res.accessToken);
        setMessage(`Conta Google Drive (${res.user.email || 'empresarial'}) ligada com sucesso nesta sessão.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha na autenticação com o Google.');
    } finally {
      setDriveLoading(false);
    }
  }

  async function handleDisconnectGoogleDrive() {
    await signOutGoogleDrive();
    setDriveToken(null);
    setDriveAccount(null);
    setDriveFiles([]);
    setMessage('Sessão Google Drive terminada e token removido da memória.');
  }

  async function executeConfirmedDriveAction() {
    if (!confirmAction || !driveToken) return;
    setDriveBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (confirmAction.type === 'sync') {
        const res = await driveApiRequest<{ file: DriveFileSummary; operation: 'created' | 'updated' }>(
          '/api/company/drive/sync',
          driveToken,
          { method: 'POST', body: JSON.stringify({}) }
        );
        setMessage(
          `Base de dados ${res.operation === 'created' ? 'criada' : 'atualizada'} na Google Drive (${res.file.name}).`
        );
        await refreshDriveFiles(driveToken);
      } else if (confirmAction.type === 'restore' && confirmAction.fileId) {
        const res = await driveApiRequest<{
          restoredCounts: { agents: number; policies: number; workflows: number };
        }>('/api/company/drive/restore', driveToken, {
          method: 'POST',
          body: JSON.stringify({ file_id: confirmAction.fileId }),
        });
        setMessage(
          `Base de dados restaurada da Google Drive: ${res.restoredCounts.agents} agentes, ${res.restoredCounts.policies} políticas e ${res.restoredCounts.workflows} fluxos carregados.`
        );
        await loadSettings();
        onCompanyUpdated();
      } else if (confirmAction.type === 'delete' && confirmAction.fileId) {
        await driveApiRequest(`/api/company/drive/files/${encodeURIComponent(confirmAction.fileId)}`, driveToken, {
          method: 'DELETE',
        });
        setMessage(`Ficheiro "${confirmAction.fileName}" eliminado da Google Drive.`);
        await refreshDriveFiles(driveToken);
      }
      setConfirmAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro na operação com a Google Drive.');
    } finally {
      setDriveBusy(false);
    }
  }

  async function handleSaveCompany(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      await apiFetch('/api/company', {
        method: 'PATCH',
        body: JSON.stringify({ name, nif, sector }),
      });
      setMessage('Definições da empresa guardadas.');
      await loadSettings();
      onCompanyUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao guardar definições.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSelectPlan(plan: SubscriptionPlan) {
    setError(null);
    setMessage(null);
    try {
      await apiFetch('/api/company', {
        method: 'PATCH',
        body: JSON.stringify({ subscription_plan: plan }),
      });
      setMessage(`Plano estrutural alterado para ${plan} (faturação externa não ativada no MVP).`);
      await loadSettings();
      onCompanyUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao alterar plano.');
    }
  }

  if (!company) {
    return <div className="bg-white border border-slate-200 rounded-xl h-72 animate-pulse" />;
  }

  const targetFileName = `mandato-db-${company.slug}.json`;
  const existingTargetFile = driveFiles.find((f) => f.name === targetFileName);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
          Definições e Subscrição
        </h1>
        <p className="text-xs text-slate-500 mt-1">
          Dados fiscais da empresa, base de dados na Google Drive empresarial, planos comerciais SaaS e estado do servidor.
        </p>
      </div>

      {error && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
          {error}
        </div>
      )}
      {message && (
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
          {message}
        </div>
      )}

      {/* Base de Dados na Google Drive da Empresa */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 text-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="flex items-start gap-2.5">
            <HardDrive className="w-5 h-5 text-slate-700 mt-0.5 shrink-0" />
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900">
                Base de Dados no Google Drive da Empresa
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Ligue a conta Google/Gmail empresarial para guardar, sincronizar e restaurar a base de dados isolada da empresa numa pasta dedicada no Google Drive (<span className="font-mono">MANDATO - Base de Dados</span>).
              </p>
            </div>
          </div>

          {driveToken && driveAccount && (
            <button
              type="button"
              onClick={handleDisconnectGoogleDrive}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg self-start"
            >
              <LogOut className="w-3.5 h-3.5" />
              Terminar Sessão Google
            </button>
          )}
        </div>

        {!canEdit ? (
          <p className="text-slate-500">
            Apenas utilizadores com perfil <strong className="text-slate-700">OWNER (Proprietário)</strong> podem ligar ou sincronizar a base de dados empresarial no Google Drive.
          </p>
        ) : !driveToken ? (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg bg-slate-50 border border-slate-200">
            <div className="space-y-1">
              <p className="font-semibold text-slate-800">Conta Google Drive não ligada nesta sessão</p>
              <p className="text-slate-600">
                Inicie sessão com o Gmail da empresa para autorizar acesso apenas aos ficheiros criados pela plataforma MANDATO. O token permanece exclusivamente em memória.
              </p>
            </div>
            <GoogleSignInButton
              onClick={handleConnectGoogleDrive}
              disabled={driveLoading}
              label={driveLoading ? 'A ligar...' : 'Iniciar sessão com o Google'}
            />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-lg bg-emerald-50/70 border border-emerald-200">
              <div>
                <p className="font-semibold text-emerald-900">
                  Ligado a: {driveAccount?.displayName || 'Conta Google'} ({driveAccount?.email || 'a verificar...'})
                </p>
                <p className="text-emerald-800 mt-0.5">
                  Ficheiro alvo da empresa: <span className="font-mono">{targetFileName}</span>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={driveLoading}
                  onClick={() => refreshDriveFiles(driveToken)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-300 text-slate-800 rounded-lg font-medium hover:bg-slate-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${driveLoading ? 'animate-spin' : ''}`} />
                  Atualizar Lista
                </button>
                <button
                  type="button"
                  disabled={driveBusy}
                  onClick={() =>
                    setConfirmAction({
                      type: 'sync',
                      fileName: targetFileName,
                      title: existingTargetFile
                        ? 'Atualizar base de dados no Google Drive?'
                        : 'Criar base de dados no Google Drive?',
                      description: existingTargetFile
                        ? `O ficheiro existente "${targetFileName}" na pasta "MANDATO - Base de Dados" será substituído pela cópia atual dos agentes, políticas, fluxos, aprovações e auditoria da empresa.`
                        : `Será criado o ficheiro "${targetFileName}" na pasta "MANDATO - Base de Dados" da conta ${driveAccount?.email || 'Google'} com todos os dados atuais da empresa.`,
                      confirmLabel: existingTargetFile ? 'Confirmar Atualização' : 'Confirmar Gravação',
                    })
                  }
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800 disabled:opacity-50"
                >
                  <UploadCloud className="w-3.5 h-3.5" />
                  Guardar na Google Drive
                </button>
              </div>
            </div>

            {driveFiles.length === 0 ? (
              <p className="text-slate-500 py-2">
                Ainda não existem ficheiros de base de dados MANDATO na pasta desta conta Google Drive. Clique em «Guardar na Google Drive» para criar o primeiro.
              </p>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500 uppercase">
                      <th className="py-2.5 px-3 font-semibold">Ficheiro na Google Drive</th>
                      <th className="py-2.5 px-3 font-semibold">Última Modificação</th>
                      <th className="py-2.5 px-3 font-semibold">Tamanho</th>
                      <th className="py-2.5 px-3 font-semibold text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {driveFiles.map((f) => (
                      <tr key={f.id} className="hover:bg-slate-50/70">
                        <td className="py-2.5 px-3 font-mono text-slate-900">{f.name}</td>
                        <td className="py-2.5 px-3 text-slate-600 tabular-nums">
                          {formatDateTimePT(f.modifiedTime)}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-slate-600 tabular-nums">
                          {(f.sizeBytes / 1024).toFixed(1)} KB
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                setConfirmAction({
                                  type: 'restore',
                                  fileId: f.id,
                                  fileName: f.name,
                                  title: `Restaurar base de dados de "${f.name}"?`,
                                  description:
                                    'Esta operação irá substituir os agentes, políticas, fluxos de trabalho e pedidos atuais desta empresa pelos dados guardados neste ficheiro da Google Drive.',
                                  confirmLabel: 'Confirmar Restauro',
                                  danger: true,
                                })
                              }
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-white border border-slate-300 text-slate-800 rounded-md hover:bg-slate-50"
                            >
                              <DownloadCloud className="w-3 h-3" />
                              Restaurar
                            </button>
                            <button
                              type="button"
                              aria-label={`Eliminar ficheiro ${f.name}`}
                              onClick={() =>
                                setConfirmAction({
                                  type: 'delete',
                                  fileId: f.id,
                                  fileName: f.name,
                                  title: `Eliminar "${f.name}" da Google Drive?`,
                                  description:
                                    'O ficheiro selecionado será eliminado da Google Drive empresarial. Os dados atualmente ativos no servidor local não são apagados.',
                                  confirmLabel: 'Confirmar Eliminação',
                                  danger: true,
                                })
                              }
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-red-50 border border-red-200 text-red-700 rounded-md hover:bg-red-100"
                            >
                              <Trash2 className="w-3 h-3" />
                              Eliminar
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Dados da Empresa */}
      <form onSubmit={handleSaveCompany} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 text-xs">
        <h2 className="font-display text-base font-semibold text-slate-900">Perfil da Empresa</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block font-medium text-slate-700 mb-1">Denominação Social</label>
            <input
              type="text"
              disabled={!canEdit}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg disabled:bg-slate-50"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">NIF</label>
            <input
              type="text"
              disabled={!canEdit}
              value={nif}
              onChange={(e) => setNif(e.target.value)}
              className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg disabled:bg-slate-50"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">Setor de Atividade</label>
            <input
              type="text"
              disabled={!canEdit}
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg disabled:bg-slate-50"
            />
          </div>
        </div>
        {canEdit && (
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800"
          >
            {saving ? 'A guardar...' : 'Guardar Definições'}
          </button>
        )}
      </form>

      {/* Planos SaaS */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div>
          <h2 className="font-display text-base font-semibold text-slate-900">
            Arquitetura de Planos SaaS (Estrutura preparada para faturação futura)
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Os limites de agentes, utilizadores, fluxos e retenção de auditoria são aplicados automaticamente pelo servidor.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {(['STARTER', 'PROFESSIONAL', 'BUSINESS'] as SubscriptionPlan[]).map((planKey) => {
            const p = plans[planKey];
            if (!p) return null;
            const isCurrent = company.subscription_plan === planKey;
            return (
              <div
                key={planKey}
                className={`border rounded-xl p-5 flex flex-col justify-between ${
                  isCurrent ? 'border-slate-900 bg-slate-50/60' : 'border-slate-200 bg-white'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="font-display text-base font-semibold text-slate-900">{p.label}</h3>
                    {isCurrent && <Check className="w-4 h-4 text-emerald-700" />}
                  </div>
                  <p className="text-xs text-slate-500 mt-1">{p.audience}</p>
                  <p className="mt-4 text-2xl font-mono font-semibold text-slate-900">
                    {formatEUR(p.monthlyPriceEur)}
                    <span className="text-xs font-sans font-normal text-slate-500"> / mês</span>
                  </p>

                  <div className="mt-4 pt-4 border-t border-slate-100 space-y-2 text-xs text-slate-700">
                    <p>Máximo de agentes: <strong className="font-mono">{p.maxAgents}</strong></p>
                    <p>Máximo de utilizadores: <strong className="font-mono">{p.maxUsers}</strong></p>
                    <p>Fluxos de trabalho: <strong>{p.workflowsEnabled ? 'Incluído' : 'Não incluído'}</strong></p>
                    <p>Retenção de auditoria: <strong className="font-mono">{p.retentionDays} dias</strong></p>
                  </div>
                </div>

                {canEdit && (
                  <button
                    type="button"
                    disabled={isCurrent}
                    onClick={() => handleSelectPlan(planKey)}
                    className={`mt-5 w-full py-2 text-xs font-medium rounded-lg ${
                      isCurrent
                        ? 'bg-slate-200 text-slate-600 cursor-default'
                        : 'bg-slate-900 text-white hover:bg-slate-800'
                    }`}
                  >
                    {isCurrent ? 'Plano Ativo' : `Selecionar ${p.label}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Estado da Base de Dados & Supabase */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3 text-xs">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-slate-700" />
          <h2 className="font-display text-base font-semibold text-slate-900">
            Base de Dados Local e Ligação Supabase PostgreSQL
          </h2>
        </div>
        <p className="text-slate-700">
          Modo ativo neste servidor: <strong className="font-mono">{dbMode}</strong>
        </p>
        {!supabaseConfigured && (
          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-slate-600 space-y-1">
            <p className="font-semibold text-slate-800">Como ligar ao Supabase PostgreSQL + Auth (opcional):</p>
            <p>1. Execute as migrações <span className="font-mono">supabase/migrations/001_initial_schema.sql</span> e <span className="font-mono">supabase/seed.sql</span> no seu projeto Supabase.</p>
            <p>2. Defina <span className="font-mono">SUPABASE_URL</span>, <span className="font-mono">SUPABASE_ANON_KEY</span> e <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span> nas variáveis de ambiente do servidor.</p>
          </div>
        )}
      </div>

      {/* Modal de Confirmação Explícita para Operações Google Drive */}
      {confirmAction && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="drive-confirm-title"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-start gap-3">
              <AlertTriangle
                className={`w-5 h-5 mt-0.5 shrink-0 ${
                  confirmAction.danger ? 'text-red-600' : 'text-amber-600'
                }`}
              />
              <div>
                <h3 id="drive-confirm-title" className="font-display text-base font-semibold text-slate-900">
                  {confirmAction.title}
                </h3>
                <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
                  {confirmAction.description}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={driveBusy}
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={driveBusy}
                onClick={executeConfirmedDriveAction}
                className={`px-4 py-2 text-xs font-medium text-white rounded-lg disabled:opacity-50 ${
                  confirmAction.danger
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-slate-900 hover:bg-slate-800'
                }`}
              >
                {driveBusy ? 'A executar...' : confirmAction.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
