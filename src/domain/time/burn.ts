/**
 * Consumption math (Time, Contracts & Budget functional 5; Domain Model
 * invariant 4: the server computes burn-down). Pure over entries and
 * adjustments; classes that do not consume the contract are reported but
 * not subtracted.
 */
export interface ConsumptionLine {
  readonly activity_type: string;
  readonly billable_class: string;
  readonly minutes: number;
}

export interface BillableClassSpec {
  readonly key: string;
  readonly consumes_contract: boolean;
}

export interface PeriodInput {
  readonly starts_on: string;
  readonly ends_on: string;
  readonly contracted_minutes: number;
  readonly carried_over_minutes: number;
}

export interface ContractPosition {
  readonly period: { starts_on: string; ends_on: string; days_total: number; days_elapsed: number };
  readonly contracted_minutes: number;
  readonly carried_over_minutes: number;
  readonly available_minutes: number;
  readonly consumed_minutes: number;
  readonly non_consuming_minutes: number;
  readonly remaining_minutes: number;
  readonly percent_consumed: number;
  readonly percent_elapsed: number;
  /** Consumed minutes projected to the period end at the current daily rate. */
  readonly projected_minutes: number;
  readonly status: 'on_track' | 'watch' | 'over';
  readonly by_class: Record<string, number>;
  readonly by_activity: Record<string, number>;
}

export function position(
  period: PeriodInput,
  lines: readonly ConsumptionLine[],
  classes: readonly BillableClassSpec[],
  today: Date,
): ContractPosition {
  const consuming = new Set(classes.filter((spec) => spec.consumes_contract).map((spec) => spec.key));
  const byClass: Record<string, number> = {};
  const byActivity: Record<string, number> = {};
  let consumed = 0;
  let nonConsuming = 0;
  for (const line of lines) {
    byClass[line.billable_class] = (byClass[line.billable_class] ?? 0) + line.minutes;
    byActivity[line.activity_type] = (byActivity[line.activity_type] ?? 0) + line.minutes;
    if (consuming.has(line.billable_class)) consumed += line.minutes;
    else nonConsuming += line.minutes;
  }
  const available = period.contracted_minutes + period.carried_over_minutes;
  const start = new Date(`${period.starts_on}T00:00:00Z`);
  const end = new Date(`${period.ends_on}T00:00:00Z`);
  const daysTotal = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
  const daysElapsed = Math.min(
    daysTotal,
    Math.max(0, Math.floor((today.getTime() - start.getTime()) / 86_400_000) + 1),
  );
  const percentConsumed = available > 0 ? Math.round((consumed / available) * 1000) / 10 : 0;
  const percentElapsed = Math.round((daysElapsed / daysTotal) * 1000) / 10;
  const projected = daysElapsed > 0 ? Math.round((consumed / daysElapsed) * daysTotal) : 0;
  const status: ContractPosition['status'] =
    available === 0
      ? 'on_track'
      : consumed > available
        ? 'over'
        : projected > available || percentConsumed > percentElapsed + 15
          ? 'watch'
          : 'on_track';
  return {
    period: { starts_on: period.starts_on, ends_on: period.ends_on, days_total: daysTotal, days_elapsed: daysElapsed },
    contracted_minutes: period.contracted_minutes,
    carried_over_minutes: period.carried_over_minutes,
    available_minutes: available,
    consumed_minutes: consumed,
    non_consuming_minutes: nonConsuming,
    remaining_minutes: Math.max(0, available - consumed),
    percent_consumed: percentConsumed,
    percent_elapsed: percentElapsed,
    projected_minutes: projected,
    status,
    by_class: byClass,
    by_activity: byActivity,
  };
}
