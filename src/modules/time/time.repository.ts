import { Injectable } from '@nestjs/common';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';

export interface TimeEntryRow {
  id: string;
  account_id: string;
  ticket_id: string | null;
  bucket_id: string | null;
  contract_id: string;
  person_id: string;
  person_name: string;
  performed_on: string;
  minutes: number;
  activity_type: string;
  billable_class: string;
  description: string;
  after_hours: boolean;
  source: string;
  created_by: string;
  created_at: string;
}

export interface TimeAdjustmentRow {
  id: string;
  account_id: string;
  entry_id: string;
  contract_id: string;
  performed_on: string;
  delta_minutes: number;
  kind: string;
  new_billable_class: string | null;
  reason: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
}

export interface ContractPeriodRow {
  id: string;
  account_id: string;
  contract_id: string;
  starts_on: string;
  ends_on: string;
  contracted_minutes: number;
  carried_over_minutes: number;
  locked: boolean;
  version: number;
}

export interface BucketRow {
  id: string;
  account_id: string;
  key: string;
  label: string;
  billable_class: string;
  status: string;
  version: number;
}

/** Time entries, adjustments, buckets and periods (Time, Contracts & Budget technical 2). */
@Injectable()
export class TimeRepository extends RepositoryBase {
  insertEntry(
    tx: Tx,
    input: {
      accountId: string;
      ticketId?: string | null;
      bucketId?: string | null;
      contractId: string;
      personId: string;
      personName: string;
      performedOn: string;
      minutes: number;
      activityType: string;
      billableClass: string;
      description: string;
      afterHours: boolean;
      source?: string;
      createdBy: string;
    },
  ): Promise<TimeEntryRow> {
    return this.one<TimeEntryRow>(
      tx,
      'time_entry',
      `insert into acct.time_entries (account_id, ticket_id, bucket_id, contract_id, person_id, person_name, performed_on, minutes,
                                      activity_type, billable_class, description, after_hours, source, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, coalesce($13, 'manual'), $14) returning *`,
      [
        input.accountId,
        input.ticketId ?? null,
        input.bucketId ?? null,
        input.contractId,
        input.personId,
        input.personName,
        input.performedOn,
        input.minutes,
        input.activityType,
        input.billableClass,
        input.description,
        input.afterHours,
        input.source,
        input.createdBy,
      ],
    );
  }

  entryById(tx: Tx, id: string): Promise<TimeEntryRow> {
    return this.one<TimeEntryRow>(tx, 'time_entry', 'select * from acct.time_entries where id = $1', [id]);
  }

  entriesOfTicket(tx: Tx, ticketId: string): Promise<(TimeEntryRow & { adjusted_minutes: number })[]> {
    return this.many(
      tx,
      `select e.*, e.minutes + coalesce((select sum(a.delta_minutes) from acct.time_adjustments a where a.entry_id = e.id), 0)::int as adjusted_minutes
         from acct.time_entries e where e.ticket_id = $1 order by e.performed_on, e.created_at`,
      [ticketId],
    );
  }

  /** Net logged minutes on a ticket (entries plus adjustments), for the close discipline. */
  async loggedMinutes(tx: Tx, ticketId: string): Promise<number> {
    const row = await this.maybeOne<{ minutes: number }>(
      tx,
      `select coalesce(sum(e.minutes), 0)::int + coalesce((select sum(a.delta_minutes) from acct.time_adjustments a join acct.time_entries e2 on e2.id = a.entry_id where e2.ticket_id = $1), 0)::int as minutes
         from acct.time_entries e where e.ticket_id = $1`,
      [ticketId],
    );
    return Math.max(0, row?.minutes ?? 0);
  }

  entriesOfPerson(
    tx: Tx,
    personId: string,
    from: string,
    to: string,
  ): Promise<(TimeEntryRow & { ticket_number: string | null; bucket_label: string | null })[]> {
    return this.many(
      tx,
      `select e.*, t.number::text as ticket_number, b.label as bucket_label
         from acct.time_entries e
         left join acct.tickets t on t.id = e.ticket_id
         left join acct.non_ticket_buckets b on b.id = e.bucket_id
        where e.person_id = $1 and e.performed_on between $2 and $3
        order by e.performed_on, e.created_at`,
      [personId, from, to],
    );
  }

  entriesOfAccount(
    tx: Tx,
    accountId: string,
    from: string,
    to: string,
  ): Promise<(TimeEntryRow & { ticket_number: string | null; bucket_label: string | null })[]> {
    return this.many(
      tx,
      `select e.*, t.number::text as ticket_number, b.label as bucket_label
         from acct.time_entries e
         left join acct.tickets t on t.id = e.ticket_id
         left join acct.non_ticket_buckets b on b.id = e.bucket_id
        where e.account_id = $1 and e.performed_on between $2 and $3
        order by e.performed_on, e.created_at`,
      [accountId, from, to],
    );
  }

