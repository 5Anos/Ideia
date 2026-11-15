import crypto from 'node:crypto';
import type { IntegrationItem, SubscriptionPlan } from '../../../shared/types.ts';
import { getAIProvidersStatus } from '../../aiProvider.ts';
import { parseJsonCell, WORKSHEET_NAMES } from '../sheetSchema.ts';
import { TenantSheetRepository } from './baseRepository.ts';

export const BUSINESS_INTEGRATIONS_SEED: Array<{
  provider_key: string;
  name: string;
  description: string;
  required_credentials: string[];
  capabilities: string[];
  documentation_summary: string;
}> = [
  {
    provider_key: 'openai',
    name: 'OpenAI (GPT)',
    description: 'Fornecedor de modelos de linguagem alternativo preparado na camada de abstração.',
    required_credentials: ['OPENAI_API_KEY'],
    capabilities: ['Geração de texto', 'Chamada estruturada de ferramentas'],
    documentation_summary: 'Defina OPENAI_API_KEY nas variáveis do servidor para ativar.',
  },
  {
    provider_key: 'anthropic',
    name: 'Anthropic (Claude)',
    description: 'Fornecedor Claude preparado para execução de agentes empresariais.',
    required_credentials: ['ANTHROPIC_API_KEY'],
    capabilities: ['Análise documental extensa', 'Raciocínio estruturado'],
    documentation_summary: 'Defina ANTHROPIC_API_KEY nas variáveis do servidor para ativar.',
  },
  {
    provider_key: 'erp_sap_phc',
    name: 'ERP / Contabilidade (PHC, Primavera, SAP)',
    description: 'Conector para consulta de fornecedores, encomendas e centros de custo.',
    required_credentials: ['ERP_BASE_URL', 'ERP_API_TOKEN'],
    capabilities: ['Ler fornecedores', 'Submeter rascunhos de encomenda', 'Consultar faturas'],
    documentation_summary: 'Configure o endpoint REST do ERP e o token de serviço no cofre da empresa.',
  },
  {
    provider_key: 'crm_hubspot',
    name: 'CRM Comercial (HubSpot / Salesforce)',
    description: 'Sincronização de leads, contactos e notas de acompanhamento comercial.',
    required_credentials: ['CRM_CLIENT_ID', 'CRM_ACCESS_TOKEN'],
    capabilities: ['Ler oportunidades', 'Registar notas comerciais'],
    documentation_summary: 'Associe a aplicação OAuth do CRM para autorizar leitura governada.',
  },
  {
    provider_key: 'email_smtp',
    name: 'Email Corporativo (SMTP / Microsoft 365 / Google Workspace)',
    description: 'Envio de comunicações externas sujeitas a aprovação humana.',
    required_credentials: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'],
    capabilities: ['Preparar rascunhos', 'Enviar email após aprovação'],
    documentation_summary: 'Configure o servidor SMTP ou OAuth corporativo antes de autorizar envios externos.',
  },
  {
    provider_key: 'webhooks',
    name: 'Webhooks Empresariais Assinados',
    description: 'Notificações em tempo real de decisões BLOCKED e aprovações humanas.',
    required_credentials: ['WEBHOOK_ENDPOINT_URL', 'WEBHOOK_HMAC_SECRET'],
    capabilities: ['Disparar alertas HMAC-SHA256', 'Integrar sistemas externos'],
    documentation_summary: 'Indique o URL HTTPS recetor e valide a assinatura X-Mandato-Signature.',
  },
  {
    provider_key: 'google_gemini',
    name: 'Google Gemini API',
    description: 'Motor principal de IA da MANDATO para geração de instruções e simulação de agentes.',
    required_credentials: ['GEMINI_API_KEY'],
    capabilities: ['Criação assistida de agentes', 'Simulação controlada'],
    documentation_summary: 'Configurado via GEMINI_API_KEY nas variáveis de ambiente do servidor.',
  },
];

