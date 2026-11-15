import React, { useEffect, useState } from 'react';
import { Menu } from 'lucide-react';
import { apiFetch, getStoredToken, setStoredToken } from './utils/api';
import { AuthScreen } from './components/AuthScreen';
import { Sidebar, type NavSectionId } from './components/Sidebar';
import { DashboardView } from './components/DashboardView';
import { AgentWizardView } from './components/AgentWizardView';
import { MyAgentsView } from './components/MyAgentsView';
import { TemplatesView } from './components/TemplatesView';
import { TestAgentView } from './components/TestAgentView';
import { WorkflowsView } from './components/WorkflowsView';
import { IntegrationsView } from './components/IntegrationsView';
import { PoliciesView } from './components/PoliciesView';
import { ApprovalsView } from './components/ApprovalsView';
import { AuditLogsView } from './components/AuditLogsView';
import { UsersView } from './components/UsersView';
import { SettingsView } from './components/SettingsView';
import { PlatformAdminView } from './components/PlatformAdminView';
import type { AgentTemplate, UserSession } from './shared/types';

const SECTION_BREADCRUMBS: Record<NavSectionId, { group: string; title: string }> = {
  overview: { group: 'Início', title: 'Visão Geral' },
  'create-agent': { group: 'Fábrica de Agentes', title: 'Criar Agente' },
  'my-agents': { group: 'Fábrica de Agentes', title: 'Os Meus Agentes' },
  templates: { group: 'Fábrica de Agentes', title: 'Modelos de Agentes' },
  'test-agents': { group: 'Fábrica de Agentes', title: 'Testar Agentes' },
  workflows: { group: 'Automação', title: 'Fluxos de Trabalho' },
  integrations: { group: 'Automação', title: 'Integrações' },
  policies: { group: 'Governação e Segurança', title: 'Políticas e Permissões' },
  approvals: { group: 'Governação e Segurança', title: 'Pedidos de Aprovação' },
  audit: { group: 'Governação e Segurança', title: 'Histórico e Auditoria' },
  users: { group: 'Administração', title: 'Utilizadores' },
  settings: { group: 'Administração', title: 'Definições' },
  'platform-admin': { group: 'Administração', title: 'Administração da Plataforma' },
};

