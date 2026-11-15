import type {
  Agent,
  AgentTool,
  AuthorizationDecision,
  Policy,
  RiskLevel,
} from '../shared/types.ts';
import { detectPromptInjection } from './security.ts';

export interface AuthorizationEvaluationInput {
  agent: Pick<Agent, 'id' | 'company_id' | 'name' | 'status' | 'security_status' | 'permissions_summary'>;
  agentTools: AgentTool[];
  policies: Policy[];
  request: {
    action_type: string;
    tool_name?: string | null;
    description: string;
    amount?: number | null;
    currency?: string | null;
    resource_id?: string | null;
    destination_verified?: boolean;
    target_company_id?: string | null;
  };
}

export interface AuthorizationEvaluationResult {
  decision: AuthorizationDecision;
  reason: string;
  matchedPolicy: Policy | null;
  riskLevel: RiskLevel;
  isAbsoluteBlock: boolean;
  securityIncident: boolean;
}

const ALWAYS_FORBIDDEN_ACTIONS = new Set([
  'bank_details_update',
  'change_bank_details',
  'modify_own_policy',
  'update_policy_self',
  'cross_tenant_access',
  'arbitrary_shell_exec',
  'execute_payment_direct',
  'sign_contract',
]);

const READ_ONLY_SAFE_ACTIONS = new Set([
  'read_info',
  'read_supplier',
  'search_documents',
  'analyze_files',
  'generate_report',
  'draft_message',
  'compare_prices',
]);

/**
 * Motor de Autorização e Governação MANDATO.
 * Regra base: Default to deny. O resultado mais restritivo prevalece sempre.
 */
