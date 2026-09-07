import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DbPools } from '../db/pool.js';

/**
 * The outbox dispatcher (Integration Patterns section 2; P1.5.3). Claims
 * undispatched rows in id order with SKIP LOCKED, hands each to the
 * registered handlers, marks it dispatched; a handler failure counts an
 * attempt and, after five, moves the row to sys.dead_letters with the
 * error. At-least-once: handlers are idempotent on the outbox id. Fan-out
 * to SQS is one more handler when the queues exist.
 */
export interface OutboxRow {
  readonly id: string;
  readonly account_id: string;
  readonly aggregate: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly correlation_id: string;
  readonly origin: string;
  readonly created_at: string;
  readonly attempts: number;
}

export type OutboxHandler = (row: OutboxRow) => Promise<void>;

export const MAX_ATTEMPTS = 5;

@Injectable()
export class OutboxDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private readonly handlers: { name: string; matches: (type: string) => boolean; handle: OutboxHandler }[] = [];
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly pools: DbPools,
    private readonly intervalMs = 1000,
    private readonly autoStart = true,
  ) {}

  subscribe(name: string, matches: (type: string) => boolean, handle: OutboxHandler): void {
    this.handlers.push({ name, matches, handle });
  }

  onModuleInit(): void {
    if (!this.autoStart || !this.pools.has('worker')) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass: claims up to `limit` rows and processes them. Returns the number processed. */
  async tick(limit = 100): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const client = await this.pools.get('worker').connect();
    let processed = 0;
    try {
      await client.query('begin');
      const claimed = await client.query<OutboxRow>(
        `select id, account_id, aggregate, aggregate_id, event_type, payload, correlation_id, origin, created_at, attempts
           from sys.outbox where dispatched_at is null order by id limit $1 for update skip locked`,
        [limit],
      );
      for (const row of claimed.rows) {
        const outcome = await this.dispatch(row);
        if (outcome === 'ok') {
          await client.query('update sys.outbox set dispatched_at = now(), attempts = attempts + 1 where id = $1', [
            row.id,
          ]);
        } else {
          const attempts = row.attempts + 1;
          if (attempts >= MAX_ATTEMPTS) {
            await client.query(
              `insert into sys.dead_letters (queue, account_id, correlation_id, payload, error, attempts)
               values ('outbox', $1, $2, $3, $4, $5)`,
              [
                row.account_id,
                row.correlation_id,
                JSON.stringify({ outbox_id: row.id, event_type: row.event_type, payload: row.payload }),
                outcome,
                attempts,
              ],
            );
            await client.query(
              'update sys.outbox set dispatched_at = now(), attempts = $2, last_error = $3 where id = $1',
              [row.id, attempts, outcome],
            );
            this.logger.error(
              `outbox ${row.id} ${row.event_type} dead-lettered after ${attempts} attempts: ${outcome}`,
            );
          } else {
            await client.query('update sys.outbox set attempts = $2, last_error = $3 where id = $1', [
              row.id,
              attempts,
              outcome,
            ]);
          }
        }
        processed += 1;
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      this.logger.error(`outbox tick failed: ${(error as Error).message}`);
    } finally {
      client.release();
      this.running = false;
    }
    return processed;
  }

  private async dispatch(row: OutboxRow): Promise<'ok' | string> {
    for (const handler of this.handlers) {
      if (!handler.matches(row.event_type)) continue;
      try {
        await handler.handle(row);
      } catch (error) {
        return `${handler.name}: ${(error as Error).message}`;
      }
    }
    return 'ok';
  }
}