export default function App() {
  const [user, setUser] = useState<UserSession | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [activeNav, setActiveNav] = useState<NavSectionId>('overview');
  const [pendingApprovalsCount, setPendingApprovalsCount] = useState(0);
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplate | null>(null);
  const [preselectedTestAgentId, setPreselectedTestAgentId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [oauthNotice, setOauthNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  async function refreshDashboardCount() {
    try {
      const dashRes = await apiFetch<{ kpis: { pending_approvals: number } }>('/api/dashboard');
      setPendingApprovalsCount(dashRes.kpis.pending_approvals);
    } catch {
      // Quando a base de dados Google Sheets ainda não está ligada, /api/dashboard devolve 503 DATABASE_NOT_CONNECTED
      setPendingApprovalsCount(0);
    }
  }

  async function refreshUserAndCounts() {
    try {
      const meRes = await apiFetch<{ user: UserSession }>('/api/auth/me');
      setUser(meRes.user);
      await refreshDashboardCount();
    } catch {
      setStoredToken(null);
      setUser(null);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const autostart = params.get('autostart') === '1';
    const oauthState = params.get('sheets_oauth');
    if (oauthState === 'success') {
      const email = params.get('verified_email') || '';
      const mismatch = params.get('mismatch') === '1';
      setOauthNotice({
        kind: 'success',
        text: mismatch
          ? `Conta Google autorizada (${email}), mas difere do email indicado. Confirme ou selecione a folha de cálculo abaixo.`
          : `Conta Google autorizada (${email}). Selecione ou crie agora a Folha de Cálculo Google da empresa.`,
      });
      setActiveNav('settings');
      window.history.replaceState({}, '', '/');
    } else if (oauthState === 'error') {
      setOauthNotice({
        kind: 'error',
        text: params.get('reason') || 'Falha na autorização Google OAuth.',
      });
      setActiveNav('settings');
      window.history.replaceState({}, '', '/');
    }

    const existingToken = getStoredToken();
    if (existingToken) {
      refreshUserAndCounts().finally(() => setCheckingSession(false));
    } else if (autostart) {
      apiFetch<{ token: string; user: UserSession }>('/api/auth/demo-login', {
        method: 'POST',
        body: JSON.stringify({ role: 'OWNER' }),
      })
        .then(async (res) => {
          setStoredToken(res.token);
          setUser(res.user);
          await refreshDashboardCount();
        })
        .catch(() => {
          setStoredToken(null);
        })
        .finally(() => setCheckingSession(false));
    } else {
      setCheckingSession(false);
    }
  }, []);

  function handleLogout() {
    setStoredToken(null);
    setUser(null);
    setActiveNav('overview');
  }

  if (checkingSession) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <p className="text-xs font-medium text-slate-600">A validar sessão MANDATO...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        onAuthenticated={async (authenticatedUser) => {
          setUser(authenticatedUser);
          await refreshDashboardCount();
        }}
      />
    );
  }

  const crumb = SECTION_BREADCRUMBS[activeNav];
  const goToSettings = () => setActiveNav('settings');

  return (
    <div className="min-h-screen bg-slate-50 flex">
      <Sidebar
        activeNav={activeNav}
        onNavigate={(id) => {
          if (id === 'create-agent') setSelectedTemplate(null);
          setActiveNav(id);
        }}
        user={user}
        pendingApprovalsCount={pendingApprovalsCount}
        onLogout={handleLogout}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Barra Superior Limpa */}
        <header className="bg-white border-b border-slate-200 px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Abrir menu lateral"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 rounded-md text-slate-600 hover:bg-slate-100"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-xs text-slate-500 min-w-0">
              <span className="hidden sm:inline whitespace-nowrap">{crumb.group}</span>
              <span className="hidden sm:inline" aria-hidden="true">/</span>
              <span className="font-semibold text-slate-900 truncate">{crumb.title}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setActiveNav('approvals')}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap"
            >
              Aprovações ({pendingApprovalsCount})
            </button>
          </div>
        </header>

        {/* Conteúdo Principal */}
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 max-w-7xl w-full mx-auto">
          {activeNav === 'overview' && (
            <DashboardView isDemoCompany={user.is_demo_company} onNavigate={setActiveNav} />
          )}

          {activeNav === 'create-agent' && (
            <AgentWizardView
              initialTemplate={selectedTemplate}
              onAgentCreated={() => {
                setSelectedTemplate(null);
                setActiveNav('my-agents');
              }}
              onNavigateSettings={goToSettings}
            />
          )}

          {activeNav === 'my-agents' && (
            <MyAgentsView
              onTestAgent={(agentId) => {
                setPreselectedTestAgentId(agentId);
                setActiveNav('test-agents');
              }}
              onGoToWizard={() => {
                setSelectedTemplate(null);
                setActiveNav('create-agent');
              }}
              onNavigateSettings={goToSettings}
            />
          )}

          {activeNav === 'templates' && (
            <TemplatesView
              onSelectTemplate={(tpl) => {
                setSelectedTemplate(tpl);
                setActiveNav('create-agent');
              }}
            />
          )}

          {activeNav === 'test-agents' && (
            <TestAgentView
              preselectedAgentId={preselectedTestAgentId}
              onNavigateSettings={goToSettings}
            />
          )}

          {activeNav === 'workflows' && <WorkflowsView onNavigateSettings={goToSettings} />}

          {activeNav === 'integrations' && <IntegrationsView onNavigateSettings={goToSettings} />}

          {activeNav === 'policies' && <PoliciesView onNavigateSettings={goToSettings} />}

          {activeNav === 'approvals' && (
            <ApprovalsView
              onApprovalsUpdated={refreshDashboardCount}
              onNavigateSettings={goToSettings}
            />
          )}

          {activeNav === 'audit' && <AuditLogsView onNavigateSettings={goToSettings} />}

          {activeNav === 'users' && <UsersView currentUserRole={user.role} />}

          {activeNav === 'settings' && (
            <SettingsView
              currentUserRole={user.role}
              initialOAuthNotice={oauthNotice}
              onCompanyUpdated={() => {
                refreshUserAndCounts();
              }}
            />
          )}

          {activeNav === 'platform-admin' && user.is_platform_admin && <PlatformAdminView />}
        </main>
      </div>
    </div>
  );
}