  insertAdjustment(
    tx: Tx,
    input: {
      accountId: string;
      entryId: string;
      contractId: string;
      performedOn: string;
      deltaMinutes: number;
      kind: string;
      newBillableClass?: string | null;
      reason: string;
      createdBy: string;
      createdByName: string;
    },
  ): Promise<TimeAdjustmentRow> {
    return this.one<TimeAdjustmentRow>(
      tx,
      'time_adjustment',
      `insert into acct.time_adjustments (account_id, entry_id, contract_id, performed_on, delta_minutes, kind, new_billable_class, reason, created_by, created_by_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
      [
        input.accountId,
        input.entryId,
        input.contractId,
        input.performedOn,
        input.deltaMinutes,
        input.kind,
        input.newBillableClass ?? null,
        input.reason,
        input.createdBy,
        input.createdByName,
      ],
    );
  }

  adjustmentsOfEntry(tx: Tx, entryId: string): Promise<TimeAdjustmentRow[]> {
    return this.many<TimeAdjustmentRow>(
      tx,
      'select * from acct.time_adjustments where entry_id = $1 order by created_at',
      [entryId],
    );
  }

  /** Consumption lines for a contract in a date range: entries plus adjustments (reclass moves minutes between classes). */
  consumption(
    tx: Tx,
    contractId: string,
    from: string,
    to: string,
  ): Promise<{ activity_type: string; billable_class: string; minutes: number }[]> {
    return this.many(
      tx,
      `with lines as (
         select e.activity_type, e.billable_class, e.minutes from acct.time_entries e
          where e.contract_id = $1 and e.performed_on between $2 and $3
         union all
         select e.activity_type, coalesce(a.new_billable_class, e.billable_class), a.delta_minutes
           from acct.time_adjustments a join acct.time_entries e on e.id = a.entry_id
          where a.contract_id = $1 and a.performed_on between $2 and $3
       )
       select activity_type, billable_class, sum(minutes)::int as minutes from lines group by 1, 2 order by 1, 2`,
      [contractId, from, to],
    );
  }

  periodFor(tx: Tx, contractId: string, on: string): Promise<ContractPeriodRow | undefined> {
    return this.maybeOne<ContractPeriodRow>(
      tx,
      `select * from acct.contract_periods where contract_id = $1 and $2 between starts_on and ends_on`,
      [contractId, on],
    );
  }

  periodsOf(tx: Tx, contractId: string): Promise<ContractPeriodRow[]> {
    return this.many<ContractPeriodRow>(
      tx,
      'select * from acct.contract_periods where contract_id = $1 order by starts_on desc',
      [contractId],
    );
  }

  insertPeriod(
    tx: Tx,
    input: {
      accountId: string;
      contractId: string;
      startsOn: string;
      endsOn: string;
      contractedMinutes: number;
      carriedOverMinutes?: number;
    },
  ): Promise<ContractPeriodRow> {
    return this.one<ContractPeriodRow>(
      tx,
      'contract_period',
      `insert into acct.contract_periods (account_id, contract_id, starts_on, ends_on, contracted_minutes, carried_over_minutes)
       values ($1, $2, $3, $4, $5, coalesce($6, 0)) returning *`,
      [
        input.accountId,
        input.contractId,
        input.startsOn,
        input.endsOn,
        input.contractedMinutes,
        input.carriedOverMinutes,
      ],
    );
  }

  buckets(tx: Tx, accountId: string): Promise<BucketRow[]> {
    return this.many<BucketRow>(tx, `select * from acct.non_ticket_buckets where account_id = $1 order by label`, [
      accountId,
    ]);
  }

  bucketById(tx: Tx, id: string): Promise<BucketRow> {
    return this.one<BucketRow>(tx, 'bucket', 'select * from acct.non_ticket_buckets where id = $1', [id]);
  }

  insertBucket(
    tx: Tx,
    input: { accountId: string; key: string; label: string; billableClass: string },
  ): Promise<BucketRow> {
    return this.one<BucketRow>(
      tx,
      'bucket',
      `insert into acct.non_ticket_buckets (account_id, key, label, billable_class) values ($1, $2, $3, $4) returning *`,
      [input.accountId, input.key, input.label, input.billableClass],
    );
  }

  billingPeriodFor(tx: Tx, accountId: string, on: string): Promise<{ id: string; status: string } | undefined> {
    return this.maybeOne(
      tx,
      `select id, status from acct.billing_periods where account_id = $1 and $2 between starts_on and ends_on`,
      [accountId, on],
    );
  }

  insertBillingPeriod(
    tx: Tx,
    accountId: string,
    startsOn: string,
    endsOn: string,
  ): Promise<{ id: string; status: string; version: number }> {
    return this.one(
      tx,
      'billing_period',
      `insert into acct.billing_periods (account_id, starts_on, ends_on) values ($1, $2, $3) returning id, status, version`,
      [accountId, startsOn, endsOn],
    );
  }

  lockBillingPeriod(tx: Tx, id: string, lockedBy: string): Promise<{ id: string; status: string }> {
    return this.one(
      tx,
      'billing_period',
      `update acct.billing_periods set status = 'locked', locked_at = now(), locked_by = $2 where id = $1 and status <> 'exported' returning id, status`,
      [id, lockedBy],
    );
  }
}
