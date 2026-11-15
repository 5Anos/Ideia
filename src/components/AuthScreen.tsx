import React, { useState } from 'react';
import { ShieldCheck, Lock, ArrowRight, KeyRound, Building2 } from 'lucide-react';
import { apiFetch, setStoredToken } from '../utils/api';
import type { UserRole, UserSession } from '../shared/types';

interface AuthScreenProps {
  onAuthenticated: (user: UserSession) => void;
}

type AuthMode = 'login' | 'register' | 'recover';

export const AuthScreen: React.FC<AuthScreenProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [nif, setNif] = useState('');
  const [recoveryToken, setRecoveryToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [recoveryStep2, setRecoveryStep2] = useState(false);

  const [demoRole, setDemoRole] = useState<UserRole>('OWNER');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: UserSession }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setStoredToken(res.token);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível iniciar sessão.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: UserSession }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          full_name: fullName,
          email,
          password,
          company_name: companyName,
          nif,
        }),
      });
      setStoredToken(res.token);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao criar conta empresarial.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRecover(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ message: string }>('/api/auth/recover', {
        method: 'POST',
        body: JSON.stringify(
          recoveryStep2
            ? { email, recovery_token: recoveryToken, new_password: newPassword }
            : { email }
        ),
      });
      setInfoMessage(res.message);
      if (!recoveryStep2) {
        setRecoveryStep2(true);
      } else {
        setRecoveryStep2(false);
        setMode('login');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao recuperar palavra-passe.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDemoLogin(role: UserRole) {
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: UserSession }>('/api/auth/demo-login', {
        method: 'POST',
        body: JSON.stringify({ role }),
      });
      setStoredToken(res.token);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao entrar na empresa de demonstração.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
        {/* Coluna Institucional */}
        <div className="lg:col-span-6 bg-slate-900 text-white rounded-xl p-8 lg:p-10 flex flex-col justify-between border border-slate-800">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center">
                <ShieldCheck className="w-5 h-5 text-white" />
              </div>
              <span className="font-display text-xl font-bold tracking-tight">MANDATO</span>
            </div>

            <h1 className="mt-8 font-display text-3xl font-semibold tracking-tight leading-tight text-white [text-wrap:balance]">
              Criação, Gestão e Governação de Agentes de IA Empresariais
            </h1>
            <p className="mt-4 text-sm text-slate-300 leading-relaxed">
              Os agentes de IA podem trabalhar com autonomia dentro de limites claramente definidos, mas todas as ações sensíveis permanecem sob controlo humano.
            </p>

            <div className="mt-8 space-y-4 border-t border-slate-800 pt-6">
              <div>
                <p className="text-sm font-medium text-white">Fábrica de Agentes sem código</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Configure instruções, ferramentas, modelos e limites em 7 passos estruturados.
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-white">Motor de Autorização Independente</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Avaliação determinística no servidor: Permitido, Requer Aprovação ou Bloqueado.
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-white">Isolamento Multi-Empresa e Auditoria</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Registos imutáveis, credenciais com hash criptográfico e separação estrita por empresa.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-800">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-emerald-400">Ambiente de Demonstração</p>
                <p className="text-xs text-slate-300 mt-0.5">
                  Explore a Empresa Demonstração com dados operacionais pré-configurados.
                </p>
              </div>
            </div>

            <div className="mt-4 flex flex-col sm:flex-row gap-2.5">
              <select
                aria-label="Perfil para demonstração"
                value={demoRole}
                onChange={(e) => setDemoRole(e.target.value as UserRole)}
                className="bg-slate-800 border border-slate-700 text-slate-100 text-xs rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="OWNER">Proprietário (Helena Vasconcelos)</option>
                <option value="ADMIN">Administrador (Tiago Azevedo)</option>
                <option value="APPROVER">Aprovador (Inês Ferreira)</option>
                <option value="OPERATOR">Operador (Diogo Martins)</option>
                <option value="VIEWER">Leitura (Sofia Almeida)</option>
              </select>
              <button
                type="button"
                disabled={loading}
                onClick={() => handleDemoLogin(demoRole)}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <span>Entrar na Demonstração</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Coluna Formulário */}
        <div className="lg:col-span-6 bg-white rounded-xl p-8 lg:p-10 border border-slate-200 flex flex-col justify-center">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start mb-6">
            <button
              type="button"
              onClick={() => { setMode('login'); setError(null); setInfoMessage(null); }}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                mode === 'login' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Iniciar Sessão
            </button>
            <button
              type="button"
              onClick={() => { setMode('register'); setError(null); setInfoMessage(null); }}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                mode === 'register' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Registar Empresa
            </button>
            <button
              type="button"
              onClick={() => { setMode('recover'); setError(null); setInfoMessage(null); }}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                mode === 'recover' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Recuperar Acesso
            </button>
          </div>

          {error && (
            <div role="alert" className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
              {error}
            </div>
          )}
          {infoMessage && (
            <div className="mb-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
              {infoMessage}
            </div>
          )}

          {mode === 'login' && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <h2 className="font-display text-xl font-semibold text-slate-900">Aceder à plataforma</h2>
                <p className="text-xs text-slate-500 mt-1">
                  Introduza as credenciais da sua conta empresarial.
                </p>
              </div>
              <div>
                <label htmlFor="login-email" className="block text-xs font-medium text-slate-700 mb-1">
                  Endereço de email
                </label>
                <input
                  id="login-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="nome@empresa.pt"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <div>
                <label htmlFor="login-password" className="block text-xs font-medium text-slate-700 mb-1">
                  Palavra-passe
                </label>
                <input
                  id="login-password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50"
              >
                <Lock className="w-4 h-4" />
                <span>{loading ? 'A validar...' : 'Iniciar Sessão'}</span>
              </button>

              <div className="pt-4 border-t border-slate-100 text-xs text-slate-500">
                Credenciais de teste da Empresa Demonstração: <span className="font-mono text-slate-700">direcao@demonstracao.pt</span> · <span className="font-mono text-slate-700">MandatoDemo2026!</span>
              </div>
            </form>
          )}

          {mode === 'register' && (
            <form onSubmit={handleRegister} className="space-y-4">
              <div>
                <h2 className="font-display text-xl font-semibold text-slate-900">Registar nova empresa</h2>
                <p className="text-xs text-slate-500 mt-1">
                  Cria um espaço empresarial totalmente isolado com proteção bancária ativa.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="reg-company" className="block text-xs font-medium text-slate-700 mb-1">
                    Nome da empresa
                  </label>
                  <input
                    id="reg-company"
                    type="text"
                    required
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder="Ex: Atlântico Soluções Lda"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>
                <div>
                  <label htmlFor="reg-nif" className="block text-xs font-medium text-slate-700 mb-1">
                    NIF (Opcional)
                  </label>
                  <input
                    id="reg-nif"
                    type="text"
                    value={nif}
                    onChange={(e) => setNif(e.target.value)}
                    placeholder="509000000"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="reg-name" className="block text-xs font-medium text-slate-700 mb-1">
                  Nome completo
                </label>
                <input
                  id="reg-name"
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Ana Silva"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <div>
                <label htmlFor="reg-email" className="block text-xs font-medium text-slate-700 mb-1">
                  Email profissional
                </label>
                <input
                  id="reg-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="ana.silva@empresa.pt"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <div>
                <label htmlFor="reg-pass" className="block text-xs font-medium text-slate-700 mb-1">
                  Palavra-passe (mín. 8 caracteres)
                </label>
                <input
                  id="reg-pass"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition-colors disabled:opacity-50"
              >
                <Building2 className="w-4 h-4" />
                <span>{loading ? 'A criar empresa...' : 'Criar Conta Empresarial'}</span>
              </button>
            </form>
          )}

          {mode === 'recover' && (
            <form onSubmit={handleRecover} className="space-y-4">
              <div>
                <h2 className="font-display text-xl font-semibold text-slate-900">Recuperar palavra-passe</h2>
                <p className="text-xs text-slate-500 mt-1">
                  Solicite um código de reposição para o seu email registado.
                </p>
              </div>
              <div>
                <label htmlFor="rec-email" className="block text-xs font-medium text-slate-700 mb-1">
                  Email da conta
                </label>
                <input
                  id="rec-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="utilizador@empresa.pt"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              {recoveryStep2 && (
                <>
                  <div>
                    <label htmlFor="rec-code" className="block text-xs font-medium text-slate-700 mb-1">
                      Código de recuperação
                    </label>
                    <input
                      id="rec-code"
                      type="text"
                      required
                      value={recoveryToken}
                      onChange={(e) => setRecoveryToken(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>
                  <div>
                    <label htmlFor="rec-new-pass" className="block text-xs font-medium text-slate-700 mb-1">
                      Nova palavra-passe
                    </label>
                    <input
                      id="rec-new-pass"
                      type="password"
                      required
                      minLength={8}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>
                </>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50"
              >
                <KeyRound className="w-4 h-4" />
                <span>{recoveryStep2 ? 'Definir Nova Palavra-passe' : 'Solicitar Código'}</span>
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
