import React, { useEffect, useState } from 'react';
import { Sparkles, Check, ChevronRight, ChevronLeft, ShieldAlert, Key, Send } from 'lucide-react';
import { apiFetch, isDatabaseNotConnectedError } from '../utils/api';
import { DatabaseNotConnectedBanner } from './DatabaseNotConnectedBanner';
import type {
  Agent,
  AgentInstructions,
  AgentPermissionsConfig,
  AgentTemplate,
  BusinessCategory,
  Policy,
} from '../shared/types';
import type { CatalogToolDefinition } from '../server/seedTemplates';
import { DECISION_META, formatEUR } from '../utils/formatters';

interface AgentWizardViewProps {
  initialTemplate: AgentTemplate | null;
  onAgentCreated: () => void;
  onNavigateSettings?: () => void;
}

const CATEGORIES: BusinessCategory[] = [
  'Financeiro',
  'Administrativo',
  'Compras',
  'Atendimento ao Cliente',
  'Recursos Humanos',
  'Marketing',
  'Vendas',
  'Gestão de Projetos',
  'Análise de Dados',
  'Personalizado',
];

const STEPS = [
  '1. Identidade',
  '2. Instruções',
  '3. Modelo IA',
  '4. Ferramentas',
  '5. Permissões',
  '6. Testar',
  '7. Guardar e Ativar',
];

