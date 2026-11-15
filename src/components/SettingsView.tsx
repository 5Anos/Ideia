import React, { useEffect, useState } from 'react';
import {
  Database,
  Check,
  RefreshCw,
  PlusCircle,
  FolderSearch,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Unplug,
  Wrench,
  Activity,
  X,
} from 'lucide-react';
import { apiFetch } from '../utils/api';
import { formatDateTimePT, formatEUR } from '../utils/formatters';
import {
  clearGoogleAccessTokenFromMemory,
  requestGoogleWorkspaceAccessToken,
  signOutGoogleDrive,
} from '../utils/googleDriveAuth';
import { GoogleSignInButton } from './GoogleSignInButton';
import type {
  Company,
  SheetsConnectionStatus,
  SubscriptionPlan,
  TenantSheetsConfig,
  UserRole,
} from '../shared/types';

interface SpreadsheetListItem {
  id: string;
  name: string;
  modifiedTime: string;
  webViewLink: string;
}

interface SheetsTestStepResult {
  step: string;
  ok: boolean;
  detail: string;
}

interface ConfirmDialogState {
  type: 'create' | 'initialize' | 'disconnect';
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
}

interface SettingsViewProps {
  currentUserRole: UserRole;
  onCompanyUpdated: () => void;
  initialOAuthNotice?: { kind: 'success' | 'error'; text: string } | null;
}

const CONNECTION_BADGE_STYLES: Record<SheetsConnectionStatus, string> = {
  'Ligado': 'bg-emerald-50 text-emerald-800 border-emerald-200',
  'Não configurado': 'bg-slate-100 text-slate-700 border-slate-200',
  'A aguardar autorização': 'bg-amber-50 text-amber-800 border-amber-200',
  'Erro de autenticação': 'bg-red-50 text-red-800 border-red-200',
  'Sem acesso à folha': 'bg-red-50 text-red-800 border-red-200',
  'Estrutura inválida': 'bg-amber-50 text-amber-800 border-amber-200',
  'Ligação expirada': 'bg-red-50 text-red-800 border-red-200',
};

