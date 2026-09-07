import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService, SYSTEM_ACTOR } from '../common/audit/audit.service.js';
import { OutboxService } from '../common/outbox/outbox.service.js';
import { DbPools } from '../db/pool.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { periodSummary } from '../domain/time/billing.js';
import { TimeRepository, type BillingPeriodRow } from '../modules/time/time.repository.js';
import type { Job } from './jobs.js';

/**
 * Billing period housekeeping (Time, Contracts & Budget functional 5.7):
 * an approved period locks itself once its auto-lock instant has passed,
 * exactly as a finance user would have locked it: the summary is refreshed,
 * the audit row names the system actor, and the outbox carries the event
 * the finance connector delivers (INT-02).
 */
@Injectable()
export class PeriodJobs {
  constructor(
    private readonly pools: DbPools,
    private readonly uow: UnitOfWork,
    private readonly time: TimeRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  autoLock(intervalMs = 15 * 60_000): Job {
    return { name: 'billing.auto_lock', intervalMs, run: () => this.lockDue() };
  }

  /** Locks every approved period whose auto-lock instant has passed; returns the count. */
  async lockDue(batch = 100): Promise<string> {
    const accountIds = await this.liveAccountIds();
    if (accountIds.length === 0) return 'locked 0';
    let locked = 0;
    await this.uow.worker(accountIds, async (tx) => {
      const due = await tx.query<BillingPeriodRow>(
        `select * from acct.billing_periods
          where status = 'approved' and auto_lock_at is not null and auto_lock_at <= now()
          order by auto_lock_at limit $1 for update skip locked`,
        [batch],
      );
      for (const period of due.rows) {
        const summary = periodSummary(
          await this.time.financeLines(tx, period.account_id, period.starts_on, period.ends_on),
        );
        const after = await this.time.updateBillingPeriod(tx, period.id, period.version, {
          status: 'locked',
          locked_at: new Date(),
          locked_by: 'system',
          summary,
        });
        await this.audit.account(tx, period.account_id, SYSTEM_ACTOR, { correlationId: `auto-lock:${period.id}` }, [
          {
            entityKind: 'billing_period',
            entityId: period.id,
            eventType: 'updated',
            field: 'status',
            oldValue: 'approved',
            newValue: 'locked',
          },
        ]);
        await this.outbox.write(tx, {
          accountId: period.account_id,
          aggregate: 'billing_period',
          aggregateId: period.id,
          eventType: 'billing_period.locked',
          correlationId: randomUUID(),
          origin: 'system',
          payload: { starts_on: after.starts_on, ends_on: after.ends_on, summary: after.summary, auto: true },
        });
        locked += 1;
      }
    });
    return `locked ${locked}`;
  }

  private async liveAccountIds(): Promise<string[]> {
    const result = await this.pools
      .get('worker')
      .query<{ id: string }>(`select id from op.accounts where status in ('active', 'onboarding', 'offboarding')`);
    return result.rows.map((row) => row.id);
  }
}
