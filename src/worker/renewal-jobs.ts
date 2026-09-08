import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService, SYSTEM_ACTOR } from '../common/audit/audit.service.js';
import { OutboxService } from '../common/outbox/outbox.service.js';
import { DbPools } from '../db/pool.js';
import type { Tx } from '../db/repository.base.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import {
  alertsDue,
  daysBetween,
  EngagementsRepository,
  NOTICE_BOUNDARY_KEY,
  RENEWAL_LEAD_DAYS,
  statusFor,
  type EngagementRow,
} from '../modules/contracts/engagements.module.js';
import { NotificationsRepository } from '../modules/notifications/notifications.repository.js';
import { TimeRepository } from '../modules/time/time.repository.js';
import type { Job } from './jobs.js';

/**
 * Renewal alerts (Time, Contracts & Budget technical section 3; functional
 * 5.6, INT-03). Daily, one transaction per account: an engagement whose
 * renewal date has come inside 90, 60 or 30 days, or inside its notice
 * period, tells its owner and the account's contract managers once per lead
 * time. The engagement remembers which lead times it has fired, so the next
 * run stays quiet, and its status follows the date: expiring inside the
 * widest lead window, ended once the date has passed.
 *
 * The notification, the audit row, the outbox event and the ledger stamp
 * are one transaction per engagement, so a crash re-alerts rather than
 * losing the alert: `acct.engagements` carries `sys.require_audit`, and the
 * status move is itself an audited change.
 */
const HORIZON_DAYS = Math.max(...RENEWAL_LEAD_DAYS);

@Injectable()
export class RenewalJobs {
  constructor(
    private readonly pools: DbPools,
    private readonly uow: UnitOfWork,
    private readonly engagements: EngagementsRepository,
    private readonly notifications: NotificationsRepository,
    private readonly time: TimeRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  renewalAlerts(intervalMs = 24 * 60 * 60_000): Job {
    return { name: 'renewal.alerts', intervalMs, run: () => this.alertDue() };
  }

  /** Alerts every engagement owed one and moves the statuses; returns the counts. */
  async alertDue(batch = 200, today = new Date().toISOString().slice(0, 10)): Promise<string> {
    const accountIds = await this.liveAccountIds();
    if (accountIds.length === 0) return 'alerted 0, moved 0';
    let alerted = 0;
    let moved = 0;
    await this.uow.perAccount(accountIds, async (tx, accountId) => {
      // The horizon covers the widest lead time; an engagement whose date
      // has already passed is inside it too, so `ended` is reached here.
      const rows = await this.engagements.dueForReview(tx, HORIZON_DAYS, batch);
      if (rows.length === 0) return;
      const managers = await this.time.budgetRecipients(tx, accountId);
      for (const engagement of rows) {
        const due = alertsDue(engagement, today);
        const status = statusFor(engagement.renewal_date, today);
        if (due.length === 0 && status === engagement.status) continue;
        const recipients = new Set(managers);
        if (engagement.owner_user_id) recipients.add(engagement.owner_user_id);
        for (const lead of due) {
          await this.notify(tx, engagement, lead, recipients, today);
          alerted += 1;
        }
        if (status !== engagement.status) {
          await this.audit.account(tx, accountId, SYSTEM_ACTOR, { correlationId: `renewal:${engagement.id}` }, [
            {
              entityKind: 'engagement',
              entityId: engagement.id,
              eventType: 'engagement.status_changed',
              field: 'status',
              oldValue: engagement.status,
              newValue: status,
            },
          ]);
          moved += 1;
        }
        await this.engagements.stamp(tx, engagement.id, [...engagement.renewal_alerts_fired, ...due], status);
      }
    });
    return `alerted ${alerted}, moved ${moved}`;
  }

  private async notify(
    tx: Tx,
    engagement: EngagementRow,
    lead: number,
    recipients: ReadonlySet<string>,
    today: string,
  ): Promise<void> {
    const renewalDate = engagement.renewal_date ?? today;
    const days = daysBetween(today, renewalDate);
    const title =
      lead === NOTICE_BOUNDARY_KEY
        ? `${engagement.name}: notice period reached, ${days} days to renewal`
        : `${engagement.name}: renewal in ${days} days`;
    const body =
      lead === NOTICE_BOUNDARY_KEY
        ? `Renews ${renewalDate}; notice of ${engagement.notice_period_days} days must be given now`
        : `Renews ${renewalDate}`;
    for (const recipientId of recipients)
      await this.notifications.upsert(tx, {
        accountId: engagement.account_id,
        recipientId,
        type: 'engagement.renewal_due',
        title,
        body,
        targetKind: 'engagement',
        targetId: engagement.id,
        link: `/accounts/${engagement.account_id}/engagements/${engagement.id}`,
        // One row per engagement and lead time: a repeat inside a window
        // collapses rather than filling the bell.
        collapseKey: `engagement-renewal:${engagement.id}:${lead}`,
      });
    await this.audit.account(
      tx,
      engagement.account_id,
      SYSTEM_ACTOR,
      { correlationId: `renewal:${engagement.id}:${lead}` },
      [
        {
          entityKind: 'engagement',
          entityId: engagement.id,
          eventType: 'engagement.renewal_due',
          field: 'renewal_alerts_fired',
          newValue: {
            lead_days: lead,
            notice_boundary: lead === NOTICE_BOUNDARY_KEY,
            renewal_date: renewalDate,
            days_remaining: days,
            notified: recipients.size,
          },
        },
      ],
    );
    await this.outbox.write(tx, {
      accountId: engagement.account_id,
      aggregate: 'engagement',
      aggregateId: engagement.id,
      eventType: 'engagement.renewal_due',
      correlationId: randomUUID(),
      origin: 'system',
      payload: {
        name: engagement.name,
        renewal_date: renewalDate,
        notice_period_days: engagement.notice_period_days,
        lead_days: lead,
        notice_boundary: lead === NOTICE_BOUNDARY_KEY,
        days_remaining: days,
      },
    });
  }

  private async liveAccountIds(): Promise<string[]> {
    const result = await this.pools
      .get('worker')
      .query<{ id: string }>(`select id from op.accounts where status in ('active', 'onboarding', 'offboarding')`);
    return result.rows.map((row) => row.id);
  }
}
