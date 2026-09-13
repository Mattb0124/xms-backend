import { Injectable } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service.js';
import { OutboxService } from '../common/outbox/outbox.service.js';
import { DbPools } from '../db/pool.js';
import type { Tx } from '../db/repository.base.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { NotificationsRepository } from '../modules/notifications/notifications.repository.js';
import { TicketsRepository, ticketKey } from '../modules/tickets/tickets.repository.js';
import type { Job } from './jobs.js';

/**
 * Container-case detection (TM-27, migration 0051).
 *
 * A ticket that has quietly become a project is flagged out of scope the way
 * a consultant would flag it (TM-11), with a reason naming the threshold it
 * crossed, and the account owner (TM-23) is told, because the owner is who
 * answers for what the client is getting.
 *
 * The actor is the system, and it says so: the flag reads as raised by
 * detection, not by a colleague nobody can ask about it. The decision stays
 * a person's, which is the whole point of routing this into TM-11 rather
 * than inventing a second workflow.
 */
const SYSTEM_DETECTOR = { kind: 'system' as const, id: 'container-detection', name: 'Container detection' };

/** Thresholds as an account has them set; null is a threshold switched off. */
export interface ContainerThresholds {
  timeEntries: number | null;
  elapsedDays: number | null;
  effortMinutes: number | null;
}

export interface ContainerCandidate {
  id: string;
  number: string;
  short_description: string;
  assignee_id: string | null;
  created_at: string;
  entry_count: number;
  effort_minutes: number;
  elapsed_days: number;
}

/**
 * Why this ticket is a container case, in the words the flag carries. Pure,
 * so the wording and the boundary conditions are unit-testable without a
 * database: at the threshold counts, below it does not.
 */
export function containerReason(row: ContainerCandidate, thresholds: ContainerThresholds): string | null {
  const crossed: string[] = [];
  if (thresholds.timeEntries !== null && row.entry_count >= thresholds.timeEntries) {
    crossed.push(`${row.entry_count} time entries against a threshold of ${thresholds.timeEntries}`);
  }
  if (thresholds.elapsedDays !== null && row.elapsed_days >= thresholds.elapsedDays) {
    crossed.push(`open ${row.elapsed_days} days against a threshold of ${thresholds.elapsedDays}`);
  }
  if (thresholds.effortMinutes !== null && row.effort_minutes >= thresholds.effortMinutes) {
    crossed.push(
      `${Math.round(row.effort_minutes / 6) / 10} hours logged against a threshold of ${Math.round(thresholds.effortMinutes / 6) / 10}`,
    );
  }
  if (crossed.length === 0) return null;
  return `Container case detected: ${crossed.join('; ')}. Raised for a scope decision rather than left to accrue.`;
}

/**
 * A ticket is still open unless it has reached a resolving or terminal state.
 *
 * This was an allowlist of state keys, and three of the five (`triaged`,
 * `pending`, `on_hold`) exist in no machine this product ships: the sweep
 * silently skipped `assigned`, `triage`, `assessment`, `investigating`,
 * `known_error`, `planned`, `blocked` and every paused state, which is most
 * of what a container case actually looks like. An allowlist of states is the
 * wrong shape anyway, because the machines are configurable per account and
 * an account that renames a state would drop out of detection without anyone
 * noticing. `resolved_at is null` and the two terminal states are what the
 * rest of the codebase means by open (`OPEN_STATES_EXCLUDED`), and the sweep
 * now means the same thing.
 */
const CLOSED_STATES = ['closed', 'cancelled'];

