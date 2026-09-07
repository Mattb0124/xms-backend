import { Injectable } from '@nestjs/common';
import { AuditService, SYSTEM_ACTOR } from '../common/audit/audit.service.js';
import { OutboxService } from '../common/outbox/outbox.service.js';
import { DbPools } from '../db/pool.js';
import type { Tx } from '../db/repository.base.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { latch, remaining } from '../domain/sla/engine.js';
import { CalendarService } from '../modules/calendars/calendars.module.js';
import { NotificationsRepository } from '../modules/notifications/notifications.repository.js';
import { TicketsRepository, ticketKey, toClock, type ClockRow } from '../modules/tickets/tickets.repository.js';
import type { Job } from './jobs.js';

/**
 * The breach sweeper and the at-risk job (Ticket Management technical 3.4,
 * P2.10.2), ported from the studio sweeper: a SKIP LOCKED batch of 500 every
 * five minutes whose WHERE clause mirrors the latch preconditions (live,
 * not paused, past due), the same `latch` the service uses, one audit event,
 * one outbox row and one notification per clock, and never a second event
 * on the next sweep because the latch is idempotent.
 */
export const SWEEP_PREDICATE = `met_at is null and breached_at is null and paused_at is null and due_at < now()`;
/**
 * The at-risk prefilter: wall-clock clocks are cut in SQL at a quarter of
 * the target; calendar clocks are cut at a week of wall time and judged in
 * code on working minutes, since evenings and weekends inflate wall time.
 */
export const AT_RISK_PREDICATE = `met_at is null and breached_at is null and paused_at is null and at_risk_notified_at is null
  and due_at > now()
  and ((calendar_id = '24x7' and due_at - now() < (target_minutes * interval '1 minute') * 0.25)
    or (calendar_id <> '24x7' and due_at - now() < interval '7 days'))`;

@Injectable()
export class SlaJobs {
  constructor(
    private readonly pools: DbPools,
    private readonly uow: UnitOfWork,
    private readonly tickets: TicketsRepository,
    private readonly notifications: NotificationsRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly calendars: CalendarService,
  ) {}

  sweeper(intervalMs = 5 * 60_000): Job {
    return { name: 'sla.sweep', intervalMs, run: () => this.sweep() };
  }

  atRisk(intervalMs = 5 * 60_000): Job {
    return { name: 'sla.at_risk', intervalMs, run: () => this.notifyAtRisk() };
  }

  /** Latches overdue clocks in batches; returns the count latched. */
  async sweep(batch = 500): Promise<string> {
    const accountIds = await this.liveAccountIds();
    if (accountIds.length === 0) return 'latched 0';
    let latched = 0;
    await this.uow.worker(accountIds, async (tx) => {
      const rows = await tx.query<ClockRow>(
        `select * from acct.sla_clocks where ${SWEEP_PREDICATE} order by due_at limit $1 for update skip locked`,
        [batch],
      );
      const now = new Date();
      for (const row of rows.rows) {
        const result = latch(toClock(row), now);
        if (!result.latched) continue;
        await this.tickets.saveClock(tx, row.id, result.clock);
        const ticket = await this.tickets.lock(tx, row.ticket_id);
        const flag = row.kind === 'response' ? 'sla_response_breached' : 'sla_resolution_breached';
        await tx.query(`update acct.tickets set ${flag} = true where id = $1`, [ticket.id]);
        await this.audit.account(tx, row.account_id, SYSTEM_ACTOR, { correlationId: `sweep:${row.id}` }, [
          {
            entityKind: 'ticket',
            entityId: ticket.id,
            ticketId: ticket.id,
            eventType: 'sla.breached',
            field: row.kind,
            newValue: row.due_at,
          },
        ]);
        await this.outbox.write(tx, {
          accountId: row.account_id,
          aggregate: 'ticket',
          aggregateId: ticket.id,
          eventType: 'sla.breached',
          correlationId: `sweep:${row.id}`,
          origin: 'system',
          payload: { kind: row.kind },
        });
        await this.notifyTicketPeople(
          tx,
          ticket,
          'sla.breached',
          `${ticketKey(ticket.number)} breached its ${row.kind} target`,
          `breached:${row.id}`,
        );
        latched += 1;
      }
    });
    return `latched ${latched}`;
  }

  async notifyAtRisk(batch = 500): Promise<string> {
    const accountIds = await this.liveAccountIds();
    if (accountIds.length === 0) return 'notified 0';
    let notified = 0;
    await this.uow.worker(accountIds, async (tx) => {
      const rows = await tx.query<ClockRow>(
        `select * from acct.sla_clocks where ${AT_RISK_PREDICATE} order by due_at limit $1 for update skip locked`,
        [batch],
      );
      for (const row of rows.rows) {
        const minutes = remaining(toClock(row), await this.calendars.byId(tx, row.calendar_id), new Date());
        if (minutes >= row.target_minutes * 0.25) continue;
        const ticket = await this.tickets.byId(tx, row.ticket_id);
        await this.notifyTicketPeople(
          tx,
          ticket,
          'sla.at_risk',
          `${ticketKey(ticket.number)} ${row.kind} target due in ${minutes} minutes`,
          `at_risk:${row.id}`,
        );
        await tx.query(`update acct.sla_clocks set at_risk_notified_at = now() where id = $1`, [row.id]);
        notified += 1;
      }
    });
    return `notified ${notified}`;
  }

  private async liveAccountIds(): Promise<string[]> {
    const result = await this.pools
      .get('worker')
      .query<{ id: string }>(`select id from op.accounts where status in ('active', 'onboarding')`);
    return result.rows.map((row) => row.id);
  }

  private async notifyTicketPeople(
    tx: Tx,
    ticket: { id: string; account_id: string; number: string; short_description: string; assignee_id: string | null },
    type: string,
    title: string,
    collapseKey: string,
  ): Promise<void> {
    const recipients = new Set<string>();
    if (ticket.assignee_id) recipients.add(ticket.assignee_id);
    for (const watcher of await this.tickets.watchersOf(tx, ticket.id))
      if (!watcher.muted_at) recipients.add(watcher.user_id);
    for (const recipient of recipients) {
      await this.notifications.upsert(tx, {
        accountId: ticket.account_id,
        recipientId: recipient,
        type,
        title,
        body: ticket.short_description,
        targetKind: 'ticket',
        targetId: ticket.id,
        link: `/tickets/${ticketKey(ticket.number)}`,
        collapseKey: `${collapseKey}:${recipient}`,
      });
    }
  }
}
