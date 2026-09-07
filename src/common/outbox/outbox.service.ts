import { Injectable } from '@nestjs/common';
import type { Queryable } from '../../db/session.js';

/**
 * The transactional outbox writer (Integration Patterns section 2). A row
 * is written in the same transaction as the domain change; the worker's
 * dispatcher claims rows with SKIP LOCKED and fans them out. Payloads carry
 * the change, never the whole record, and never a work note body.
 */
export interface OutboxEvent {
  readonly accountId: string;
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload?: Record<string, unknown>;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly origin?: string;
}

@Injectable()
export class OutboxService {
  async write(tx: Queryable, event: OutboxEvent): Promise<number> {
    const result = await tx.query<{ id: string }>(
      `insert into sys.outbox (account_id, aggregate, aggregate_id, event_type, payload, correlation_id, causation_id, origin)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        event.accountId,
        event.aggregate,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.payload ?? {}),
        event.correlationId,
        event.causationId ?? null,
        event.origin ?? 'user',
      ],
    );
    return Number(result.rows[0].id);
  }
}
