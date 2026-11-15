import React, { useEffect, useState } from 'react';
import { Plug, Terminal, CheckCircle2, AlertCircle } from 'lucide-react';
import { apiFetch } from '../utils/api';
import type { IntegrationItem } from '../shared/types';

export const IntegrationsView: React.FC = () => {
  const [integrations, setIntegrations] = useState<IntegrationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'ai_provider' | 'business_system'>('all');

  // Testador do Gateway API /api/v1/authorize
  const [agentSecret, setAgentSecret] = useState('');
  const [gwAction, setGwAction] = useState('purchase_order');
  const [gwDesc, setGwDesc] = useState('Compra de equipamento de escritório');
  const [gwAmount, setGwAmount] = useState('500');
  const [gwIdem, setGwIdem] = useState(`req_${Date.now()}`);
  const [gwResponse, setGwResponse] = useState<string | null>(null);
  const [gwLoading, setGwLoading] = useState(false);

  useEffect(() => {
    apiFetch<{ integrations: IntegrationItem[] }>('/api/integrations')
      .then((res) => setIntegrations(res.integrations))
      .finally(() => setLoading(false));
  }, []);

  async function handleTestGateway(e: React.FormEvent) {
    e.preventDefault();
    setGwLoading(true);
    setGwResponse(null);
    try {
      const res = await fetch('/api/v1/authorize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${agentSecret.trim()}`,
        },
        body: JSON.stringify({
          action_type: gwAction,
          description: gwDesc,
          amount: gwAmount ? Number(gwAmount) : undefined,
          currency: 'EUR',
          idempotency_key: gwIdem,
        }),
      });
      const json = await res.json();
      setGwResponse(JSON.stringify({ status: res.status, body: json }, null, 2));
    } catch (err) {
      setGwResponse(err instanceof Error ? err.message : 'Erro de rede');
    } finally {
      setGwLoading(false);
    }
  }

  const filtered =
    selectedCategory === 'all'
      ? integrations
      : integrations.filter((i) => i.category === selectedCategory);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Integrações e Gateway API
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Estado real das ligações de modelos de IA e sistemas empresariais. Nenhuma ligação é simulada como ativa sem credenciais no servidor.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start">
          <button
            type="button"
            onClick={() => setSelectedCategory('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${
              selectedCategory === 'all' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            Todas
          </button>
          <button
            type="button"
            onClick={() => setSelectedCategory('ai_provider')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${
              selectedCategory === 'ai_provider' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            Provedores IA
          </button>
          <button
            type="button"
            onClick={() => setSelectedCategory('business_system')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${
              selectedCategory === 'business_system' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            Sistemas Empresariais
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-white border border-slate-200 rounded-xl h-48 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filtered.map((item) => {
            const isConfigured = item.status === 'configured';
            return (
              <div key={item.id} className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-slate-500">
                      {item.category === 'ai_provider' ? 'Provedor de IA' : 'Sistema Empresarial'}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 text-[11px] font-semibold ${
                        isConfigured ? 'text-emerald-700' : 'text-slate-500'
                      }`}
                    >
                      {isConfigured ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                      {isConfigured ? 'Configurada' : 'Não configurada'}
                    </span>
                  </div>

                  <h2 className="font-display text-base font-semibold text-slate-900 mt-1.5">{item.name}</h2>
                  <p className="text-xs text-slate-600 mt-2">{item.description}</p>

                  <div className="mt-4 pt-3 border-t border-slate-100 space-y-1.5 text-[11px]">
                    <p className="font-semibold text-slate-700">Credenciais necessárias (Servidor):</p>
                    <p className="font-mono text-slate-600">{item.required_credentials.join(', ')}</p>
                    <p className="font-semibold text-slate-700 pt-1">Capacidades:</p>
                    <p className="text-slate-600">{item.capabilities.join(' · ')}</p>
                  </div>
                </div>

                <p className="mt-4 pt-3 border-t border-slate-100 text-[11px] text-slate-500">
                  {item.documentation_summary}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {/* Documentação e Consola do Gateway Central /api/v1/authorize */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
          <Terminal className="w-4 h-4 text-slate-800" />
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900">
              Gateway Central de Autorização — POST /api/v1/authorize
            </h2>
            <p className="text-xs text-slate-500">
              Endpoint para agentes internos ou externos submeterem ações antes da execução. A empresa é resolvida exclusivamente pela credencial do agente.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-3 text-xs">
            <p className="font-semibold text-slate-900">Exemplo de pedido REST</p>
            <pre className="p-3.5 rounded-lg bg-slate-900 text-slate-100 font-mono text-[11px] overflow-x-auto">
{`POST /api/v1/authorize
Authorization: Bearer mdt_ext_...
Content-Type: application/json

{
  "action_type": "purchase_order",
  "description": "Compra de equipamento de escritório",
  "amount": 500,
  "currency": "EUR",
  "resource_id": "order_789",
  "idempotency_key": "unique_request_key"
}`}
            </pre>
            <p className="text-slate-500">
              Respostas possíveis: <span className="font-mono text-emerald-700">ALLOWED</span>,{' '}
              <span className="font-mono text-amber-700">REQUIRES_APPROVAL</span> ou{' '}
              <span className="font-mono text-red-700">BLOCKED</span> (HTTP 403).
            </p>
          </div>

          <form onSubmit={handleTestGateway} className="space-y-3 text-xs">
            <p className="font-semibold text-slate-900">Testar Gateway em direto</p>
            <div>
              <label className="block text-slate-600 mb-1">Chave Bearer do Agente (emitida ao criar/rodar)</label>
              <input
                type="password"
                required
                value={agentSecret}
                onChange={(e) => setAgentSecret(e.target.value)}
                placeholder="mdt_ext_... ou mdt_live_..."
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-600 mb-1">action_type</label>
                <input
                  type="text"
                  value={gwAction}
                  onChange={(e) => setGwAction(e.target.value)}
                  className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">amount (EUR)</label>
                <input
                  type="number"
                  value={gwAmount}
                  onChange={(e) => setGwAmount(e.target.value)}
                  className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-600 mb-1">description</label>
                <input
                  type="text"
                  value={gwDesc}
                  onChange={(e) => setGwDesc(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">idempotency_key</label>
                <input
                  type="text"
                  value={gwIdem}
                  onChange={(e) => setGwIdem(e.target.value)}
                  className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={gwLoading || !agentSecret}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
            >
              {gwLoading ? 'A enviar...' : 'Enviar Pedido ao Gateway'}
            </button>
            {gwResponse && (
              <pre className="p-3 rounded-lg bg-slate-50 border border-slate-200 font-mono text-[11px] overflow-x-auto text-slate-900">
                {gwResponse}
              </pre>
            )}
          </form>
        </div>
      </div>
    </div>
  );
};
