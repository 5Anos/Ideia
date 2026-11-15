import React, { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { formatDatePT, ROLE_LABELS } from '../utils/formatters';
import type { CompanyMember, UserRole } from '../shared/types';

interface UsersViewProps {
  currentUserRole: UserRole;
}

export const UsersView: React.FC<UsersViewProps> = ({ currentUserRole }) => {
  const [members, setMembers] = useState<CompanyMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [role, setRole] = useState<UserRole>('OPERATOR');

  const canManageUsers = currentUserRole === 'OWNER';

  async function loadMembers() {
    setLoading(true);
    try {
      const res = await apiFetch<{ members: CompanyMember[] }>('/api/users');
      setMembers(res.members);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar utilizadores.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMembers();
  }, []);

  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify({ full_name: fullName, email, job_title: jobTitle, role }),
      });
      setShowInvite(false);
      setFullName('');
      setEmail('');
      setJobTitle('');
      await loadMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao adicionar utilizador.');
    }
  }

  async function handleChangeRole(memberId: string, newRole: UserRole) {
    setError(null);
    try {
      await apiFetch(`/api/users/${memberId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      });
      await loadMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao alterar perfil.');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Utilizadores e Perfis RBAC
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Gestão de acessos da empresa com validação rigorosa no servidor (OWNER, ADMIN, APPROVER, OPERATOR, VIEWER).
          </p>
        </div>

        {canManageUsers && (
          <button
            type="button"
            onClick={() => setShowInvite((s) => !s)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap self-start"
          >
            <UserPlus className="w-3.5 h-3.5" />
            <span>Adicionar Utilizador</span>
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
          {error}
        </div>
      )}

      {showInvite && canManageUsers && (
        <form onSubmit={handleAddMember} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 text-xs">
          <h2 className="font-display text-base font-semibold text-slate-900">Novo Membro da Empresa</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Nome completo *"
              className="px-3 py-2 border border-slate-300 rounded-lg"
            />
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email profissional *"
              className="px-3 py-2 border border-slate-300 rounded-lg"
            />
            <input
              type="text"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="Cargo"
              className="px-3 py-2 border border-slate-300 rounded-lg"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="px-3 py-2 border border-slate-300 rounded-lg bg-white"
            >
              <option value="ADMIN">Administrador (ADMIN)</option>
              <option value="APPROVER">Aprovador (APPROVER)</option>
              <option value="OPERATOR">Operador (OPERATOR)</option>
              <option value="VIEWER">Leitura (VIEWER)</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowInvite(false)} className="px-3.5 py-2 border border-slate-300 rounded-lg">
              Cancelar
            </button>
            <button type="submit" className="px-4 py-2 bg-slate-900 text-white rounded-lg font-medium">
              Guardar Utilizador
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl h-56 animate-pulse" />
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 bg-slate-50/70">
                <th className="py-3 px-4">Utilizador</th>
                <th className="py-3 px-3">Cargo</th>
                <th className="py-3 px-3">Perfil RBAC</th>
                <th className="py-3 px-3">Estado</th>
                <th className="py-3 px-4 text-right">Registado em</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {members.map((m) => (
                <tr key={m.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4">
                    <p className="font-semibold text-slate-900">{m.full_name}</p>
                    <p className="font-mono text-[11px] text-slate-500">{m.email}</p>
                  </td>
                  <td className="py-3 px-3 text-slate-600">{m.job_title || '—'}</td>
                  <td className="py-3 px-3">
                    {canManageUsers ? (
                      <select
                        aria-label={`Perfil de ${m.full_name}`}
                        value={m.role}
                        onChange={(e) => handleChangeRole(m.id, e.target.value as UserRole)}
                        className="px-2.5 py-1 border border-slate-300 rounded-md bg-white text-xs"
                      >
                        <option value="OWNER">OWNER</option>
                        <option value="ADMIN">ADMIN</option>
                        <option value="APPROVER">APPROVER</option>
                        <option value="OPERATOR">OPERATOR</option>
                        <option value="VIEWER">VIEWER</option>
                      </select>
                    ) : (
                      <span className="font-medium text-slate-800">{ROLE_LABELS[m.role] || m.role}</span>
                    )}
                  </td>
                  <td className="py-3 px-3 text-emerald-700 font-medium">
                    {m.status === 'active' ? 'Ativo' : m.status}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-500">
                    {formatDatePT(m.created_at)}
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