export const SettingsView: React.FC<SettingsViewProps> = ({
  currentUserRole,
  onCompanyUpdated,
  initialOAuthNotice,
}) => {
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
  const [dbMode, setDbMode] = useState('Google Sheets Multi-Tenant por Empresa');
  const [sheetsConfig, setSheetsConfig] = useState<TenantSheetsConfig | null>(null);

  const [name, setName] = useState('');
  const [nif, setNif] = useState('');
  const [sector, setSector] = useState('');
  const [saving, setSaving] = useState(false);

  const [googleEmailInput, setGoogleEmailInput] = useState('');
  const [spreadsheetInput, setSpreadsheetInput] = useState('');
  const [initializeMissingOnSelect, setInitializeMissingOnSelect] = useState(true);

  const [showPickerModal, setShowPickerModal] = useState(false);
  const [availableSheets, setAvailableSheets] = useState<SpreadsheetListItem[]>([]);
  const [loadingSheetsList, setLoadingSheetsList] = useState(false);

  const [testSteps, setTestSteps] = useState<SheetsTestStepResult[] | null>(null);
  const [sheetsBusy, setSheetsBusy] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);

  const [message, setMessage] = useState<string | null>(
    initialOAuthNotice?.kind === 'success' ? initialOAuthNotice.text : null
  );
  const [error, setError] = useState<string | null>(
    initialOAuthNotice?.kind === 'error' ? initialOAuthNotice.text : null
  );

  const canEditCompany = currentUserRole === 'OWNER';
  const canManageDatabase = currentUserRole === 'OWNER' || currentUserRole === 'ADMIN';

  async function loadSettings() {
    const [compRes, sysRes, sheetsRes] = await Promise.all([
      apiFetch<{ company: Company; plans: typeof plans }>('/api/company'),
      apiFetch<{ database_mode: string }>('/api/system/status'),
      apiFetch<{ config: TenantSheetsConfig }>('/api/company/sheets/config'),
    ]);
    setCompany(compRes.company);
    setPlans(compRes.plans);
    setName(compRes.company.name);
    setNif(compRes.company.nif || '');
    setSector(compRes.company.sector || '');
    setDbMode(sysRes.database_mode);
    setSheetsConfig(sheetsRes.config);
    setGoogleEmailInput(sheetsRes.config.entered_google_email || '');
  }

  useEffect(() => {
    loadSettings().catch((err) => {
      setError(err instanceof Error ? err.message : 'Erro ao carregar definições.');
    });
  }, []);

  async function handleSaveGoogleEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setSheetsBusy(true);
    try {
      const res = await apiFetch<{ config: TenantSheetsConfig }>('/api/company/sheets/email', {
        method: 'PUT',
        body: JSON.stringify({ entered_google_email: googleEmailInput.trim() }),
      });
      setSheetsConfig(res.config);
      setMessage('Email Google empresarial guardado. Inicie ou valide a ligação Google abaixo.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao guardar email Google.');
    } finally {
      setSheetsBusy(false);
    }
  }

  async function handleConnectGoogleAccount() {
    setError(null);
    setMessage(null);
    setTestSteps(null);
    setSheetsBusy(true);
    try {
      const startParams = googleEmailInput.trim()
        ? `?email=${encodeURIComponent(googleEmailInput.trim())}`
        : '';
      const startRes = await apiFetch<{
        mode: 'authorization_code_pkce' | 'workspace_popup_bridge';
        authUrl?: string;
        state: string;
      }>(`/api/company/sheets/oauth/start${startParams}`);

      if (startRes.mode === 'authorization_code_pkce' && startRes.authUrl) {
        window.location.assign(startRes.authUrl);
        return;
      }

      // Modo ponte popup Workspace: obter token transitório, enviar para cofre encriptado no servidor e limpar de imediato da memória
      const authResult = await requestGoogleWorkspaceAccessToken(googleEmailInput.trim() || undefined);
      if (!authResult?.accessToken) {
        throw new Error('Autenticação Google cancelada ou sem token de acesso.');
      }

      const tokenToSend = authResult.accessToken;
      clearGoogleAccessTokenFromMemory();

      const bridgeRes = await apiFetch<{
        verified_email: string;
        email_mismatch_warning: boolean;
        config: TenantSheetsConfig;
      }>('/api/company/sheets/oauth/bridge', {
        method: 'POST',
        body: JSON.stringify({
          state: startRes.state,
          access_token: tokenToSend,
          entered_google_email: googleEmailInput.trim() || undefined,
        }),
      });

      setSheetsConfig(bridgeRes.config);
      setMessage(
        bridgeRes.email_mismatch_warning
          ? `Conta Google autorizada (${bridgeRes.verified_email}), mas difere do email indicado (${googleEmailInput.trim()}). Confirme abaixo se pretende utilizá-la.`
          : `Conta Google autorizada com sucesso (${bridgeRes.verified_email}). Token armazenado de forma encriptada no servidor.`
      );
      onCompanyUpdated();
    } catch (err) {
      clearGoogleAccessTokenFromMemory();
      setError(err instanceof Error ? err.message : 'Falha na ligação à conta Google.');
    } finally {
      setSheetsBusy(false);
    }
  }

  async function handleConfirmMismatch() {
    setError(null);
    setMessage(null);
    setSheetsBusy(true);
    try {
      const res = await apiFetch<{ config: TenantSheetsConfig }>('/api/company/sheets/oauth/confirm-mismatch', {
        method: 'POST',
      });
      setSheetsConfig(res.config);
      setGoogleEmailInput(res.config.entered_google_email);
      setMessage(`Conta Google ${res.config.verified_google_email} confirmada para esta empresa.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao confirmar conta Google.');
    } finally {
      setSheetsBusy(false);
    }
  }

  async function handleOpenPicker() {
    setError(null);
    setShowPickerModal(true);
    setLoadingSheetsList(true);
    try {
      const res = await apiFetch<{ spreadsheets: SpreadsheetListItem[] }>('/api/company/sheets/list');
      setAvailableSheets(res.spreadsheets);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao listar folhas de cálculo do Google Drive.');
    } finally {
      setLoadingSheetsList(false);
    }
  }

  async function handleSelectSpreadsheet(inputValue: string) {
    if (!inputValue.trim()) {
      setError('Indique o ID ou URL de uma Folha de Cálculo Google.');
      return;
    }
    setError(null);
    setMessage(null);
    setSheetsBusy(true);
    try {
      const res = await apiFetch<{
        config: TenantSheetsConfig;
        schema_report: { valid: boolean; missingWorksheets: string[] };
      }>('/api/company/sheets/select', {
        method: 'POST',
        body: JSON.stringify({
          spreadsheet_input: inputValue.trim(),
          initialize_missing: initializeMissingOnSelect,
        }),
      });
      setSheetsConfig(res.config);
      setShowPickerModal(false);
      setSpreadsheetInput('');
      setMessage(
        res.schema_report.valid
          ? `Folha de cálculo "${res.config.spreadsheet_name}" ligada e validada como base de dados da empresa.`
          : `Folha selecionada, mas faltam abas do esquema MANDATO (${res.schema_report.missingWorksheets.join(', ')}).`
      );
      onCompanyUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao associar folha de cálculo.');
    } finally {
      setSheetsBusy(false);
    }
  }

  async function handleTestConnection() {
    setError(null);
    setMessage(null);
    setSheetsBusy(true);
    try {
      const res = await apiFetch<{
        ok: boolean;
        steps: SheetsTestStepResult[];
        config: TenantSheetsConfig;
      }>('/api/company/sheets/test', { method: 'POST' });
      setSheetsConfig(res.config);
      setTestSteps(res.steps);
      if (res.ok) {
        setMessage('Teste de ligação concluído com sucesso (leitura e escrita verificadas).');
      } else {
        setError('O teste de ligação detetou problemas. Consulte os passos abaixo.');
      }
      onCompanyUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao testar ligação Google Sheets.');
    } finally {
      setSheetsBusy(false);
    }
  }

  async function executeConfirmedDialogAction() {
    if (!confirmDialog) return;
    setError(null);
    setMessage(null);
    setSheetsBusy(true);
    try {
      if (confirmDialog.type === 'create') {
        const res = await apiFetch<{ config: TenantSheetsConfig; spreadsheet: { title: string } }>(
          '/api/company/sheets/create',
          { method: 'POST', body: JSON.stringify({}) }
        );
        setSheetsConfig(res.config);
        setMessage(
          `Folha de cálculo "${res.spreadsheet.title}" criada com 20 abas estruturadas e ativada como base de dados da empresa.`
        );
      } else if (confirmDialog.type === 'initialize') {
        const res = await apiFetch<{
          config: TenantSheetsConfig;
          created_tabs: string[];
          schema_report: { valid: boolean };
        }>('/api/company/sheets/initialize-schema', { method: 'POST' });
        setSheetsConfig(res.config);
        setMessage(
          res.created_tabs.length > 0
            ? `Esquema inicializado: ${res.created_tabs.length} abas criadas/validadas.`
            : 'Estrutura das 20 abas validada com sucesso.'
        );
      } else if (confirmDialog.type === 'disconnect') {
        const res = await apiFetch<{ config: TenantSheetsConfig }>('/api/company/sheets/disconnect', {
          method: 'POST',
        });
        await signOutGoogleDrive();
        setSheetsConfig(res.config);
        setTestSteps(null);
        setMessage('Conta Google desligada e tokens revogados no servidor.');
      }
      setConfirmDialog(null);
      onCompanyUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro na operação Google Sheets.');
    } finally {
      setSheetsBusy(false);
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

  const hasOAuthCredentials = Boolean(sheetsConfig?.verified_google_email);
  const hasSpreadsheet = Boolean(sheetsConfig?.spreadsheet_id);
  const statusBadgeClass =
    CONNECTION_BADGE_STYLES[sheetsConfig?.connection_status || 'Não configurado'];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
          Definições e Base de Dados da Empresa
        </h1>
        <p className="text-xs text-slate-500 mt-1">
          Configure a conta Google e a Folha de Cálculo Google dedicada da empresa, dados fiscais e plano SaaS.
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

      {/* SECÇÃO PRINCIPAL: Base de Dados da Empresa -> Google Sheets */}
      <section
        aria-labelledby="sheets-db-heading"
        className="bg-white border border-slate-200 rounded-xl p-6 space-y-5 text-xs"
      >
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 border-b border-slate-100 pb-4">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-slate-900 flex items-center justify-center shrink-0">
              <Database className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <h2 id="sheets-db-heading" className="font-display text-base font-semibold text-slate-900">
                Base de Dados da Empresa → Google Sheets
              </h2>
              <p className="text-xs text-slate-500 mt-0.5 max-w-2xl">
                Cada empresa utiliza a sua própria conta Google e a sua própria Folha de Cálculo Google com 20 abas estruturadas para guardar todos os agentes, políticas, aprovações, fluxos e auditoria.
              </p>
            </div>
          </div>

          {sheetsConfig && (
            <span
              data-testid="sheets-connection-status"
              className={`inline-flex items-center px-2.5 py-1 rounded-md border text-xs font-semibold shrink-0 self-start ${statusBadgeClass}`}
            >
              {sheetsConfig.connection_status}
            </span>
          )}
        </div>

        {/* Metadados Atuais de Ligação */}
        {sheetsConfig && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 p-4 rounded-lg bg-slate-50 border border-slate-200">
            <div>
              <p className="text-[11px] font-medium text-slate-500 uppercase">Conta Google Verificada</p>
              <p className="mt-1 font-mono text-slate-900 truncate">
                {sheetsConfig.verified_google_email || 'Não autenticada'}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-slate-500 uppercase">Folha de Cálculo Ativa</p>
              {sheetsConfig.spreadsheet_id ? (
                <a
                  href={sheetsConfig.spreadsheet_url || `https://docs.google.com/spreadsheets/d/${sheetsConfig.spreadsheet_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 font-medium text-slate-900 hover:underline truncate max-w-full"
                >
                  <span className="truncate">{sheetsConfig.spreadsheet_name || sheetsConfig.spreadsheet_id}</span>
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              ) : (
                <p className="mt-1 text-slate-500">Nenhuma folha associada</p>
              )}
            </div>
            <div>
              <p className="text-[11px] font-medium text-slate-500 uppercase">Último Teste</p>
              <p className="mt-1 font-mono text-slate-700">
                {sheetsConfig.last_connection_test ? formatDateTimePT(sheetsConfig.last_connection_test) : 'Nunca testado'}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-slate-500 uppercase">Última Escrita</p>
              <p className="mt-1 font-mono text-slate-700">
                {sheetsConfig.last_successful_write ? formatDateTimePT(sheetsConfig.last_successful_write) : 'Sem escritas'}
              </p>
            </div>
          </div>
        )}

        {/* Aviso de Divergência de Email */}
        {sheetsConfig?.email_mismatch_warning && (
          <div className="p-4 rounded-lg bg-amber-50 border border-amber-300 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
              <div className="text-amber-950">
                <p className="font-semibold">Divergência entre email indicado e conta autorizada</p>
                <p className="mt-0.5">
                  Indicou <span className="font-mono">{sheetsConfig.entered_google_email}</span>, mas autorizou com{' '}
                  <span className="font-mono">{sheetsConfig.verified_google_email}</span>. Confirme se pretende usar a conta autorizada ou volte a ligar com a conta pretendida.
                </p>
              </div>
            </div>
            {canManageDatabase && (
              <button
                type="button"
                disabled={sheetsBusy}
                onClick={handleConfirmMismatch}
                className="px-3 py-1.5 bg-amber-700 text-white rounded-lg font-medium hover:bg-amber-800 shrink-0"
              >
                Confirmar utilização desta conta
              </button>
            )}
          </div>
        )}

        {/* Último erro / abas em falta */}
        {sheetsConfig?.last_error && (
          <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-red-900 space-y-1">
            <p className="font-semibold">Diagnóstico da ligação:</p>
            <p>{sheetsConfig.last_error}</p>
            {sheetsConfig.missing_worksheets.length > 0 && (
              <p className="font-mono text-[11px]">
                Abas em falta: {sheetsConfig.missing_worksheets.join(', ')}
              </p>
            )}
          </div>
        )}

        {!canManageDatabase ? (
          <p className="text-slate-600">
            Apenas utilizadores com perfil <strong className="text-slate-900">OWNER</strong> ou{' '}
            <strong className="text-slate-900">ADMIN</strong> podem ligar ou alterar a base de dados Google Sheets da empresa.
          </p>
        ) : (
          <div className="space-y-5">
            {/* Passo 1: Conta Google / Gmail da Empresa */}
            <div className="p-4 rounded-lg border border-slate-200 space-y-3">
              <p className="font-semibold text-slate-900">
                1. Conta Google / Gmail da Empresa
              </p>
              <form onSubmit={handleSaveGoogleEmail} className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
                <div className="flex-1">
                  <label htmlFor="company-google-email" className="block text-[11px] font-medium text-slate-600 mb-1">
                    Endereço Gmail / Google Workspace da empresa
                  </label>
                  <input
                    id="company-google-email"
                    type="email"
                    value={googleEmailInput}
                    onChange={(e) => setGoogleEmailInput(e.target.value)}
                    placeholder="dados@suaempresa.pt ou empresa@gmail.com"
                    className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>
                <button
                  type="submit"
                  disabled={sheetsBusy}
                  className="px-4 py-2 bg-white border border-slate-300 text-slate-800 rounded-lg font-medium hover:bg-slate-50 whitespace-nowrap"
                >
                  Guardar Email
                </button>
                <GoogleSignInButton
                  onClick={handleConnectGoogleAccount}
                  disabled={sheetsBusy}
                  label={hasOAuthCredentials ? 'Reconectar conta Google' : 'Ligar conta Google'}
                />
              </form>
              <p className="text-[11px] text-slate-500">
                Modo OAuth ativo no servidor:{' '}
                <span className="font-mono text-slate-700">
                  {sheetsConfig?.oauth_code_flow_configured
                    ? 'OAuth 2.0 Authorization Code + PKCE (refresh_token persistente)'
                    : 'Google Workspace OAuth Bridge (tokens armazenados encriptados no servidor)'}
                </span>
              </p>
            </div>

            {/* Passo 2: Folha de Cálculo da Empresa */}
            <div className="p-4 rounded-lg border border-slate-200 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-slate-900">
                    2. Folha de Cálculo Google da Empresa
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Crie uma nova folha estruturada ou associe uma Folha de Cálculo Google existente através do seletor ou por ID/URL.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!hasOAuthCredentials || sheetsBusy}
                    onClick={handleOpenPicker}
                    className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-300 text-slate-800 rounded-lg font-medium hover:bg-slate-50 disabled:opacity-50"
                  >
                    <FolderSearch className="w-3.5 h-3.5" />
                    <span>Selecionar folha de cálculo</span>
                  </button>

                  <button
                    type="button"
                    disabled={!hasOAuthCredentials || sheetsBusy}
                    onClick={() =>
                      setConfirmDialog({
                        type: 'create',
                        title: `Criar nova Folha de Cálculo "MANDATO — ${company.name}"?`,
                        description: `Será criada uma nova Folha de Cálculo na conta Google ${sheetsConfig?.verified_google_email} com as 20 abas operacionais MANDATO (CompanySettings, Users, Agents, Policies, Workflows, AuditLogs, etc.) e associada como base de dados exclusiva desta empresa.`,
                        confirmLabel: 'Confirmar Criação da Folha',
                      })
                    }
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800 disabled:opacity-50"
                  >
                    <PlusCircle className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Criar nova folha de cálculo</span>
                  </button>
                </div>
              </div>

              {/* Associação direta por URL ou ID */}
              <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end pt-2 border-t border-slate-100">
                <div className="flex-1">
                  <label htmlFor="spreadsheet-url-input" className="block text-[11px] font-medium text-slate-600 mb-1">
                    Associar folha existente por URL ou ID do Google Sheets
                  </label>
                  <input
                    id="spreadsheet-url-input"
                    type="text"
                    value={spreadsheetInput}
                    onChange={(e) => setSpreadsheetInput(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/d/... ou ID da folha"
                    className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>
                <label className="inline-flex items-center gap-2 text-slate-700 pb-2">
                  <input
                    type="checkbox"
                    checked={initializeMissingOnSelect}
                    onChange={(e) => setInitializeMissingOnSelect(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  <span>Criar abas em falta automaticamente</span>
                </label>
                <button
                  type="button"
                  disabled={!hasOAuthCredentials || !spreadsheetInput.trim() || sheetsBusy}
                  onClick={() => handleSelectSpreadsheet(spreadsheetInput)}
                  className="px-4 py-2 bg-emerald-700 text-white rounded-lg font-medium hover:bg-emerald-800 disabled:opacity-50 whitespace-nowrap"
                >
                  Associar Folha
                </button>
              </div>
            </div>

            {/* Passo 3: Testar, Inicializar Estrutura e Desligar */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!hasOAuthCredentials || !hasSpreadsheet || sheetsBusy}
                  onClick={handleTestConnection}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-white border border-slate-300 text-slate-800 rounded-lg font-medium hover:bg-slate-50 disabled:opacity-50"
                >
                  <Activity className="w-3.5 h-3.5 text-emerald-700" />
                  <span>Testar ligação</span>
                </button>

                <button
                  type="button"
                  disabled={!hasOAuthCredentials || !hasSpreadsheet || sheetsBusy}
                  onClick={() =>
                    setConfirmDialog({
                      type: 'initialize',
                      title: 'Validar e inicializar estrutura MANDATO na folha?',
                      description:
                        'O sistema irá verificar as 20 abas obrigatórias e criar apenas as abas ou cabeçalhos em falta, sem apagar dados existentes.',
                      confirmLabel: 'Confirmar Inicialização',
                    })
                  }
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-white border border-slate-300 text-slate-800 rounded-lg font-medium hover:bg-slate-50 disabled:opacity-50"
                >
                  <Wrench className="w-3.5 h-3.5 text-slate-700" />
                  <span>Validar / Inicializar estrutura</span>
                </button>

                <button
                  type="button"
                  disabled={sheetsBusy}
                  onClick={() => loadSettings()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-slate-600 hover:text-slate-900"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${sheetsBusy ? 'animate-spin' : ''}`} />
                  <span>Atualizar estado</span>
                </button>
              </div>

              {hasOAuthCredentials && (
                <button
                  type="button"
                  disabled={sheetsBusy}
                  onClick={() =>
                    setConfirmDialog({
                      type: 'disconnect',
                      title: 'Desligar conta Google e revogar tokens?',
                      description:
                        'Os tokens encriptados guardados no servidor serão eliminados e revogados junto da Google. A empresa ficará com a base de dados desligada até nova autorização, sem perda dos dados na sua Folha de Cálculo Google.',
                      confirmLabel: 'Confirmar Desligamento',
                      danger: true,
                    })
                  }
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-red-50 border border-red-200 text-red-700 rounded-lg font-medium hover:bg-red-100 disabled:opacity-50"
                >
                  <Unplug className="w-3.5 h-3.5" />
                  <span>Desligar conta Google</span>
                </button>
              )}
            </div>

            {/* Resultados Passo-a-Passo do Teste de Ligação */}
            {testSteps && (
              <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
                <p className="font-semibold text-slate-900">Resultado do Diagnóstico (7 Verificações):</p>
                <div className="space-y-1.5">
                  {testSteps.map((s, idx) => (
                    <div key={idx} className="flex items-start gap-2">
                      {s.ok ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700 mt-0.5 shrink-0" />
                      ) : (
                        <AlertTriangle className="w-3.5 h-3.5 text-red-700 mt-0.5 shrink-0" />
                      )}
                      <div>
                        <span className="font-semibold text-slate-900">{s.step}:</span>{' '}
                        <span className="text-slate-600">{s.detail}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Dados Fiscais da Empresa */}
      <form onSubmit={handleSaveCompany} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 text-xs">
        <h2 className="font-display text-base font-semibold text-slate-900">Perfil da Empresa</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label htmlFor="company-name-input" className="block font-medium text-slate-700 mb-1">
              Denominação Social
            </label>
            <input
              id="company-name-input"
              type="text"
              disabled={!canEditCompany}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg disabled:bg-slate-50"
            />
          </div>
          <div>
            <label htmlFor="company-nif-input" className="block font-medium text-slate-700 mb-1">
              NIF
            </label>
            <input
              id="company-nif-input"
              type="text"
              disabled={!canEditCompany}
              value={nif}
              onChange={(e) => setNif(e.target.value)}
              className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg disabled:bg-slate-50"
            />
          </div>
          <div>
            <label htmlFor="company-sector-input" className="block font-medium text-slate-700 mb-1">
              Setor de Atividade
            </label>
            <input
              id="company-sector-input"
              type="text"
              disabled={!canEditCompany}
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg disabled:bg-slate-50"
            />
          </div>
        </div>
        {canEditCompany && (
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

                {canEditCompany && (
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

      {/* Arquitetura Multi-Tenant */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-2 text-xs">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-slate-700" />
          <h2 className="font-display text-base font-semibold text-slate-900">
            Arquitetura de Persistência Multi-Tenant
          </h2>
        </div>
        <p className="text-slate-700">
          Modo ativo neste servidor: <strong className="font-mono">{dbMode}</strong>
        </p>
        <p className="text-slate-500">
          O plano de controlo central gere apenas sessões, membros, roteamento de credenciais por hash e metadados da ligação. Os dados operacionais de negócio permanecem isolados exclusivamente na Folha de Cálculo Google de cada empresa.
        </p>
      </div>

      {/* Modal Seletor de Folha de Cálculo no Google Drive */}
      {showPickerModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="sheets-picker-title"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-xl max-w-xl w-full p-6 space-y-4 shadow-xl text-xs">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 id="sheets-picker-title" className="font-display text-base font-semibold text-slate-900">
                Selecionar Folha de Cálculo Google
              </h3>
              <button
                type="button"
                aria-label="Fechar seletor de folhas"
                onClick={() => setShowPickerModal(false)}
                className="p-1 text-slate-500 hover:text-slate-900 rounded-md"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {loadingSheetsList ? (
              <div className="h-32 flex items-center justify-center text-slate-500">
                A listar folhas de cálculo da conta Google...
              </div>
            ) : availableSheets.length === 0 ? (
              <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 text-slate-600 space-y-1">
                <p className="font-semibold text-slate-900">Nenhuma folha encontrada na listagem direta.</p>
                <p>
                  Se a autorização atual usar o âmbito restrito <span className="font-mono">drive.file</span>, pode criar uma nova folha com o botão «Criar nova folha de cálculo» ou colar o URL da folha pretendida no campo abaixo.
                </p>
              </div>
            ) : (
              <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-lg">
                {availableSheets.map((item) => (
                  <div key={item.id} className="p-3 flex items-center justify-between gap-3 hover:bg-slate-50">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900 truncate">{item.name}</p>
                      <p className="text-[11px] font-mono text-slate-500 truncate">
                        ID: {item.id} · Modificada: {formatDateTimePT(item.modifiedTime)}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={sheetsBusy}
                      onClick={() => handleSelectSpreadsheet(item.id)}
                      className="px-3 py-1.5 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800 shrink-0"
                    >
                      Selecionar
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setShowPickerModal(false)}
                className="px-4 py-2 bg-slate-100 text-slate-700 rounded-lg font-medium hover:bg-slate-200"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Confirmação Explícita */}
      {confirmDialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="sheets-confirm-title"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-start gap-3">
              <AlertTriangle
                className={`w-5 h-5 mt-0.5 shrink-0 ${
                  confirmDialog.danger ? 'text-red-600' : 'text-amber-600'
                }`}
              />
              <div>
                <h3 id="sheets-confirm-title" className="font-display text-base font-semibold text-slate-900">
                  {confirmDialog.title}
                </h3>
                <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
                  {confirmDialog.description}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={sheetsBusy}
                onClick={() => setConfirmDialog(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={sheetsBusy}
                onClick={executeConfirmedDialogAction}
                className={`px-4 py-2 text-xs font-medium text-white rounded-lg disabled:opacity-50 ${
                  confirmDialog.danger
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-slate-900 hover:bg-slate-800'
                }`}
              >
                {sheetsBusy ? 'A executar...' : confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
