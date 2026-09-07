import { Injectable, Logger } from '@nestjs/common';
import type { ActorKind, Outcome, PrincipalKind, SecurityEventType } from '../../contracts/events.js';
import { DbPools } from '../../db/pool.js';
import type { Queryable } from '../../db/session.js';

/**
 * Writer for the security stream (Audit & Analytics 4.1, 5.1). Guard and
 * data-layer decisions are written on the app pool outside any account
 * binding (sys.security_events has no RLS); administrative changes pass
 * their transaction so the event commits with the change.
 */
export interface SecurityEvent {
  readonly type: SecurityEventType;
  readonly outcome: Outcome;
  readonly accountId?: string | null;
  readonly actorKind: ActorKind;
  readonly actorId?: string;
  readonly actorName?: string;
  readonly principalKind?: PrincipalKind;
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly entityKind?: string;
  readonly entityId?: string;
  readonly attrs?: Record<string, unknown>;
  readonly ipHash?: string;
  readonly userAgentFamily?: string;
}

export interface SecurityEventSink {
  write(event: SecurityEvent, tx?: Queryable): Promise<void>;
}

const INSERT = `insert into sys.security_events
  (event_type, outcome, account_id, actor_kind, actor_id, actor_name, principal_kind, session_id, request_id,
   trace_id, correlation_id, entity_kind, entity_id, attrs, ip_hash, user_agent_family, app_version)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`;

@Injectable()
export class SecurityEventsService implements SecurityEventSink {
  private readonly logger = new Logger(SecurityEventsService.name);

  constructor(private readonly pools: DbPools) {}

  async write(event: SecurityEvent, tx?: Queryable): Promise<void> {
    const values = [
      event.type,
      event.outcome,
      event.accountId ?? null,
      event.actorKind,
      event.actorId ?? 'anonymous',
      event.actorName ?? null,
      event.principalKind ?? null,
      event.sessionId ?? null,
      event.requestId ?? null,
      event.traceId ?? null,
      event.correlationId ?? null,
      event.entityKind ?? null,
      event.entityId ?? null,
      JSON.stringify(event.attrs ?? {}),
      event.ipHash ?? null,
      event.userAgentFamily ?? null,
      process.env.APP_VERSION ?? 'dev',
    ];
    if (tx) {
      await tx.query(INSERT, values);
      return;
    }
    try {
      await this.pools.get('app').query(INSERT, values);
    } catch (error) {
      // Never fail a request because the security write failed, but never
      // lose it silently either: the log line is alarmed on in Platform 5.
      this.logger.error(`security event ${event.type} not written: ${(error as Error).message}`);
    }
  }
}
