import crypto from 'node:crypto';
import type { AgentInstructions, AgentPermissionsConfig } from '../../shared/types.ts';
import { TOOL_CATALOG } from '../seedTemplates.ts';
import { generateAgentCredential } from '../security.ts';
import { WORKSHEET_NAMES } from './sheetSchema.ts';
import { executeSerializedMultiSheetWrite } from './repositories/baseRepository.ts';
import { BUSINESS_INTEGRATIONS_SEED } from './repositories/usersRepository.ts';
import { listMembersForCompany, registerAgentCredentialRoute, type TenantRegistryRecord } from './tenantRegistry.ts';

/**
 * Inicializa as abas base da folha de cálculo de uma nova empresa
 * (CompanySettings, Users, CompanyMembers, Política de Proteção Bancária, Integrações, Registo Inicial).
 */
export async function initializeCompanySpreadsheetBaseline(
  tenant: TenantRegistryRecord,
  actorUserId: string,
  actorName: string
): Promise<void> {
  const now = new Date().toISOString();
  const members = listMembersForCompany(tenant.company_id);

  const userRows = members.map((m) => ({
    id: m.user_id,
    company_id: tenant.company_id,
    email: m.email,
    full_name: m.full_name,
    job_title: m.job_title,
    avatar_initials: m.full_name.slice(0, 2).toUpperCase(),
    created_at: m.created_at,
    updated_at: now,
  }));

  const memberRows = members.map((m) => ({
    id: m.id,
    company_id: tenant.company_id,
    user_id: m.user_id,
    email: m.email,
    full_name: m.full_name,
    job_title: m.job_title,
    role: m.role,
    status: m.status,
    created_at: m.created_at,
    updated_at: now,
  }));

  const integrationRows = BUSINESS_INTEGRATIONS_SEED.map((item) => ({
    id: crypto.randomUUID(),
    company_id: tenant.company_id,
    provider_key: item.provider_key,
    name: item.name,
    category:
      item.provider_key === 'google_gemini' ||
      item.provider_key === 'openai' ||
      item.provider_key === 'anthropic'
        ? 'ai_provider'
        : 'business_system',
    description: item.description,
    status: 'not_configured',
    required_credentials_json: JSON.stringify(item.required_credentials),
    capabilities_json: JSON.stringify(item.capabilities),
    documentation_summary: item.documentation_summary,
    created_at: now,
    updated_at: now,
  }));

  await executeSerializedMultiSheetWrite(tenant.company_id, [
    {
      worksheet: WORKSHEET_NAMES.CompanySettings,
      inserts: [
        {
          id: tenant.company_id,
          company_id: tenant.company_id,
          name: tenant.company_name,
          slug: tenant.slug,
          nif: tenant.nif,
          sector: tenant.sector,
          subscription_plan: tenant.subscription_plan,
          is_demo: tenant.is_demo,
          retention_days: tenant.retention_days,
          created_at: tenant.created_at,
          updated_at: now,
        },
      ],
    },
    { worksheet: WORKSHEET_NAMES.Users, inserts: userRows },
    { worksheet: WORKSHEET_NAMES.CompanyMembers, inserts: memberRows },
    {
      worksheet: WORKSHEET_NAMES.Policies,
      inserts: [
        {
          id: `pol-bank-${tenant.company_id.slice(0, 8)}`,
          company_id: tenant.company_id,
          name: 'Proteção Absoluta de Dados Bancários',
          description: 'Proibição absoluta de alteração de IBAN ou contas bancárias por agentes.',
          action_type: 'bank_details_update',
          rule_type: 'block_always',
          max_auto_amount: '',
          max_approval_amount: '',
          currency: 'EUR',
          conditions_json: '{}',
          is_absolute_restriction: true,
          status: 'active',
          is_demo: tenant.is_demo,
          created_at: now,
          updated_at: now,
        },
      ],
    },
    { worksheet: WORKSHEET_NAMES.Integrations, inserts: integrationRows },
    {
      worksheet: WORKSHEET_NAMES.AuditLogs,
      inserts: [
        {
          id: crypto.randomUUID(),
          company_id: tenant.company_id,
          actor_type: 'user',
          actor_id: actorUserId,
          actor_name: actorName,
          event_type: 'spreadsheet_initialized',
          action: 'Inicialização da folha de cálculo Google Sheets da empresa',
          result: 'Sucesso',
          reason: `Base de dados isolada inicializada na conta ${tenant.verified_google_email || 'Google'}.`,
          related_policy: '',
          metadata_json: JSON.stringify({ spreadsheet_id: tenant.spreadsheet_id }),
          is_demo: tenant.is_demo,
          created_at: now,
        },
      ],
    },
  ]);

  if (tenant.is_demo) {
    await seedDemoOperationalDataInSpreadsheet(tenant);
  }
}

