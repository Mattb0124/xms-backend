import { Injectable } from '@nestjs/common';
import type { AuditEventType } from '../../contracts/events.js';
import type { Queryable } from '../../db/session.js';
import { actorKindOf, type Principal } from '../auth/principal.js';

/**
 * The domain audit writer (Security & Tenancy 7, Audit & Analytics 4.3).
 * Every service writes its events through here, inside the transaction of
 * the change, so the audit guard trigger sees them and a rolled-back change
 * leaves no event behind. Account-scoped entities go to acct.audit_events;
 * operator entities (users, roles, groups, catalogs) to op.audit_events.
 */
export interface AuditActor {
  readonly kind: 'user' | 'portal_user' | 'api_client' | 'system' | 'ai';
  readonly id: string;
  readonly name?: string;
}

export interface AuditEntry {
  readonly entityKind: string;
  readonly entityId: string;
  readonly eventType: AuditEventType;
  readonly ticketId?: string;
  readonly field?: string;
  readonly oldValue?: unknown;
  readonly newValue?: unknown;
  readonly aiSuggestionId?: string;
}

export interface AuditContext {
  readonly requestId?: string;
  readonly correlationId?: string;
}

export const SYSTEM_ACTOR: AuditActor = { kind: 'system', id: 'system', name: 'XMS' };

export function actorOf(principal: Principal): AuditActor {
  return { kind: actorKindOf(principal), id: principal.userId, name: principal.displayName };
}

@Injectable()
export class AuditService {
  /** Account-scoped audit; the transaction must be bound to that account. */
  async account(
    tx: Queryable,
    accountId: string,
    actor: AuditActor,
    context: AuditContext,
    entries: readonly AuditEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      await tx.query(
        `insert into acct.audit_events
           (account_id, entity_kind, entity_id, ticket_id, event_type, field, old_value, new_value,
            actor_kind, actor_id, actor_name, correlation_id, request_id, ai_suggestion_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          accountId,
          entry.entityKind,
          entry.entityId,
          entry.ticketId ?? null,
          entry.eventType,
          entry.field ?? null,
          json(entry.oldValue),
          json(entry.newValue),
          actor.kind,
          actor.id,
          actor.name ?? null,
          context.correlationId ?? null,
          context.requestId ?? null,
          entry.aiSuggestionId ?? null,
        ],
      );
    }
  }

  /** Operator-scoped audit (no account). */
  async operator(
    tx: Queryable,
    actor: AuditActor,
    context: AuditContext,
    entries: readonly AuditEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      await tx.query(
        `insert into op.audit_events
           (entity_kind, entity_id, event_type, field, old_value, new_value, actor_kind, actor_id, actor_name,
            correlation_id, request_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          entry.entityKind,
          entry.entityId,
          entry.eventType,
          entry.field ?? null,
          json(entry.oldValue),
          json(entry.newValue),
          actor.kind,
          actor.id,
          actor.name ?? null,
          context.correlationId ?? null,
          context.requestId ?? null,
        ],
      );
    }
  }

  /** One entry per changed field (AIX activity diff pattern). */
  diff(
    entityKind: string,
    entityId: string,
    eventType: AuditEventType,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    fields: readonly string[],
    extra: Partial<AuditEntry> = {},
  ): AuditEntry[] {
    const entries: AuditEntry[] = [];
    for (const field of fields) {
      const previous = before[field];
      const next = after[field];
      if (JSON.stringify(previous ?? null) === JSON.stringify(next ?? null)) continue;
      entries.push({
        entityKind,
        entityId,
        eventType,
        field,
        oldValue: previous ?? null,
        newValue: next ?? null,
        ...extra,
      });
    }
    return entries;
  }
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