export class UsersAndSettingsRepository {
  private readonly companyId: string;
  private readonly companyRepo: TenantSheetRepository;
  private readonly usersRepo: TenantSheetRepository;
  private readonly membersRepo: TenantSheetRepository;
  private readonly integrationsRepo: TenantSheetRepository;
  private readonly notificationsRepo: TenantSheetRepository;

  constructor(companyId: string) {
    this.companyId = companyId;
    this.companyRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.CompanySettings);
    this.usersRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.Users);
    this.membersRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.CompanyMembers);
    this.integrationsRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.Integrations);
    this.notificationsRepo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.Notifications);
  }

  async upsertCompanySettings(company: {
    name: string;
    slug: string;
    nif: string;
    sector: string;
    subscription_plan: SubscriptionPlan;
    is_demo: boolean;
    retention_days: number;
    created_at: string;
    updated_at: string;
  }): Promise<void> {
    const existing = await this.companyRepo.findById(this.companyId);
    if (existing) {
      await this.companyRepo.update(this.companyId, company);
    } else {
      await this.companyRepo.insert({
        id: this.companyId,
        company_id: this.companyId,
        ...company,
      });
    }
  }

  async syncUserAndMemberRow(member: {
    memberId: string;
    userId: string;
    email: string;
    fullName: string;
    jobTitle: string;
    role: string;
    status: string;
    createdAt: string;
  }): Promise<void> {
    const existingUser = await this.usersRepo.findById(member.userId);
    const now = new Date().toISOString();
    if (!existingUser) {
      await this.usersRepo.insert({
        id: member.userId,
        company_id: this.companyId,
        email: member.email,
        full_name: member.fullName,
        job_title: member.jobTitle,
        avatar_initials: member.fullName.slice(0, 2).toUpperCase(),
        created_at: member.createdAt,
        updated_at: now,
      });
    }
    const existingMem = await this.membersRepo.findById(member.memberId);
    if (!existingMem) {
      await this.membersRepo.insert({
        id: member.memberId,
        company_id: this.companyId,
        user_id: member.userId,
        email: member.email,
        full_name: member.fullName,
        job_title: member.jobTitle,
        role: member.role,
        status: member.status,
        created_at: member.createdAt,
        updated_at: now,
      });
    } else {
      await this.membersRepo.update(member.memberId, {
        role: member.role,
        status: member.status,
        updated_at: now,
      });
    }
  }

  async ensureDefaultIntegrations(): Promise<void> {
    const existing = await this.integrationsRepo.findAll();
    if (existing.length > 0) return;

    const now = new Date().toISOString();
    const rows = BUSINESS_INTEGRATIONS_SEED.map((item) => ({
      id: crypto.randomUUID(),
      company_id: this.companyId,
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
    await this.integrationsRepo.batchInsert(rows);
  }

  async listIntegrations(): Promise<IntegrationItem[]> {
    const rows = await this.integrationsRepo.findAll();
    const providers = getAIProvidersStatus();
    const aiStatusMap = new Map<string, (typeof providers)[number]>(
      providers.map((p) => [p.provider_key, p])
    );

    return rows
      .map((r) => {
        const key = r.provider_key;
        const aiInfo = aiStatusMap.get(key);
        return {
          id: r.id,
          company_id: r.company_id || this.companyId,
          provider_key: key,
          name: r.name,
          category: (r.category as IntegrationItem['category']) || 'business_system',
          description: r.description,
          status: (aiInfo ? (aiInfo.configured ? 'configured' : 'not_configured') : r.status) as IntegrationItem['status'],
          required_credentials: parseJsonCell<string[]>(r.required_credentials_json, []),
          capabilities: parseJsonCell<string[]>(r.capabilities_json, []),
          documentation_summary: r.documentation_summary,
          models: aiInfo?.models,
        };
      })
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  async createNotification(input: { userId?: string; title: string; message: string; severity: 'info' | 'warning' | 'critical' }): Promise<void> {
    await this.notificationsRepo.insert({
      id: crypto.randomUUID(),
      company_id: this.companyId,
      user_id: input.userId || '',
      title: input.title,
      message: input.message,
      severity: input.severity,
      read_at: '',
      created_at: new Date().toISOString(),
    });
  }
}
