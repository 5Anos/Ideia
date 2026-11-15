import React, { useState } from 'react';
import {
  LayoutDashboard,
  PlusCircle,
  Bot,
  Layers,
  TerminalSquare,
  GitBranch,
  Plug,
  ShieldAlert,
  CheckSquare,
  FileSearch,
  Users,
  Settings,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
  LogOut,
  X,
} from 'lucide-react';
import type { UserSession } from '../shared/types';
import { ROLE_LABELS } from '../utils/formatters';

export type NavSectionId =
  | 'overview'
  | 'create-agent'
  | 'my-agents'
  | 'templates'
  | 'test-agents'
  | 'workflows'
  | 'integrations'
  | 'policies'
  | 'approvals'
  | 'audit'
  | 'users'
  | 'settings';

interface SidebarProps {
  activeNav: NavSectionId;
  onNavigate: (id: NavSectionId) => void;
  user: UserSession;
  pendingApprovalsCount: number;
  onLogout: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

interface NavGroup {
  id: string;
  label: string;
  items: Array<{
    id: NavSectionId;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badgeCount?: number;
  }>;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeNav,
  onNavigate,
  user,
  pendingApprovalsCount,
  onLogout,
  mobileOpen,
  onCloseMobile,
}) => {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const groups: NavGroup[] = [
    {
      id: 'inicio',
      label: 'Início',
      items: [{ id: 'overview', label: '1. Visão Geral', icon: LayoutDashboard }],
    },
    {
      id: 'fabrica',
      label: 'Fábrica de Agentes',
      items: [
        { id: 'create-agent', label: '2. Criar Agente', icon: PlusCircle },
        { id: 'my-agents', label: '3. Os Meus Agentes', icon: Bot },
        { id: 'templates', label: '4. Modelos de Agentes', icon: Layers },
        { id: 'test-agents', label: '5. Testar Agentes', icon: TerminalSquare },
      ],
    },
    {
      id: 'automacao',
      label: 'Automação',
      items: [
        { id: 'workflows', label: '6. Fluxos de Trabalho', icon: GitBranch },
        { id: 'integrations', label: '7. Integrações', icon: Plug },
      ],
    },
    {
      id: 'governacao',
      label: 'Governação e Segurança',
      items: [
        { id: 'policies', label: '8. Políticas e Permissões', icon: ShieldAlert },
        {
          id: 'approvals',
          label: '9. Pedidos de Aprovação',
          icon: CheckSquare,
          badgeCount: pendingApprovalsCount,
        },
        { id: 'audit', label: '10. Histórico e Auditoria', icon: FileSearch },
      ],
    },
    {
      id: 'administracao',
      label: 'Administração',
      items: [
        { id: 'users', label: '11. Utilizadores', icon: Users },
        { id: 'settings', label: '12. Definições', icon: Settings },
      ],
    },
  ];

  function toggleGroup(groupId: string) {
    setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  }

  const navContent = (
    <div className="flex flex-col h-full bg-white border-r border-slate-200 w-64 select-none">
      {/* Brand */}
      <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-slate-900 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
          </div>
          <span className="font-display text-base font-bold tracking-tight text-slate-900 whitespace-nowrap">
            MANDATO
          </span>
        </div>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Fechar menu"
          className="lg:hidden p-1.5 rounded-md text-slate-500 hover:bg-slate-100"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Empresa ativa */}
      <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/70">
        <p className="text-xs font-semibold text-slate-900 truncate">{user.company_name}</p>
        <p className="text-xs text-slate-500 truncate mt-0.5">
          {user.subscription_plan}
          {user.is_demo_company ? ' · Demonstração' : ''}
        </p>
      </div>

      {/* Links */}
      <nav aria-label="Navegação principal" className="flex-1 overflow-y-auto px-3 py-4 space-y-4">
        {groups.map((group) => {
          const isCollapsed = Boolean(collapsedGroups[group.id]);
          return (
            <div key={group.id}>
              <button
                type="button"
                onClick={() => toggleGroup(group.id)}
                aria-expanded={!isCollapsed}
                className="w-full flex items-center justify-between px-2 py-1 text-[11px] font-semibold tracking-wider text-slate-500 hover:text-slate-800 uppercase"
              >
                <span>{group.label}</span>
                {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>

              {!isCollapsed && (
                <div className="mt-1 space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const active = activeNav === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          onNavigate(item.id);
                          onCloseMobile();
                        }}
                        aria-current={active ? 'page' : undefined}
                        className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-xs font-medium transition-colors ${
                          active
                            ? 'bg-slate-900 text-white'
                            : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                        }`}
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
                          <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-emerald-400' : 'text-slate-500'}`} />
                          <span className="truncate whitespace-nowrap">{item.label}</span>
                        </span>
                        {typeof item.badgeCount === 'number' && item.badgeCount > 0 && (
                          <span
                            className={`tabular-nums text-[11px] font-mono font-semibold ${
                              active ? 'text-amber-300' : 'text-amber-700'
                            }`}
                          >
                            {item.badgeCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Perfil e Terminar Sessão */}
      <div className="p-4 border-t border-slate-200 bg-slate-50/50">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-900 truncate">{user.full_name}</p>
          <p className="text-[11px] text-slate-500 truncate mt-0.5">{ROLE_LABELS[user.role] || user.role}</p>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Terminar Sessão</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block shrink-0 h-screen sticky top-0">{navContent}</aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-slate-900/40" onClick={onCloseMobile} />
          <div className="relative z-10 h-full">{navContent}</div>
        </div>
      )}
    </>
  );
};