export function evaluateAuthorization(input: AuthorizationEvaluationInput): AuthorizationEvaluationResult {
  const { agent, agentTools, policies, request } = input;
  const actionType = (request.action_type || '').trim().toLowerCase();
  const amount = typeof request.amount === 'number' && !Number.isNaN(request.amount) ? request.amount : null;
  const description = request.description || '';

  // 1. Verificar tentativa de acesso cross-tenant
  if (request.target_company_id && request.target_company_id !== agent.company_id) {
    return {
      decision: 'BLOCKED',
      reason: 'Violação de isolamento multi-empresa: um agente não pode aceder a dados de outra empresa.',
      matchedPolicy: null,
      riskLevel: 'critical',
      isAbsoluteBlock: true,
      securityIncident: true,
    };
  }

  // 2. Verificar deteção de Prompt Injection / tentativa de contornar políticas
  const injectionCheck = detectPromptInjection(`${actionType} ${description}`);
  if (injectionCheck.detected) {
    return {
      decision: 'BLOCKED',
      reason: 'Ação bloqueada por deteção de tentativa de manipulação de instruções ou contorno de políticas.',
      matchedPolicy: null,
      riskLevel: 'critical',
      isAbsoluteBlock: true,
      securityIncident: true,
    };
  }

  // 3. Verificar estado operacional e de segurança do agente
  if (agent.status === 'suspended' || agent.status === 'archived') {
    return {
      decision: 'BLOCKED',
      reason: `O agente encontra-se no estado "${agent.status}" e não tem permissão para executar ações.`,
      matchedPolicy: null,
      riskLevel: 'high',
      isAbsoluteBlock: true,
      securityIncident: false,
    };
  }

  if (agent.security_status === 'credentials_suspended') {
    return {
      decision: 'BLOCKED',
      reason: 'As credenciais deste agente estão suspensas.',
      matchedPolicy: null,
      riskLevel: 'high',
      isAbsoluteBlock: true,
      securityIncident: true,
    };
  }

  // 4. Restrições absolutas de segurança (nunca podem ser ultrapassadas por aprovação humana)
  if (ALWAYS_FORBIDDEN_ACTIONS.has(actionType)) {
    const absPolicy = policies.find(
      (p) => p.status === 'active' && p.action_type === actionType && p.is_absolute_restriction
    ) ?? null;

    const reasonMap: Record<string, string> = {
      bank_details_update: 'Restrição absoluta: agentes não podem alterar dados bancários ou IBAN de fornecedores.',
      change_bank_details: 'Restrição absoluta: agentes não podem alterar dados bancários ou IBAN de fornecedores.',
      modify_own_policy: 'Restrição absoluta: um agente nunca pode modificar as suas próprias políticas de autorização.',
      update_policy_self: 'Restrição absoluta: um agente nunca pode modificar as suas próprias políticas de autorização.',
      cross_tenant_access: 'Restrição absoluta: acesso interdito a informação de outra empresa.',
      arbitrary_shell_exec: 'Restrição absoluta: execução arbitrária de comandos de sistema é proibida.',
      execute_payment_direct: 'Restrição absoluta: pagamentos diretos irreversíveis são proibidos a agentes no MVP.',
      sign_contract: 'Restrição absoluta: assinatura de contratos por agentes é proibida.',
    };

    return {
      decision: 'BLOCKED',
      reason: reasonMap[actionType] ?? 'Ação bloqueada por restrição absoluta de segurança.',
      matchedPolicy: absPolicy,
      riskLevel: 'critical',
      isAbsoluteBlock: true,
      securityIncident: actionType === 'modify_own_policy' || actionType === 'arbitrary_shell_exec',
    };
  }

  // 5. Validar lista explícita de ações sempre bloqueadas na configuração do agente
  const agentBlocked = agent.permissions_summary?.always_blocked_actions ?? [];
  if (agentBlocked.includes(actionType)) {
    return {
      decision: 'BLOCKED',
      reason: `A ação "${actionType}" está explicitamente bloqueada na configuração de permissões do agente.`,
      matchedPolicy: null,
      riskLevel: 'high',
      isAbsoluteBlock: true,
      securityIncident: false,
    };
  }

  // 6. Validar ferramenta invocada contra allowlist explícita do agente
  if (request.tool_name) {
    const tool = agentTools.find(
      (t) => t.tool_key === request.tool_name || t.tool_name.toLowerCase() === request.tool_name!.toLowerCase()
    );
    if (!tool) {
      return {
        decision: 'BLOCKED',
        reason: `Ferramenta "${request.tool_name}" não autorizada ou inexistente na allowlist do agente.`,
        matchedPolicy: null,
        riskLevel: 'high',
        isAbsoluteBlock: true,
        securityIncident: true,
      };
    }
    if (!tool.is_enabled) {
      return {
        decision: 'BLOCKED',
        reason: `A ferramenta "${tool.tool_name}" está desativada para este agente.`,
        matchedPolicy: null,
        riskLevel: 'high',
        isAbsoluteBlock: false,
        securityIncident: false,
      };
    }
  }

  // 7. Verificar valores negativos inválidos
  if (amount !== null && amount < 0) {
    return {
      decision: 'BLOCKED',
      reason: 'Valor financeiro inválido (negativo). Pedido rejeitado por segurança.',
      matchedPolicy: null,
      riskLevel: 'high',
      isAbsoluteBlock: true,
      securityIncident: true,
    };
  }

  // 8. Reembolso para destino não verificado
  if (actionType === 'refund' && request.destination_verified === false) {
    return {
      decision: 'BLOCKED',
      reason: 'Reembolsos para destinos não verificados são automaticamente bloqueados.',
      matchedPolicy:
        policies.find((p) => p.status === 'active' && p.action_type === 'refund') ?? null,
      riskLevel: 'high',
      isAbsoluteBlock: true,
      securityIncident: false,
    };
  }

  // 9. Avaliar todas as políticas ativas aplicáveis (resolução mais restritiva prevalece!)
  const applicablePolicies = policies.filter(
    (p) => p.status === 'active' && (p.action_type === actionType || p.action_type === '*')
  );

  if (applicablePolicies.length === 0) {
    // Ações de leitura segura podem ser permitidas se o agente tiver permissão de leitura e não estiver em needs_policy
    if (READ_ONLY_SAFE_ACTIONS.has(actionType)) {
      return {
        decision: 'ALLOWED',
        reason: `Ação de leitura/rascunho "${actionType}" permitida sem necessidade de aprovação financeira.`,
        matchedPolicy: null,
        riskLevel: 'low',
        isAbsoluteBlock: false,
        securityIncident: false,
      };
    }

    // Default to deny!
    return {
      decision: 'BLOCKED',
      reason: `Ação "${actionType}" bloqueada por omissão (Default-to-Deny): não existe política ativa que a autorize.`,
      matchedPolicy: null,
      riskLevel: 'high',
      isAbsoluteBlock: false,
      securityIncident: false,
    };
  }

  // Avaliar cada política e aplicar o resultado mais restritivo (BLOCKED > REQUIRES_APPROVAL > ALLOWED)
  let strictestResult: AuthorizationEvaluationResult | null = null;
  const severityRank: Record<AuthorizationDecision, number> = {
    ALLOWED: 1,
    REQUIRES_APPROVAL: 2,
    BLOCKED: 3,
  };

  for (const policy of applicablePolicies) {
    let candidate: AuthorizationEvaluationResult;

    if (policy.rule_type === 'block_always' || policy.is_absolute_restriction) {
      candidate = {
        decision: 'BLOCKED',
        reason: `Bloqueado pela política "${policy.name}": ${policy.description}`,
        matchedPolicy: policy,
        riskLevel: 'critical',
        isAbsoluteBlock: policy.is_absolute_restriction,
        securityIncident: false,
      };
    } else if (policy.rule_type === 'financial_threshold') {
      if (amount === null) {
        candidate = {
          decision: 'REQUIRES_APPROVAL',
          reason: `A política "${policy.name}" exige indicação de valor financeiro ou validação humana.`,
          matchedPolicy: policy,
          riskLevel: 'medium',
          isAbsoluteBlock: false,
          securityIncident: false,
        };
      } else {
        const autoLimit = policy.max_auto_amount ?? 0;
        const approvalLimit = policy.max_approval_amount;

        if (amount <= autoLimit) {
          // Respeitar também o limite do agente se for mais restritivo
          const agentLimit = agent.permissions_summary?.max_auto_financial_limit_eur;
          if (typeof agentLimit === 'number' && amount > agentLimit) {
            candidate = {
              decision: 'REQUIRES_APPROVAL',
              reason: `Valor €${amount.toFixed(2)} excede o limite automático do agente (€${agentLimit.toFixed(2)}). Aprovação humana obrigatória.`,
              matchedPolicy: policy,
              riskLevel: 'medium',
              isAbsoluteBlock: false,
              securityIncident: false,
            };
          } else {
            candidate = {
              decision: 'ALLOWED',
              reason: `Autorizado automaticamente pela política "${policy.name}" (valor €${amount.toFixed(2)} dentro do limite de €${autoLimit.toFixed(2)}).`,
              matchedPolicy: policy,
              riskLevel: 'low',
              isAbsoluteBlock: false,
              securityIncident: false,
            };
          }
        } else if (approvalLimit === null || amount <= approvalLimit || policy.conditions?.exception_approved) {
          candidate = {
            decision: 'REQUIRES_APPROVAL',
            reason: `Valor €${amount.toFixed(2)} excede o limite automático de €${autoLimit.toFixed(2)} da política "${policy.name}". Requer aprovação de gestor.`,
            matchedPolicy: policy,
            riskLevel: amount > 500 ? 'high' : 'medium',
            isAbsoluteBlock: false,
            securityIncident: false,
          };
        } else {
          candidate = {
            decision: 'BLOCKED',
            reason: `Valor €${amount.toFixed(2)} excede o teto máximo permitido de €${approvalLimit.toFixed(2)} na política "${policy.name}". Bloqueado sem exceção autorizada.`,
            matchedPolicy: policy,
            riskLevel: 'high',
            isAbsoluteBlock: false,
            securityIncident: false,
          };
        }
      }
    } else if (policy.rule_type === 'require_approval') {
      candidate = {
        decision: 'REQUIRES_APPROVAL',
        reason: `Aprovação humana obrigatória pela política "${policy.name}".`,
        matchedPolicy: policy,
        riskLevel: 'medium',
        isAbsoluteBlock: false,
        securityIncident: false,
      };
    } else {
      // allow_if_verified
      if (policy.conditions?.require_verified_destination && request.destination_verified === false) {
        candidate = {
          decision: 'BLOCKED',
          reason: `Bloqueado pela política "${policy.name}": destino não verificado.`,
          matchedPolicy: policy,
          riskLevel: 'high',
          isAbsoluteBlock: true,
          securityIncident: false,
        };
      } else {
        candidate = {
          decision: 'ALLOWED',
          reason: `Autorizado pela política "${policy.name}".`,
          matchedPolicy: policy,
          riskLevel: 'low',
          isAbsoluteBlock: false,
          securityIncident: false,
        };
      }
    }

    if (!strictestResult || severityRank[candidate.decision] > severityRank[strictestResult.decision]) {
      strictestResult = candidate;
    }
  }

  return (
    strictestResult ?? {
      decision: 'BLOCKED',
      reason: 'Ação bloqueada por omissão.',
      matchedPolicy: null,
      riskLevel: 'high',
      isAbsoluteBlock: false,
      securityIncident: false,
    }
  );
}
