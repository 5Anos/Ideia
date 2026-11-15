import crypto from 'node:crypto';
import type { AuditLogRecord } from '../../../shared/types.ts';
import { parseBoolCell, WORKSHEET_NAMES } from '../sheetSchema.ts';
import { TenantSheetRepository } from './baseRepository.ts';

export interface AppendAuditEventInput {
  actorType: 'user' | 'agent' | 'system';
  actorId: string;
  actorName: string;
  eventType: string;
  action: string;
  result: string;
  reason: string;
  relatedPolicy?: string | null;
  metadata?: Record<string, unknown>;
  isDemo?: boolean;
  createdAt?: string;
}

export class AuditRepository {
  private readonly repo: TenantSheetRepository;
  private readonly companyId: string;

  constructor(companyId: string) {
    this.companyId = companyId;
    this.repo = new TenantSheetRepository(companyId, WORKSHEET_NAMES.AuditLogs);
  }

  async appendAuditEvent(input: AppendAuditEventInput): Promise<AuditLogRecord> {
    const id = crypto.randomUUID();
    const createdAt = input.createdAt || new Date().toISOString();
    await this.repo.insert({
      id,
      company_id: this.companyId,
      actor_type: input.actorType,
      actor_id: input.actorId,
      actor_name: input.actorName,
      event_type: input.eventType,
      action: input.action,
      result: input.result,
      reason: input.reason,
      related_policy: input.relatedPolicy ?? '',
      metadata_json: JSON.stringify(input.metadata ?? {}),
      is_demo: Boolean(input.isDemo),
      created_at: createdAt,
    });

    return {
      id,
      company_id: this.companyId,
      actor_type: input.actorType,
      actor_id: input.actorId,
      actor_name: input.actorName,
      event_type: input.eventType,
      action: input.action,
      result: input.result,
      reason: input.reason,
      related_policy: input.relatedPolicy ?? null,
      is_demo: Boolean(input.isDemo),
      created_at: createdAt,
    };
  }

  async listAuditLogs(limit = 300): Promise<AuditLogRecord[]> {
    const rows = await this.repo.findAll();
    return rows
      .map((r) => ({
        id: r.id,
        company_id: r.company_id || this.companyId,
        actor_type: (r.actor_type as AuditLogRecord['actor_type']) || 'system',
        actor_id: r.actor_id,
        actor_name: r.actor_name,
        event_type: r.event_type,
        action: r.action,
        result: r.result,
        reason: r.reason,
        related_policy: r.related_policy || null,
        is_demo: parseBoolCell(r.is_demo),
        created_at: r.created_at,
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }
}
