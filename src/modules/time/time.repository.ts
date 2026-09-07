import { Injectable } from '@nestjs/common';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import type { BillingState, FinanceLine, PeriodSummary } from '../../domain/time/billing.js';

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
  performed_start: string | null;
  after_hours_class: 'standard' | 'after_hours' | 'weekend' | 'holiday';
  /** numeric(5,3) comes back as a string. */
  rate_multiplier: string;
  /** Hourly rate frozen at log time (numeric string) and the amount to the cent; null without a rate card entry. */
  rate_snapshot: string | null;
  amount: string | null;
  over_budget: boolean;
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
  thresholds_fired: number[];
  version: number;
}

export interface BillingPeriodRow {
  id: string;
  account_id: string;
  starts_on: string;
  ends_on: string;
  status: BillingState;
  submitted_at: string | null;
  submitted_by: string | null;
  approved_at: string | null;
  approved_by: string | null;
  locked_at: string | null;
  locked_by: string | null;
  auto_lock_at: string | null;
  summary: PeriodSummary | null;
  checksum: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface BillingExportRow {
  id: string;
  account_id: string;
  billing_period_id: string;
  format: 'xlsx' | 'csv';
  template_version: string;
  object_key: string;
  checksum: string;
  row_count: number;
  produced_by: string;
  produced_at: string;
  delivered_at: string | null;
  delivery_ref: string | null;
}

export interface RateCardRow {
  id: string;
  account_id: string;
  contract_id: string | null;
  effective_from: string;
  currency: string;
  note: string;
  created_by: string;
  created_at: string;
  entries: { role: string; bill_rate: number; overage_rate: number | null }[];
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
      performedStart?: string | null;
      afterHoursClass?: string;
      rateMultiplier?: number;
      rateSnapshot?: number | null;
      amount?: number | null;
      overBudget?: boolean;
      source?: string;
      createdBy: string;
    },
  ): Promise<TimeEntryRow> {
    return this.one<TimeEntryRow>(
      tx,
      'time_entry',
      `insert into acct.time_entries (account_id, ticket_id, bucket_id, contract_id, person_id, person_name, performed_on, minutes,
                                      activity_type, billable_class, description, after_hours, source, created_by,
                                      performed_start, after_hours_class, rate_multiplier, rate_snapshot, amount, over_budget)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, coalesce($13, 'manual'), $14,
               $15, coalesce($16, 'standard'), coalesce($17::numeric, 1.0), $18, $19, coalesce($20, false)) returning *`,
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
        input.performedStart ?? null,
        input.afterHoursClass ?? null,
        input.rateMultiplier ?? null,
        input.rateSnapshot ?? null,
        input.amount ?? null,
        input.overBudget ?? null,
      ],
    );
  }

  /** Consumption per performed date and class inside a range (entries plus adjustments), for the forecast. */
  consumptionByDay(
    tx: Tx,
    contractId: string,
    from: string,
    to: string,
  ): Promise<{ performed_on: string; billable_class: string; minutes: number }[]> {
    return this.many(
      tx,
      `with lines as (
         select e.performed_on, e.billable_class, e.minutes from acct.time_entries e
          where e.contract_id = $1 and e.performed_on between $2 and $3
         union all
         select a.performed_on, coalesce(a.new_billable_class, e.billable_class), a.delta_minutes
           from acct.time_adjustments a join acct.time_entries e on e.id = a.entry_id
          where a.contract_id = $1 and a.performed_on between $2 and $3
       )
       select performed_on::text as performed_on, billable_class, sum(minutes)::int as minutes from lines group by 1, 2 order by 1, 2`,
      [contractId, from, to],
    );
  }

  /** Minutes in a period that carry no rate snapshot: the "unrated" figure on the budget view. */
  unratedMinutes(tx: Tx, contractId: string, from: string, to: string): Promise<number> {
    return this.one<{ n: number }>(
      tx,
      'time_entries',
      `select coalesce(sum(minutes), 0)::int as n from acct.time_entries
        where contract_id = $1 and performed_on between $2 and $3 and rate_snapshot is null`,
      [contractId, from, to],
    ).then((row) => row.n);
  }

  /** The period that ends before `startsOn`, if any. */
  previousPeriod(tx: Tx, contractId: string, startsOn: string): Promise<ContractPeriodRow | undefined> {
    return this.maybeOne<ContractPeriodRow>(
      tx,
      'select * from acct.contract_periods where contract_id = $1 and ends_on < $2 order by ends_on desc limit 1',
      [contractId, startsOn],
    );
  }

  /** The person's roster role for the rate lookup; null without a roster row. */
  roleOfUser(tx: Tx, userId: string): Promise<string | null> {
    return this.maybeOne<{ role: string }>(tx, 'select role from op.people where user_id = $1 and is_active', [
      userId,
    ]).then((row) => row?.role ?? null);
  }

  /** Every rate card version that could apply: the contract's own and the account defaults, entries attached. */
  rateCards(tx: Tx, accountId: string, contractId?: string | null): Promise<RateCardRow[]> {
    return this.many<RateCardRow & { entries: { role: string; bill_rate: string; overage_rate: string | null }[] }>(
      tx,
      `select c.*, c.effective_from::text as effective_from,
              coalesce((select json_agg(json_build_object('role', e.role, 'bill_rate', e.bill_rate, 'overage_rate', e.overage_rate) order by e.role)
                          from acct.rate_card_entries e where e.rate_card_id = c.id), '[]'::json) as entries
         from acct.rate_cards c
        where c.account_id = $1 and (c.contract_id is null or c.contract_id = $2::uuid)
        order by c.contract_id nulls last, c.effective_from desc`,
      [accountId, contractId ?? null],
    ).then((rows) =>
      rows.map((row) => ({
        ...row,
        entries: row.entries.map((entry) => ({
          role: entry.role,
          bill_rate: Number(entry.bill_rate),
          overage_rate: entry.overage_rate === null ? null : Number(entry.overage_rate),
        })),
      })),
    );
  }

  async insertRateCard(
    tx: Tx,
    input: {
      accountId: string;
      contractId: string | null;
      effectiveFrom: string;
      currency: string;
      note: string;
      createdBy: string;
      entries: { role: string; bill_rate: number; overage_rate?: number | null }[];
    },
  ): Promise<{ id: string }> {
    const card = await this.one<{ id: string }>(
      tx,
      'rate_card',
      `insert into acct.rate_cards (account_id, contract_id, effective_from, currency, note, created_by)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [input.accountId, input.contractId, input.effectiveFrom, input.currency, input.note, input.createdBy],
    );
    for (const entry of input.entries)
      await tx.query(
        'insert into acct.rate_card_entries (account_id, rate_card_id, role, bill_rate, overage_rate) values ($1, $2, $3, $4, $5)',
        [input.accountId, card.id, entry.role, entry.bill_rate, entry.overage_rate ?? null],
      );
    return card;
  }

  /** Records a threshold crossing once per period and percent; false when it already fired. */
  async fireThreshold(
    tx: Tx,
    input: {
      accountId: string;
      contractId: string;
      periodId: string;
      percent: number;
      consumed: number;
      available: number;
      notified: number;
    },
  ): Promise<boolean> {
    const inserted = await tx.query(
      `insert into acct.threshold_alert_events (account_id, contract_id, contract_period_id, percent, consumed_minutes_at_fire, available_minutes, notified_count)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (contract_period_id, percent) do nothing returning id`,
      [
        input.accountId,
        input.contractId,
        input.periodId,
        input.percent,
        input.consumed,
        input.available,
        input.notified,
      ],
    );
    if (inserted.rowCount === 0) return false;
    await tx.query(
      `update acct.contract_periods set thresholds_fired = array_append(thresholds_fired, $2) where id = $1 and not ($2 = any (thresholds_fired))`,
      [input.periodId, input.percent],
    );
    return true;
  }

  thresholdEvents(
    tx: Tx,
    contractId: string,
  ): Promise<
    {
      id: string;
      contract_period_id: string;
      percent: number;
      consumed_minutes_at_fire: number;
      available_minutes: number;
      fired_at: string;
    }[]
  > {
    return this.many(
      tx,
      'select id, contract_period_id, percent, consumed_minutes_at_fire, available_minutes, fired_at from acct.threshold_alert_events where contract_id = $1 order by fired_at desc limit 100',
      [contractId],
    );
  }

  /** Internal users whose role manages contracts or locks periods, granted on the account or administrators (bound to every account). */
  budgetRecipients(tx: Tx, accountId: string): Promise<string[]> {
    return this.many<{ id: string }>(
      tx,
      `select distinct u.id from op.users u
         join op.role_assignments ra on ra.user_id = u.id and (ra.account_id is null or ra.account_id = $1)
         join op.roles r on r.id = ra.role_id
        where u.kind = 'internal' and u.status = 'active' and r.status = 'active'
          and ('contracts:manage' = any (r.permissions) or 'time:lock-period' = any (r.permissions))
          and (exists (select 1 from op.account_grants g where g.user_id = u.id and g.account_id = $1)
               or (ra.account_id is null and ('admin:accounts' = any (r.permissions) or 'admin:users' = any (r.permissions))))`,
      [accountId],
    ).then((rows) => rows.map((row) => row.id));
  }

  /** The drill-through list behind the budget view (TB-07), filtered and bounded. */
  entriesFiltered(
    tx: Tx,
    accountId: string,
    filter: {
      contractId?: string;
      personId?: string;
      activity?: string;
      billableClass?: string;
      from: string;
      to: string;
    },
    limit = 1000,
  ): Promise<(TimeEntryRow & { ticket_number: string | null; bucket_label: string | null; contract_key: string })[]> {
    return this.many(
      tx,
      `select e.*, t.number::text as ticket_number, b.label as bucket_label, c.key as contract_key
         from acct.time_entries e
         join acct.contracts c on c.id = e.contract_id
         left join acct.tickets t on t.id = e.ticket_id
         left join acct.non_ticket_buckets b on b.id = e.bucket_id
        where e.account_id = $1 and e.performed_on between $2 and $3
          and ($4::uuid is null or e.contract_id = $4)
          and ($5::text is null or e.person_id = $5)
          and ($6::text is null or e.activity_type = $6)
          and ($7::text is null or e.billable_class = $7)
        order by e.performed_on desc, e.created_at desc limit $8`,
      [
        accountId,
        filter.from,
        filter.to,
        filter.contractId ?? null,
        filter.personId ?? null,
        filter.activity ?? null,
        filter.billableClass ?? null,
        limit,
      ],
    );
  }

  /** The comp-time report (TB-13): non-standard entries on comp-time contracts that carried no premium when logged. */
  compTimeOfAccount(
    tx: Tx,
    accountId: string,
    from: string,
    to: string,
  ): Promise<(TimeEntryRow & { contract_key: string; ticket_number: string | null })[]> {
    return this.many(
      tx,
      `select e.*, c.key as contract_key, t.number::text as ticket_number
         from acct.time_entries e
         join acct.contracts c on c.id = e.contract_id
         left join acct.tickets t on t.id = e.ticket_id
        where e.account_id = $1 and e.performed_on between $2 and $3
          and e.after_hours_class <> 'standard' and e.rate_multiplier = 1 and c.after_hours_handling = 'comp_time'
        order by e.performed_on, e.created_at`,
      [accountId, from, to],
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
  ): Promise<
    (TimeEntryRow & { ticket_number: string | null; bucket_label: string | null; adjusted_minutes: number })[]
  > {
    return this.many(
      tx,
      `select e.*, t.number::text as ticket_number, b.label as bucket_label,
              e.minutes + coalesce((select sum(a.delta_minutes) from acct.time_adjustments a where a.entry_id = e.id), 0)::int as adjusted_minutes
         from acct.time_entries e
         left join acct.tickets t on t.id = e.ticket_id
         left join acct.non_ticket_buckets b on b.id = e.bucket_id
        where e.person_id = $1 and e.performed_on between $2 and $3
        order by e.performed_on, e.created_at`,
      [personId, from, to],
    );
  }

  /** The person's working calendar and holiday dates for the unlogged computation; undefined without a roster row. */
  async personCalendarOfUser(
    tx: Tx,
    userId: string,
  ): Promise<
    { workingDays: number[]; hoursPerDay: number; holidays: string[]; holidayCalendarName: string | null } | undefined
  > {
    const row = await this.maybeOne<{
      working_days: number[];
      hours_per_day: string;
      holiday_calendar_id: string | null;
      holiday_calendar_name: string | null;
    }>(
      tx,
      `select c.working_days, c.hours_per_day, p.holiday_calendar_id, h.name as holiday_calendar_name
         from op.people p
         left join op.person_calendars c on c.person_id = p.id
         left join op.holiday_calendars h on h.id = p.holiday_calendar_id
        where p.user_id = $1 and p.is_active`,
      [userId],
    );
    if (!row || !row.working_days) return undefined;
    const holidays = row.holiday_calendar_id
      ? await this.many<{ date: string }>(tx, 'select date::text as date from op.holidays where calendar_id = $1', [
          row.holiday_calendar_id,
        ])
      : [];
    return {
      workingDays: row.working_days,
      hoursPerDay: Number(row.hours_per_day),
      holidays: holidays.map((h) => h.date),
      holidayCalendarName: row.holiday_calendar_name,
    };
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

  billingPeriodsOf(tx: Tx, accountId: string): Promise<BillingPeriodRow[]> {
    return this.many<BillingPeriodRow>(
      tx,
      'select * from acct.billing_periods where account_id = $1 order by starts_on desc',
      [accountId],
    );
  }

  billingPeriod(tx: Tx, id: string): Promise<BillingPeriodRow> {
    return this.one<BillingPeriodRow>(tx, 'billing_period', 'select * from acct.billing_periods where id = $1', [id]);
  }

  updateBillingPeriod(
    tx: Tx,
    id: string,
    version: number,
    assignments: Record<string, unknown>,
  ): Promise<BillingPeriodRow> {
    const values: Record<string, unknown> = { ...assignments };
    if ('summary' in values && values.summary !== null) values.summary = JSON.stringify(values.summary);
    return this.updateVersioned<BillingPeriodRow>(tx, 'billing_period', 'acct.billing_periods', id, version, values);
  }

  /** Every entry and adjustment dated in the range, joined to the names the finance file carries (TB-14). */
  financeLines(tx: Tx, accountId: string, from: string, to: string): Promise<FinanceLine[]> {
    return this.many<{
      kind: 'entry' | 'adjustment';
      id: string;
      entry_id: string;
      account_key: string;
      contract_key: string;
      person_id: string;
      person_name: string;
      role: string | null;
      performed_on: string;
      minutes: number;
      activity_type: string;
      billable_class: string;
      rate_snapshot: string | null;
      rate_multiplier: string;
      currency: string;
      ticket_key: string | null;
      after_hours_class: string;
      reason: string | null;
    }>(
      tx,
      `select 'entry' as kind, e.id, e.id as entry_id, a.key as account_key, c.key as contract_key,
              e.person_id, e.person_name, p.role, e.performed_on::text as performed_on, e.minutes, e.activity_type,
              e.billable_class, e.rate_snapshot, e.rate_multiplier, c.currency,
              case when t.number is null then null else 'CS' || lpad(t.number::text, 7, '0') end as ticket_key,
              e.after_hours_class, null::text as reason, e.created_at
         from acct.time_entries e
         join acct.contracts c on c.id = e.contract_id
         join op.accounts a on a.id = e.account_id
         left join acct.tickets t on t.id = e.ticket_id
         left join op.people p on p.user_id::text = e.person_id
        where e.account_id = $1 and e.performed_on between $2 and $3
       union all
       select 'adjustment' as kind, adj.id, e.id as entry_id, a.key, c.key,
              e.person_id, e.person_name, p.role, adj.performed_on::text, adj.delta_minutes, e.activity_type,
              coalesce(adj.new_billable_class, e.billable_class), e.rate_snapshot, e.rate_multiplier, c.currency,
              case when t.number is null then null else 'CS' || lpad(t.number::text, 7, '0') end,
              e.after_hours_class, adj.reason, adj.created_at
         from acct.time_adjustments adj
         join acct.time_entries e on e.id = adj.entry_id
         join acct.contracts c on c.id = adj.contract_id
         join op.accounts a on a.id = adj.account_id
         left join acct.tickets t on t.id = e.ticket_id
         left join op.people p on p.user_id::text = e.person_id
        where adj.account_id = $1 and adj.performed_on between $2 and $3
       order by performed_on, created_at`,
      [accountId, from, to],
    ).then((rows) =>
      rows.map((row) => ({
        ...row,
        rate_snapshot: row.rate_snapshot === null ? null : Number(row.rate_snapshot),
        rate_multiplier: Number(row.rate_multiplier),
      })),
    );
  }

  insertBillingExport(
    tx: Tx,
    input: {
      accountId: string;
      periodId: string;
      format: 'xlsx' | 'csv';
      objectKey: string;
      checksum: string;
      rowCount: number;
      producedBy: string;
    },
  ): Promise<BillingExportRow> {
    return this.one<BillingExportRow>(
      tx,
      'billing_export',
      `insert into acct.billing_exports (account_id, billing_period_id, format, object_key, checksum, row_count, produced_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [
        input.accountId,
        input.periodId,
        input.format,
        input.objectKey,
        input.checksum,
        input.rowCount,
        input.producedBy,
      ],
    );
  }

  billingExportsOf(tx: Tx, periodId: string): Promise<BillingExportRow[]> {
    return this.many<BillingExportRow>(
      tx,
      'select * from acct.billing_exports where billing_period_id = $1 order by produced_at desc',
      [periodId],
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
}