async function seedDemoOperationalDataInSpreadsheet(tenant: TenantRegistryRecord): Promise<void> {
  const companyId = tenant.company_id;
  const now = new Date().toISOString();
  const daysAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

  const pol1 = 'pol-demo-1';
  const pol2 = 'pol-demo-2';
  const pol3 = 'pol-demo-3';
  const pol4 = 'pol-demo-4';
  const pol5 = 'pol-demo-5';

  const policies = [
    {
      id: pol1,
      company_id: companyId,
      name: 'Limite de Compras Operacionais',
      description: 'Compras até €300 autorizadas automaticamente; entre €300 e €1.000 requerem aprovação humana.',
      action_type: 'purchase_order',
      rule_type: 'financial_threshold',
      max_auto_amount: 300,
      max_approval_amount: 1000,
      currency: 'EUR',
      conditions_json: '{}',
      is_absolute_restriction: false,
      status: 'active',
      is_demo: true,
      created_at: daysAgoIso(12),
      updated_at: now,
    },
    {
      id: pol2,
      company_id: companyId,
      name: 'Política de Reembolsos a Clientes',
      description: 'Reembolsos até €50 automáticos se destino verificado; entre €50 e €500 requerem aprovação.',
      action_type: 'refund',
      rule_type: 'financial_threshold',
      max_auto_amount: 50,
      max_approval_amount: 500,
      currency: 'EUR',
      conditions_json: JSON.stringify({ require_verified_destination: true }),
      is_absolute_restriction: false,
      status: 'active',
      is_demo: true,
      created_at: daysAgoIso(12),
      updated_at: now,
    },
    {
      id: pol3,
      company_id: companyId,
      name: 'Alteração de Dados Bancários Proibida',
      description: 'Restrição absoluta: nenhum agente pode alterar IBAN ou contas bancárias de fornecedores.',
      action_type: 'bank_details_update',
      rule_type: 'block_always',
      max_auto_amount: '',
      max_approval_amount: '',
      currency: 'EUR',
      conditions_json: '{}',
      is_absolute_restriction: true,
      status: 'active',
      is_demo: true,
      created_at: daysAgoIso(12),
      updated_at: now,
    },
    {
      id: pol4,
      company_id: companyId,
      name: 'Comunicações Externas com Revisão',
      description: 'Qualquer envio de mensagem externa a clientes ou fornecedores requer aprovação humana.',
      action_type: 'send_message',
      rule_type: 'require_approval',
      max_auto_amount: '',
      max_approval_amount: '',
      currency: 'EUR',
      conditions_json: '{}',
      is_absolute_restriction: false,
      status: 'active',
      is_demo: true,
      created_at: daysAgoIso(10),
      updated_at: now,
    },
    {
      id: pol5,
      company_id: companyId,
      name: 'Consulta Segura de Fornecedores',
      description: 'Leitura autorizada do catálogo de fornecedores homologados.',
      action_type: 'read_supplier',
      rule_type: 'allow_if_verified',
      max_auto_amount: '',
      max_approval_amount: '',
      currency: 'EUR',
      conditions_json: '{}',
      is_absolute_restriction: false,
      status: 'active',
      is_demo: true,
      created_at: daysAgoIso(10),
      updated_at: now,
    },
  ];

  const makePerms = (autoLim: number, apprLim: number): AgentPermissionsConfig => ({
    read_permissions: ['fornecedores', 'faturas', 'tickets'],
    write_permissions: ['rascunhos', 'tarefas'],
    max_auto_financial_limit_eur: autoLim,
    max_approval_financial_limit_eur: apprLim,
    allowed_resources: ['erp_catalogo', 'documentos'],
    restricted_resources: ['contas_bancarias', 'salarios'],
    actions_requiring_approval: ['purchase_order', 'refund', 'send_message'],
    always_blocked_actions: ['bank_details_update', 'sign_contract'],
  });

  const makeInst = (role: string, objective: string): AgentInstructions => ({
    role,
    objective,
    responsibilities: ['Analisar pedidos operacionais', 'Respeitar os limites definidos pela direção'],
    behaviour: 'Transparente, cauteloso e auditável',
    communication_style: 'Português Europeu formal e objetivo',
    rules: ['Submeter todas as despesas acima do teto automático para aprovação humana'],
    restrictions: ['Nunca alterar dados bancários', 'Nunca contornar políticas de governação'],
    expected_output: 'Parecer estruturado com montante em EUR e ação recomendada.',
  });

  const demoAgentsSpec = [
    {
      id: 'ag-demo-compras',
      name: 'Agente de Compras e Fornecedores',
      description: 'Compara cotações, consulta fornecedores e prepara ordens de compra até €1.000.',
      category: 'Compras',
      objective: 'Otimizar compras operacionais respeitando tetos financeiros em EUR.',
      origin: 'MANDATO',
      provider: 'Google Gemini',
      model: 'gemini-4-hydrogen',
      externalId: '',
      status: 'running',
      sec: 'protected',
      icon: 'shopping-cart',
      inst: makeInst('Especialista de Aprovisionamento', 'Comparar propostas e submeter encomendas governadas.'),
      perms: makePerms(300, 1000),
      actions: 42,
      lastAct: daysAgoIso(0),
      pols: [pol1, pol3, pol5],
      tools: ['consultar_fornecedores', 'analisar_ficheiros', 'submeter_encomenda'],
    },
    {
      id: 'ag-demo-faturacao',
      name: 'Agente de Triagem de Faturas',
      description: 'Valida faturas recebidas, extrai NIFs e prepara reconciliações financeiras.',
      category: 'Financeiro',
      objective: 'Detetar divergências entre faturas e notas de encomenda.',
      origin: 'MANDATO',
      provider: 'Google Gemini',
      model: 'gemini-4-hydrogen',
      externalId: '',
      status: 'active',
      sec: 'protected',
      icon: 'file-text',
      inst: makeInst('Analista de Faturação', 'Conferir faturas e sinalizar desvios acima de €50.'),
      perms: makePerms(50, 500),
      actions: 29,
      lastAct: daysAgoIso(1),
      pols: [pol2, pol3],
      tools: ['analisar_ficheiros', 'gerar_relatorios', 'processar_reembolso'],
    },
    {
      id: 'ag-demo-apoio',
      name: 'Agente de Apoio ao Cliente',
      description: 'Classifica reclamações de clientes e encaminha pedidos de reembolso e resposta externa.',
      category: 'Atendimento ao Cliente',
      objective: 'Reduzir tempo de resposta com supervisão em reembolsos e emails.',
      origin: 'MANDATO',
      provider: 'Google Gemini',
      model: 'gemini-4-hydrogen',
      externalId: '',
      status: 'active',
      sec: 'protected',
      icon: 'headphones',
      inst: makeInst('Assistente de Apoio ao Cliente', 'Analisar pedidos e preparar respostas para validação.'),
      perms: makePerms(50, 250),
      actions: 31,
      lastAct: daysAgoIso(1),
      pols: [pol2, pol4],
      tools: ['consultar_informacao', 'preparar_emails', 'enviar_email_externo', 'processar_reembolso'],
    },
    {
      id: 'ag-demo-externo-erp',
      name: 'Conector Externo ERP Primavera',
      description: 'Agente externo registado via REST Gateway para sincronização controlada de encomendas.',
      category: 'Compras',
      objective: 'Submeter pedidos de autorização externos antes de emitir encomendas no ERP.',
      origin: 'EXTERNAL',
      provider: 'Integração Externa REST',
      model: 'external-webhook-v1',
      externalId: 'erp-primavera-prod-01',
      status: 'active',
      sec: 'protected',
      icon: 'plug',
      inst: makeInst('Gateway ERP Externo', 'Validar cada encomenda externa junto do motor MANDATO.'),
      perms: makePerms(300, 1000),
      actions: 18,
      lastAct: daysAgoIso(2),
      pols: [pol1, pol3],
      tools: ['consultar_apis', 'submeter_encomenda'],
    },
  ];

  const agentInserts: Array<Record<string, unknown>> = [];
  const versionInserts: Array<Record<string, unknown>> = [];
  const credInserts: Array<Record<string, unknown>> = [];
  const toolInserts: Array<Record<string, unknown>> = [];
  const assignInserts: Array<Record<string, unknown>> = [];

  for (const ag of demoAgentsSpec) {
    agentInserts.push({
      id: ag.id,
      company_id: companyId,
      name: ag.name,
      description: ag.description,
      category: ag.category,
      objective: ag.objective,
      origin: ag.origin,
      provider: ag.provider,
      model: ag.model,
      external_identifier: ag.externalId,
      status: ag.status,
      security_status: ag.sec,
      avatar_icon: ag.icon,
      instructions_json: JSON.stringify(ag.inst),
      permissions_summary_json: JSON.stringify(ag.perms),
      actions_count: ag.actions,
      last_activity_at: ag.lastAct,
      is_demo: true,
      created_by: 'usr-demo-owner',
      created_at: daysAgoIso(10),
      updated_at: now,
    });

    versionInserts.push({
      id: crypto.randomUUID(),
      company_id: companyId,
      agent_id: ag.id,
      version_number: 1,
      instructions_json: JSON.stringify(ag.inst),
      model: ag.model,
      provider: ag.provider,
      created_by: 'usr-demo-owner',
      created_at: daysAgoIso(10),
    });

    const cred = generateAgentCredential(ag.origin === 'EXTERNAL' ? 'mdt_ext' : 'mdt_live');
    registerAgentCredentialRoute(cred.keyHash, companyId);
    credInserts.push({
      id: crypto.randomUUID(),
      company_id: companyId,
      agent_id: ag.id,
      key_prefix: cred.keyPrefix,
      key_hash: cred.keyHash,
      status: 'active',
      last_used_at: ag.lastAct,
      created_at: daysAgoIso(10),
    });

    for (const cat of TOOL_CATALOG) {
      const enabled = ag.tools.includes(cat.tool_key);
      toolInserts.push({
        id: crypto.randomUUID(),
        company_id: companyId,
        agent_id: ag.id,
        tool_key: cat.tool_key,
        tool_name: cat.tool_name,
        category: cat.category,
        risk_level: cat.risk_level,
        is_enabled: enabled,
        requires_approval: cat.default_requires_approval,
        created_at: daysAgoIso(10),
      });
    }

    for (const pid of ag.pols) {
      assignInserts.push({
        id: crypto.randomUUID(),
        company_id: companyId,
        policy_id: pid,
        agent_id: ag.id,
        created_at: daysAgoIso(10),
      });
    }
  }

  const wfId = 'wf-demo-compras';
  const workflowInserts = [
    {
      id: wfId,
      company_id: companyId,
      name: 'Fluxo de Compras com Aprovação Humana',
      description: 'Avalia fornecedores, valida limites financeiros e pausa para decisão de gestor acima de €300.',
      status: 'active',
      is_demo: true,
      created_at: daysAgoIso(8),
      updated_at: now,
    },
  ];
  const wfNodes = [
    { id: 'wfn-1', company_id: companyId, workflow_id: wfId, node_type: 'start', label: 'Início do Pedido', agent_id: '', config_json: '{}', position_x: 40, position_y: 120, created_at: daysAgoIso(8) },
    { id: 'wfn-2', company_id: companyId, workflow_id: wfId, node_type: 'agent_task', label: 'Consultar Fornecedores', agent_id: 'ag-demo-compras', config_json: JSON.stringify({ action_type: 'read_supplier', description: 'Consultar fornecedores homologados' }), position_x: 260, position_y: 120, created_at: daysAgoIso(8) },
    { id: 'wfn-3', company_id: companyId, workflow_id: wfId, node_type: 'agent_task', label: 'Submeter Nota de Encomenda', agent_id: 'ag-demo-compras', config_json: JSON.stringify({ action_type: 'purchase_order', amount: 500, description: 'Ordem de compra operacional' }), position_x: 480, position_y: 120, created_at: daysAgoIso(8) },
    { id: 'wfn-4', company_id: companyId, workflow_id: wfId, node_type: 'end', label: 'Conclusão do Fluxo', agent_id: '', config_json: '{}', position_x: 700, position_y: 120, created_at: daysAgoIso(8) },
  ];
  const wfEdges = [
    { id: 'wfe-1', company_id: companyId, workflow_id: wfId, source_node_id: 'wfn-1', target_node_id: 'wfn-2', condition_label: '', created_at: daysAgoIso(8) },
    { id: 'wfe-2', company_id: companyId, workflow_id: wfId, source_node_id: 'wfn-2', target_node_id: 'wfn-3', condition_label: '', created_at: daysAgoIso(8) },
    { id: 'wfe-3', company_id: companyId, workflow_id: wfId, source_node_id: 'wfn-3', target_node_id: 'wfn-4', condition_label: '', created_at: daysAgoIso(8) },
  ];

  const authDemo1 = 'auth-demo-1';
  const authDemo2 = 'auth-demo-2';
  const authDemo3 = 'auth-demo-3';

  const authRequests = [
    {
      id: authDemo1,
      company_id: companyId,
      agent_id: 'ag-demo-compras',
      action_type: 'purchase_order',
      tool_name: 'submeter_encomenda',
      description: 'Compra de equipamentos de rede para filial do Porto',
      amount: 640,
      currency: 'EUR',
      resource_id: 'po-2026-104',
      idempotency_key: 'demo-po-2026-104',
      decision: 'REQUIRES_APPROVAL',
      reason: 'Valor €640.00 excede o limite automático de €300.00. Requer aprovação de gestor.',
      policy_id: pol1,
      is_simulation: false,
      is_demo: true,
      created_at: daysAgoIso(1),
    },
    {
      id: authDemo2,
      company_id: companyId,
      agent_id: 'ag-demo-faturacao',
      action_type: 'bank_details_update',
      tool_name: 'alterar_dados_bancarios',
      description: 'Alteração de IBAN solicitada por email não verificado',
      amount: '',
      currency: 'EUR',
      resource_id: 'sup-883',
      idempotency_key: 'demo-bank-block-1',
      decision: 'BLOCKED',
      reason: 'Restrição absoluta: agentes não podem alterar dados bancários ou IBAN de fornecedores.',
      policy_id: pol3,
      is_simulation: false,
      is_demo: true,
      created_at: daysAgoIso(2),
    },
    {
      id: authDemo3,
      company_id: companyId,
      agent_id: 'ag-demo-compras',
      action_type: 'purchase_order',
      tool_name: 'submeter_encomenda',
      description: 'Reposição de consumíveis de escritório',
      amount: 145,
      currency: 'EUR',
      resource_id: 'po-2026-099',
      idempotency_key: 'demo-po-2026-099',
      decision: 'ALLOWED',
      reason: 'Autorizado automaticamente pela política "Limite de Compras Operacionais".',
      policy_id: pol1,
      is_simulation: false,
      is_demo: true,
      created_at: daysAgoIso(3),
    },
  ];

  const approvalInserts = [
    {
      id: 'apr-demo-1',
      company_id: companyId,
      authorization_request_id: authDemo1,
      agent_id: 'ag-demo-compras',
      requested_action: 'purchase_order',
      description: 'Compra de equipamentos de rede para filial do Porto (€640,00)',
      financial_value: 640,
      currency: 'EUR',
      policy_name: 'Limite de Compras Operacionais',
      risk_level: 'high',
      status: 'Pendente',
      info_requested_note: '',
      expires_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      workflow_execution_id: '',
      is_demo: true,
      created_at: daysAgoIso(1),
      updated_at: daysAgoIso(1),
    },
  ];

  await executeSerializedMultiSheetWrite(companyId, [
    { worksheet: WORKSHEET_NAMES.Policies, inserts: policies },
    { worksheet: WORKSHEET_NAMES.Agents, inserts: agentInserts },
    { worksheet: WORKSHEET_NAMES.AgentVersions, inserts: versionInserts },
    { worksheet: WORKSHEET_NAMES.AgentCredentials, inserts: credInserts },
    { worksheet: WORKSHEET_NAMES.AgentTools, inserts: toolInserts },
    { worksheet: WORKSHEET_NAMES.PolicyAssignments, inserts: assignInserts },
    { worksheet: WORKSHEET_NAMES.Workflows, inserts: workflowInserts },
    { worksheet: WORKSHEET_NAMES.WorkflowNodes, inserts: wfNodes },
    { worksheet: WORKSHEET_NAMES.WorkflowEdges, inserts: wfEdges },
    { worksheet: WORKSHEET_NAMES.AuthorizationRequests, inserts: authRequests },
    { worksheet: WORKSHEET_NAMES.ApprovalRequests, inserts: approvalInserts },
    {
      worksheet: WORKSHEET_NAMES.AuditLogs,
      inserts: [
        {
          id: crypto.randomUUID(),
          company_id: companyId,
          actor_type: 'agent',
          actor_id: 'ag-demo-faturacao',
          actor_name: 'Agente de Triagem de Faturas',
          event_type: 'blocked_action',
          action: 'Tentativa de alteração de IBAN bloqueada automaticamente',
          result: 'BLOCKED',
          reason: 'Restrição absoluta: alteração de dados bancários interdita a agentes.',
          related_policy: 'Alteração de Dados Bancários Proibida',
          metadata_json: '{}',
          is_demo: true,
          created_at: daysAgoIso(2),
        },
        {
          id: crypto.randomUUID(),
          company_id: companyId,
          actor_type: 'agent',
          actor_id: 'ag-demo-compras',
          actor_name: 'Agente de Compras e Fornecedores',
          event_type: 'authorization_decision',
          action: 'Submissão de encomenda €640,00 encaminhada para aprovação',
          result: 'REQUIRES_APPROVAL',
          reason: 'Valor superior ao limite automático de €300,00.',
          related_policy: 'Limite de Compras Operacionais',
          metadata_json: '{}',
          is_demo: true,
          created_at: daysAgoIso(1),
        },
      ],
    },
  ]);
}