@Injectable()
export class ContainerJobs {
  constructor(
    private readonly pools: DbPools,
    private readonly uow: UnitOfWork,
    private readonly tickets: TicketsRepository,
    private readonly notifications: NotificationsRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  detection(intervalMs = 60 * 60_000): Job {
    return { name: 'tickets.container_detection', intervalMs, run: () => this.sweep() };
  }

  /**
   * One worker transaction per account, bound to that account alone
   * (Security & Tenancy 2.3), the same shape as the SLA sweeper. The
   * thresholds are read inside that transaction rather than in one portfolio
   * query up front, because `acct.account_settings` carries forced row-level
   * security: an unbound read returns nothing at all, which is the data
   * model doing its job.
   *
   * An account with no threshold set costs one settings read and nothing
   * else; it is not opted in, so nothing happens to it.
   */
  async sweep(batch = 200): Promise<string> {
    const accountIds = await this.liveAccountIds();
    if (accountIds.length === 0) return 'flagged 0';
    let flagged = 0;
    await this.uow.perAccount(accountIds, async (tx, accountId) => {
      const thresholds = await this.thresholdsOf(tx, accountId);
      if (!thresholds) return;
      for (const row of await this.candidates(tx, thresholds, batch)) {
        const reason = containerReason(row, thresholds);
        if (!reason) continue;
        await this.raise(tx, accountId, row, reason);
        flagged += 1;
      }
    });
    return `flagged ${flagged}`;
  }

  /** Live accounts, from the operator table, which carries no RLS. */
  private async liveAccountIds(): Promise<string[]> {
    const result = await this.pools
      .get('worker')
      .query<{ id: string }>(`select id from op.accounts where status in ('active', 'onboarding')`);
    return result.rows.map((row) => row.id);
  }

  /** The account's thresholds, or undefined when it has set none. */
  private async thresholdsOf(tx: Tx, accountId: string): Promise<ContainerThresholds | undefined> {
    const result = await tx.query<{
      container_time_entries: number | null;
      container_elapsed_days: number | null;
      container_effort_minutes: number | null;
    }>(
      `select container_time_entries, container_elapsed_days, container_effort_minutes
         from acct.account_settings where account_id = $1`,
      [accountId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const thresholds = {
      timeEntries: row.container_time_entries,
      elapsedDays: row.container_elapsed_days,
      effortMinutes: row.container_effort_minutes,
    };
    const none =
      thresholds.timeEntries === null && thresholds.elapsedDays === null && thresholds.effortMinutes === null;
    return none ? undefined : thresholds;
  }

  /**
   * Open, never-detected tickets with their two accrued measures. The SQL
   * pre-filters on whichever thresholds the account has set, so the batch is
   * candidates rather than every open ticket; `containerReason` then makes
   * the same judgement in code, which is what the unit tests check.
   */
  private async candidates(tx: Tx, thresholds: ContainerThresholds, batch: number): Promise<ContainerCandidate[]> {
    const entries = `(select count(*)::int from acct.time_entries e where e.ticket_id = t.id)`;
    const effort = `(select coalesce(sum(e.minutes), 0)::int from acct.time_entries e where e.ticket_id = t.id)`;
    const elapsed = `extract(day from now() - t.created_at)::int`;
    const crossed: string[] = [];
    const values: unknown[] = [CLOSED_STATES, batch];
    if (thresholds.timeEntries !== null) {
      values.push(thresholds.timeEntries);
      crossed.push(`${entries} >= $${values.length}`);
    }
    if (thresholds.elapsedDays !== null) {
      values.push(thresholds.elapsedDays);
      crossed.push(`${elapsed} >= $${values.length}`);
    }
    if (thresholds.effortMinutes !== null) {
      values.push(thresholds.effortMinutes);
      crossed.push(`${effort} >= $${values.length}`);
    }
    if (crossed.length === 0) return [];
    // Scalar subqueries rather than a grouped join: Postgres refuses FOR
    // UPDATE alongside GROUP BY, and the batch has to hold its rows so two
    // workers cannot flag the same ticket twice.
    const result = await tx.query<ContainerCandidate>(
      `select t.id, t.number, t.short_description, t.assignee_id, t.created_at,
              ${entries} as entry_count,
              ${effort} as effort_minutes,
              ${elapsed} as elapsed_days
         from acct.tickets t
        where t.container_detected_at is null
          and t.state <> all ($1::text[])
          and t.resolved_at is null
          and t.out_of_scope = 'none'
          and (${crossed.join(' or ')})
        order by t.created_at
        limit $2
          for update skip locked`,
      values,
    );
    return result.rows;
  }

  /**
   * Raise the TM-11 flag, latch the detection, and tell the owner. Every
   * write is in the caller's transaction, so a ticket is never flagged
   * without its audit row, its scope-decision record and its notification.
   */
  private async raise(tx: Tx, accountId: string, row: ContainerCandidate, reason: string): Promise<void> {
    const detectedAt = new Date().toISOString();
    await tx.query(
      `update acct.tickets
          set out_of_scope = 'flagged',
              out_of_scope_detail = $2::jsonb,
              container_detected_at = now(),
              version = version + 1
        where id = $1`,
      [
        row.id,
        JSON.stringify({
          reason,
          flagged_by: SYSTEM_DETECTOR.id,
          flagged_by_name: SYSTEM_DETECTOR.name,
          flagged_at: detectedAt,
        }),
      ],
    );
    const correlationId = `container:${row.id}`;
    await this.audit.account(tx, accountId, SYSTEM_DETECTOR, { correlationId }, [
      {
        entityKind: 'ticket',
        entityId: row.id,
        ticketId: row.id,
        eventType: 'ticket.scope_flagged',
        field: 'out_of_scope',
        oldValue: 'none',
        newValue: { state: 'flagged', reason, detector: 'container' },
      },
    ]);
    // Invisible to the client, exactly as a consultant's flag is: it is an
    // internal opinion until somebody with the authority answers it.
    await this.tickets.recordScopeDecision(tx, {
      accountId,
      ticketId: row.id,
      event: 'flagged',
      reason,
      actorId: SYSTEM_DETECTOR.id,
      actorName: SYSTEM_DETECTOR.name,
      clientVisible: false,
    });
    await this.outbox.write(tx, {
      accountId,
      aggregate: 'ticket',
      aggregateId: row.id,
      eventType: 'ticket.scope_flagged',
      correlationId,
      origin: 'system',
      payload: { reason, flagged_by: SYSTEM_DETECTOR.id, detector: 'container' },
    });
    await this.notifyOwnerAndAssignee(tx, accountId, row, reason, correlationId);
  }

  private async notifyOwnerAndAssignee(
    tx: Tx,
    accountId: string,
    row: ContainerCandidate,
    reason: string,
    correlationId: string,
  ): Promise<void> {
    const owner = await tx.query<{ owner_user_id: string | null }>(
      'select owner_user_id::text as owner_user_id from op.accounts where id = $1',
      [accountId],
    );
    const recipients = new Set<string>();
    // The owner is the one TM-27 names; the assignee is told because it is
    // their ticket that just changed under them.
    if (owner.rows[0]?.owner_user_id) recipients.add(owner.rows[0].owner_user_id);
    if (row.assignee_id) recipients.add(row.assignee_id);
    for (const recipient of recipients) {
      await this.notifications.upsert(tx, {
        accountId,
        recipientId: recipient,
        type: 'ticket.scope_flagged',
        title: `${ticketKey(row.number)} looks like a container case`,
        body: reason,
        targetKind: 'ticket',
        targetId: row.id,
        link: `/cases/${ticketKey(row.number)}`,
        collapseKey: `${correlationId}:${recipient}`,
      });
    }
  }
}