export const AgentWizardView: React.FC<AgentWizardViewProps> = ({
  initialTemplate,
  onAgentCreated,
  onNavigateSettings,
}) => {
  const [step, setStep] = useState(0);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [dbDisconnected, setDbDisconnected] = useState(false);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [toolCatalog, setToolCatalog] = useState<CatalogToolDefinition[]>([]);
  const [providers, setProviders] = useState<
    Array<{
      provider_key: string;
      name: string;
      configured: boolean;
      status_label: string;
      models: Array<{ id: string; name: string; available: boolean; note: string }>;
    }>
  >([]);

  // Step 1: Identidade
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>('Compras');
  const [objective, setObjective] = useState('');
  const [avatarIcon, setAvatarIcon] = useState('bot');
  const [desiredStatus, setDesiredStatus] = useState<'draft' | 'active'>('active');

  // Step 2: Instruções
  const [aiDescriptionPrompt, setAiDescriptionPrompt] = useState('');
  const [generatingAi, setGeneratingAi] = useState(false);
  const [instructionsReviewed, setInstructionsReviewed] = useState(false);
  const [instructions, setInstructions] = useState<AgentInstructions>({
    role: '',
    objective: '',
    responsibilities: [''],
    behaviour: 'Rigoroso, metódico e transparente',
    communication_style: 'Português Europeu formal e objetivo',
    rules: ['Validar sempre limites financeiros antes de propor encomendas'],
    restrictions: ['Nunca alterar dados bancários ou IBAN', 'Nunca executar pagamentos diretos'],
    expected_output: 'Recomendação estruturada com resumo de riscos.',
  });

  // Step 3: Modelo IA
  const [selectedProvider, setSelectedProvider] = useState('Google Gemini');
  const [selectedModel, setSelectedModel] = useState('gemini-4-hydrogen');

  // Step 4: Ferramentas
  const [selectedTools, setSelectedTools] = useState<
    Record<string, { is_enabled: boolean; requires_approval: boolean }>
  >({});

  // Step 5: Permissões e Políticas
  const [permissions, setPermissions] = useState<AgentPermissionsConfig>({
    read_permissions: ['suppliers', 'catalog'],
    write_permissions: ['purchase_order_drafts'],
    max_auto_financial_limit_eur: 300,
    max_approval_financial_limit_eur: 1000,
    allowed_resources: ['suppliers', 'quotations'],
    restricted_resources: ['bank_accounts', 'payroll'],
    actions_requiring_approval: ['purchase_order', 'create_supplier'],
    always_blocked_actions: ['bank_details_update', 'sign_contract'],
  });
  const [selectedPolicyIds, setSelectedPolicyIds] = useState<string[]>([]);

  // Step 6: Testar antes de ativar (pré-visualização interativa de política + Gemini após criação ou simulação direta)
  const [testPrompt, setTestPrompt] = useState('Solicitar compra de equipamento de escritório no valor de €500');
  const [sandboxLog, setSandboxLog] = useState<
    Array<{
      userMessage: string;
      reply: string;
      decision?: string;
      reason?: string;
    }>
  >([]);
  const [testingNow, setTestingNow] = useState(false);

  // Step 7: Guardar
  const [confirmReview, setConfirmReview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuedResult, setIssuedResult] = useState<{ agent: Agent; apiKey: string } | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<{ policies: Policy[] }>('/api/policies'),
      apiFetch<{ tool_catalog: CatalogToolDefinition[] }>('/api/templates'),
      apiFetch<{
        ai_providers: Array<{
          provider_key: string;
          name: string;
          configured: boolean;
          status_label: string;
          models: Array<{ id: string; name: string; available: boolean; note: string }>;
        }>;
      }>('/api/system/status'),
    ])
      .then(([polRes, tplRes, sysRes]) => {
        setPolicies(polRes.policies);
        setToolCatalog(tplRes.tool_catalog);
        setProviders(sysRes.ai_providers);
        if (polRes.policies.length > 0 && selectedPolicyIds.length === 0) {
          setSelectedPolicyIds(polRes.policies.slice(0, 2).map((p) => p.id));
        }
        const initialToolMap: Record<string, { is_enabled: boolean; requires_approval: boolean }> = {};
        for (const t of tplRes.tool_catalog) {
          initialToolMap[t.tool_key] = {
            is_enabled: !t.dangerous_by_default && t.risk_level === 'low',
            requires_approval: t.default_requires_approval,
          };
        }
        if (initialTemplate) {
          for (const st of initialTemplate.suggested_tools) {
            initialToolMap[st.tool_key] = {
              is_enabled: st.default_enabled,
              requires_approval: st.requires_approval,
            };
          }
        }
        setSelectedTools(initialToolMap);
        setDbDisconnected(false);
      })
      .catch((err) => {
        setDbDisconnected(isDatabaseNotConnectedError(err));
        setError(err instanceof Error ? err.message : 'Erro ao carregar políticas.');
      })
      .finally(() => setLoadingMeta(false));
  }, []);

  useEffect(() => {
    if (!initialTemplate) return;
    setName(`${initialTemplate.name} Personalizado`);
    setDescription(initialTemplate.description);
    setCategory(initialTemplate.category);
    setObjective(initialTemplate.objective);
    setInstructions(initialTemplate.suggested_instructions);
    setPermissions(initialTemplate.suggested_permissions);
    setDesiredStatus('draft'); // Regra: nunca ativar automaticamente a partir de um modelo
    setInstructionsReviewed(true);
  }, [initialTemplate]);

  async function handleGenerateWithAI() {
    if (!aiDescriptionPrompt.trim()) {
      setError('Descreva o comportamento pretendido antes de gerar instruções com IA.');
      return;
    }
    setError(null);
    setGeneratingAi(true);
    try {
      const res = await apiFetch<{ instructions: AgentInstructions }>('/api/agents/generate-instructions', {
        method: 'POST',
        body: JSON.stringify({ description: aiDescriptionPrompt, category }),
      });
      setInstructions(res.instructions);
      setInstructionsReviewed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao gerar instruções com Gemini.');
    } finally {
      setGeneratingAi(false);
    }
  }

  async function handleQuickSandboxTest() {
    if (!testPrompt.trim()) return;
    setTestingNow(true);
    setError(null);
    try {
      // Avaliação determinística imediata simulada com base nas regras configuradas neste assistente
      const lower = testPrompt.toLowerCase();
      const eurMatch = testPrompt.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur)/i) || testPrompt.match(/(?:€|eur)\s*(\d+(?:[.,]\d{1,2})?)/i);
      const amount = eurMatch ? Number(eurMatch[1].replace(',', '.')) : null;
      let decision = 'ALLOWED';
      let reason = 'Pedido informativo dentro dos limites definidos no assistente.';
      if (/(iban|banc[aá]ri)/i.test(lower)) {
        decision = 'BLOCKED';
        reason = 'Restrição absoluta: alteração de dados bancários sempre bloqueada.';
      } else if (amount !== null) {
        if (amount > permissions.max_approval_financial_limit_eur) {
          decision = 'BLOCKED';
          reason = `Montante ${formatEUR(amount)} excede o teto máximo configurado (${formatEUR(permissions.max_approval_financial_limit_eur)}).`;
        } else if (amount > permissions.max_auto_financial_limit_eur) {
          decision = 'REQUIRES_APPROVAL';
          reason = `Montante ${formatEUR(amount)} excede o limite automático (${formatEUR(permissions.max_auto_financial_limit_eur)}). Exige aprovação humana.`;
        } else {
          decision = 'ALLOWED';
          reason = `Montante ${formatEUR(amount)} dentro do limite automático (${formatEUR(permissions.max_auto_financial_limit_eur)}).`;
        }
      }
      setSandboxLog((prev) => [
        ...prev,
        {
          userMessage: testPrompt,
          reply: `Simulação concluída para "${name || 'Novo Agente'}" (${selectedModel}). Após guardar o agente, poderá testá-lo em tempo real com o Gemini em "5. Testar Agentes".`,
          decision,
          reason,
        },
      ]);
      setTestPrompt('');
    } finally {
      setTestingNow(false);
    }
  }

  async function handleSaveAgent(statusOverride?: 'draft' | 'active') {
    const targetStatus = statusOverride || desiredStatus;
    setError(null);
    if (!name.trim() || !description.trim()) {
      setError('Preencha o nome e a descrição do agente no Passo 1.');
      setStep(0);
      return;
    }
    if (targetStatus === 'active' && selectedPolicyIds.length === 0) {
      setError('Selecione pelo menos uma política no Passo 5 antes de ativar o agente.');
      setStep(4);
      return;
    }
    if (targetStatus === 'active' && !confirmReview) {
      setError('Confirme o resumo de capacidades e restrições antes da ativação.');
      return;
    }

    setSubmitting(true);
    try {
      const toolsPayload = Object.entries(selectedTools).map(([tool_key, val]) => ({
        tool_key,
        is_enabled: val.is_enabled,
        requires_approval: val.requires_approval,
      }));
      const res = await apiFetch<{ agent: Agent; issued_api_key: string }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description,
          category,
          objective: objective || description,
          origin: 'MANDATO',
          provider: selectedProvider,
          model: selectedModel,
          avatar_icon: avatarIcon,
          status: targetStatus,
          instructions,
          permissions_summary: permissions,
          policy_ids: selectedPolicyIds,
          tools: toolsPayload,
        }),
      });
      setIssuedResult({ agent: res.agent, apiKey: res.issued_api_key });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao guardar agente.');
    } finally {
      setSubmitting(false);
    }
  }

  if (issuedResult) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 max-w-2xl mx-auto">
        <div className="flex items-center gap-3 text-emerald-700">
          <Check className="w-6 h-6" />
          <h2 className="font-display text-xl font-semibold text-slate-900">
            Agente guardado com sucesso
          </h2>
        </div>
        <p className="text-sm text-slate-600 mt-2">
          O agente <span className="font-semibold text-slate-900">{issuedResult.agent.name}</span> foi registado com o estado{' '}
          <span className="font-mono text-slate-900">{issuedResult.agent.status}</span>.
        </p>

        <div className="mt-6 p-4 rounded-lg bg-slate-50 border border-slate-200">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-900">
            <Key className="w-4 h-4 text-emerald-700" />
            <span>Credencial API do Agente (mostrada apenas uma vez)</span>
          </div>
          <p className="mt-2 font-mono text-xs bg-white border border-slate-200 rounded-md p-2.5 select-all break-all text-slate-900">
            {issuedResult.apiKey}
          </p>
          <p className="mt-1.5 text-[11px] text-slate-500">
            O servidor armazena exclusivamente o hash SHA-256 desta chave. Guarde-a em local seguro caso o agente utilize o gateway /api/v1/authorize.
          </p>
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={onAgentCreated}
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
          >
            Ir para Os Meus Agentes
          </button>
        </div>
      </div>
    );
  }

  if (loadingMeta) {
    return <div className="bg-white border border-slate-200 rounded-xl p-8 h-80 animate-pulse" />;
  }

  if (dbDisconnected) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Criar Agente de IA
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Ligue a Folha de Cálculo Google da empresa para criar e guardar agentes.
          </p>
        </div>
        <DatabaseNotConnectedBanner message={error || undefined} onNavigateSettings={onNavigateSettings} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
          Criar Agente de IA
        </h1>
        <p className="text-xs text-slate-500 mt-1">
          Assistente visual em 7 passos para configurar identidade, instruções, modelo, ferramentas e limites de governação.
        </p>
      </div>

      {/* Stepper */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 overflow-x-auto">
        <div className="flex items-center gap-1 min-w-max">
          {STEPS.map((label, idx) => (
            <button
              key={label}
              type="button"
              onClick={() => setStep(idx)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                step === idx
                  ? 'bg-slate-900 text-white'
                  : idx < step
                  ? 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div role="alert" className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800">
          {error}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-6 lg:p-8">
        {/* PASSO 1: IDENTIDADE */}
        {step === 0 && (
          <div className="space-y-5 max-w-3xl">
            <h2 className="font-display text-lg font-semibold text-slate-900">Passo 1 · Identidade do Agente</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="wiz-name" className="block text-xs font-medium text-slate-700 mb-1">
                  Nome do agente *
                </label>
                <input
                  id="wiz-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex: Assistente de Cotações"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <div>
                <label htmlFor="wiz-cat" className="block text-xs font-medium text-slate-700 mb-1">
                  Área de negócio
                </label>
                <select
                  id="wiz-cat"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="wiz-desc" className="block text-xs font-medium text-slate-700 mb-1">
                Descrição operacional *
              </label>
              <textarea
                id="wiz-desc"
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Descreva o propósito deste agente na sua empresa..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>

            <div>
              <label htmlFor="wiz-obj" className="block text-xs font-medium text-slate-700 mb-1">
                Objetivo principal
              </label>
              <input
                id="wiz-obj"
                type="text"
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="Ex: Reduzir tempo de análise de propostas garantindo cumprimento de limites"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="wiz-icon" className="block text-xs font-medium text-slate-700 mb-1">
                  Ícone identificador
                </label>
                <select
                  id="wiz-icon"
                  value={avatarIcon}
                  onChange={(e) => setAvatarIcon(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                >
                  <option value="bot">Assistente Geral</option>
                  <option value="shopping-cart">Compras</option>
                  <option value="landmark">Financeiro</option>
                  <option value="headset">Atendimento</option>
                  <option value="file-text">Documentos</option>
                </select>
              </div>
              <div>
                <label htmlFor="wiz-status" className="block text-xs font-medium text-slate-700 mb-1">
                  Estado inicial pretendido
                </label>
                <select
                  id="wiz-status"
                  value={desiredStatus}
                  onChange={(e) => setDesiredStatus(e.target.value as 'draft' | 'active')}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                >
                  <option value="active">Ativo (após validação)</option>
                  <option value="draft">Rascunho</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {/* PASSO 2: INSTRUÇÕES + GERAR COM IA */}
        {step === 1 && (
          <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-100">
              <div>
                <h2 className="font-display text-lg font-semibold text-slate-900">Passo 2 · Instruções do Agente</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Configure o comportamento ou gere um modelo estruturado com Google Gemini.
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
              <label htmlFor="ai-gen-prompt" className="block text-xs font-semibold text-slate-900">
                Gerar instruções com IA (linguagem natural)
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  id="ai-gen-prompt"
                  type="text"
                  value={aiDescriptionPrompt}
                  onChange={(e) => setAiDescriptionPrompt(e.target.value)}
                  placeholder="Ex: Cria um assistente que gere cotações de fornecedores, compara preços e prepara recomendações de compra."
                  className="flex-1 px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
                <button
                  type="button"
                  disabled={generatingAi}
                  onClick={handleGenerateWithAI}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition-colors whitespace-nowrap disabled:opacity-50"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{generatingAi ? 'A gerar...' : 'Gerar instruções com IA'}</span>
                </button>
              </div>
              {!instructionsReviewed && (
                <label className="inline-flex items-center gap-2 text-xs text-slate-700 pt-1">
                  <input
                    type="checkbox"
                    checked={instructionsReviewed}
                    onChange={(e) => setInstructionsReviewed(e.target.checked)}
                    className="rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                  />
                  <span>Confirmo que revi e aprovei as instruções antes de guardar.</span>
                </label>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Papel (Role)</label>
                <input
                  type="text"
                  value={instructions.role}
                  onChange={(e) => setInstructions({ ...instructions, role: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Estilo de comunicação</label>
                <input
                  type="text"
                  value={instructions.communication_style}
                  onChange={(e) => setInstructions({ ...instructions, communication_style: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Objetivo operacional</label>
                <input
                  type="text"
                  value={instructions.objective}
                  onChange={(e) => setInstructions({ ...instructions, objective: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Responsabilidades (uma por linha)
                </label>
                <textarea
                  rows={4}
                  value={(instructions.responsibilities || []).join('\n')}
                  onChange={(e) =>
                    setInstructions({ ...instructions, responsibilities: e.target.value.split('\n').filter(Boolean) })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Restrições explícitas (uma por linha)
                </label>
                <textarea
                  rows={4}
                  value={(instructions.restrictions || []).join('\n')}
                  onChange={(e) =>
                    setInstructions({ ...instructions, restrictions: e.target.value.split('\n').filter(Boolean) })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Comportamento</label>
                <input
                  type="text"
                  value={instructions.behaviour}
                  onChange={(e) => setInstructions({ ...instructions, behaviour: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Resultado esperado</label>
                <input
                  type="text"
                  value={instructions.expected_output}
                  onChange={(e) => setInstructions({ ...instructions, expected_output: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>
          </div>
        )}

        {/* PASSO 3: MODELO DE IA */}
        {step === 2 && (
          <div className="space-y-5">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-900">Passo 3 · Provedor e Modelo de IA</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Apenas modelos com provedor configurado no servidor estão disponíveis para seleção.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {providers.map((prov) => (
                <div key={prov.provider_key} className="border border-slate-200 rounded-xl p-4 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-slate-900">{prov.name}</h3>
                      <span
                        className={`text-[11px] font-medium ${
                          prov.configured ? 'text-emerald-700' : 'text-slate-500'
                        }`}
                      >
                        {prov.configured ? 'Configurado' : 'Indisponível'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">{prov.status_label}</p>

                    <div className="mt-4 space-y-2">
                      {prov.models.map((m) => {
                        const isSelected = selectedProvider === prov.name && selectedModel === m.id;
                        return (
                          <button
                            key={m.id}
                            type="button"
                            disabled={!m.available}
                            onClick={() => {
                              setSelectedProvider(prov.name);
                              setSelectedModel(m.id);
                            }}
                            className={`w-full text-left p-2.5 rounded-lg border text-xs transition-colors ${
                              isSelected
                                ? 'border-slate-900 bg-slate-900 text-white'
                                : m.available
                                ? 'border-slate-200 hover:border-slate-400 text-slate-800'
                                : 'border-slate-100 bg-slate-50 text-slate-400 cursor-not-allowed'
                            }`}
                          >
                            <p className="font-medium">{m.name}</p>
                            <p className={`text-[11px] mt-0.5 ${isSelected ? 'text-slate-300' : 'text-slate-500'}`}>
                              {m.note}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* PASSO 4: FERRAMENTAS */}
        {step === 3 && (
          <div className="space-y-4">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-900">Passo 4 · Ferramentas e Capacidades</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Ferramentas perigosas estão desativadas por omissão. Mesmo ativadas, cada invocação passa obrigatoriamente pelo motor de políticas MANDATO.
              </p>
            </div>

            <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl">
              {toolCatalog.map((tool) => {
                const state = selectedTools[tool.tool_key] || {
                  is_enabled: false,
                  requires_approval: tool.default_requires_approval,
                };
                return (
                  <div key={tool.tool_key} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-slate-900">
                        {tool.tool_name}
                        <span className="text-xs font-normal text-slate-500"> · {tool.category} · Risco {tool.risk_level}</span>
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">{tool.description}</p>
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                      <label className="inline-flex items-center gap-2 text-xs text-slate-700">
                        <input
                          type="checkbox"
                          checked={state.is_enabled}
                          onChange={(e) =>
                            setSelectedTools((prev) => ({
                              ...prev,
                              [tool.tool_key]: { ...state, is_enabled: e.target.checked },
                            }))
                          }
                          className="rounded border-slate-300 text-slate-900"
                        />
                        <span>Ativar ferramenta</span>
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* PASSO 5: PERMISSÕES E POLÍTICAS */}
        {step === 4 && (
          <div className="space-y-6">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-900">
                Passo 5 · Permissões, Limites Financeiros e Políticas
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Defina tetos financeiros do agente e associe políticas de autorização da empresa.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Limite financeiro automático (EUR)
                </label>
                <input
                  type="number"
                  min={0}
                  value={permissions.max_auto_financial_limit_eur}
                  onChange={(e) =>
                    setPermissions({ ...permissions, max_auto_financial_limit_eur: Number(e.target.value) })
                  }
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Teto máximo com aprovação humana (EUR)
                </label>
                <input
                  type="number"
                  min={0}
                  value={permissions.max_approval_financial_limit_eur}
                  onChange={(e) =>
                    setPermissions({ ...permissions, max_approval_financial_limit_eur: Number(e.target.value) })
                  }
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Recursos permitidos (separados por vírgula)
                </label>
                <input
                  type="text"
                  value={permissions.allowed_resources.join(', ')}
                  onChange={(e) =>
                    setPermissions({
                      ...permissions,
                      allowed_resources: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Recursos interditos (separados por vírgula)
                </label>
                <input
                  type="text"
                  value={permissions.restricted_resources.join(', ')}
                  onChange={(e) =>
                    setPermissions({
                      ...permissions,
                      restricted_resources: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-900 mb-2">
                Políticas Empresariais Associadas (obrigatório para ativação)
              </h3>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl">
                {policies.map((pol) => {
                  const checked = selectedPolicyIds.includes(pol.id);
                  return (
                    <label
                      key={pol.id}
                      className="p-3.5 flex items-start justify-between gap-3 cursor-pointer hover:bg-slate-50"
                    >
                      <div className="flex items-start gap-2.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedPolicyIds((prev) => [...prev, pol.id]);
                            else setSelectedPolicyIds((prev) => prev.filter((id) => id !== pol.id));
                          }}
                          className="mt-0.5 rounded border-slate-300 text-slate-900"
                        />
                        <div>
                          <p className="text-xs font-semibold text-slate-900">{pol.name}</p>
                          <p className="text-xs text-slate-500 mt-0.5">{pol.description}</p>
                        </div>
                      </div>
                      <span className="text-[11px] font-mono text-slate-500 shrink-0">{pol.action_type}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* PASSO 6: TESTAR AGENTE */}
        {step === 5 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-display text-lg font-semibold text-slate-900">Passo 6 · Simulação Pré-Ativação</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Valide como os limites configurados avaliam pedidos antes de guardar o agente.
                </p>
              </div>
              <span className="text-xs font-medium text-amber-700">Modo Simulação (Sem efeitos reais)</span>
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={testPrompt}
                onChange={(e) => setTestPrompt(e.target.value)}
                placeholder="Ex: Solicitar compra de €500 ou alterar IBAN..."
                className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              <button
                type="button"
                disabled={testingNow}
                onClick={handleQuickSandboxTest}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Simular</span>
              </button>
            </div>

            <div className="space-y-3 mt-4">
              {sandboxLog.map((entry, idx) => {
                const decMeta = entry.decision ? DECISION_META[entry.decision] : null;
                return (
                  <div key={idx} className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
                    <p className="font-medium text-slate-900">Mensagem: {entry.userMessage}</p>
                    <p className="text-slate-700">{entry.reply}</p>
                    {decMeta && (
                      <p className={decMeta.textClass}>
                        Decisão do motor: {decMeta.label} — {entry.reason}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* PASSO 7: REVER E GUARDAR */}
        {step === 6 && (
          <div className="space-y-5 max-w-3xl">
            <h2 className="font-display text-lg font-semibold text-slate-900">Passo 7 · Validação e Ativação</h2>

            <div className="border border-slate-200 rounded-xl divide-y divide-slate-100 text-xs">
              <div className="p-4 flex justify-between">
                <span className="text-slate-500">Nome e Área</span>
                <span className="font-semibold text-slate-900">{name || '—'} · {category}</span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-slate-500">Modelo configurado</span>
                <span className="font-mono text-slate-900">{selectedProvider} / {selectedModel}</span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-slate-500">Ferramentas ativas</span>
                <span className="font-mono text-slate-900">
                  {Object.values(selectedTools).filter((t) => t.is_enabled).length} ferramentas
                </span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-slate-500">Políticas associadas</span>
                <span className={`font-mono font-semibold ${selectedPolicyIds.length > 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                  {selectedPolicyIds.length} políticas
                </span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-slate-500">Tetos financeiros</span>
                <span className="font-mono text-slate-900">
                  Auto até {formatEUR(permissions.max_auto_financial_limit_eur)} · Aprovação até {formatEUR(permissions.max_approval_financial_limit_eur)}
                </span>
              </div>
            </div>

            {selectedPolicyIds.length === 0 && (
              <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>Sem políticas associadas só é possível guardar como Rascunho. Associe uma política no Passo 5 para ativar.</span>
              </div>
            )}

            <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmReview}
                onChange={(e) => setConfirmReview(e.target.checked)}
                className="mt-0.5 rounded border-slate-300 text-emerald-700"
              />
              <span>
                Confirmo que revi as instruções, ferramentas e restrições do agente e autorizo o seu registo na empresa.
              </span>
            </label>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                disabled={submitting}
                onClick={() => handleSaveAgent('draft')}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Guardar como Rascunho
              </button>
              <button
                type="button"
                disabled={submitting || selectedPolicyIds.length === 0 || !confirmReview}
                onClick={() => handleSaveAgent('active')}
                className="px-4 py-2 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-50"
              >
                {submitting ? 'A guardar...' : 'Confirmar e Ativar Agente'}
              </button>
            </div>
          </div>
        )}

        {/* Controlos de Navegação do Assistente */}
        <div className="mt-8 pt-5 border-t border-slate-100 flex items-center justify-between">
          <button
            type="button"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            <span>Anterior</span>
          </button>

          {step < STEPS.length - 1 && (
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
            >
              <span>Seguinte</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
