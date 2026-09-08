import type { Ratio } from './measures.js';

/**
 * The account health score (DR-09; Dashboards & Report Packs functional
 * 5.12: "composite of resolution attainment, CSAT, budget position, reopen
 * rate and engagement signals (portal logins, survey responses), weighted
 * per operator configuration, shown on the portfolio view with the
 * reasons").
 *
 * Pure over inputs the repository gathers, so the account tile, the
 * per-account strip on the Operations dashboard and the tests share one
 * definition. Nothing is stored: the score is recomputed on every read.
 * The spec asks for no history of it, and a stored score is a number that
 * goes stale the moment a ticket moves; when history is wanted, the daily
 * snapshot table already exists to hold it.
 *
 * The score is reported with its factors, so a screen never shows a number
 * nobody can argue with: every factor names its weight, its own 0 to 100
 * reading and the raw inputs behind it.
 */
export type HealthFactorKey = 'sla_resolution' | 'csat' | 'budget' | 'reopen_rate' | 'engagement';

/**
 * The weights, as one named constant. The spec's later state makes them
 * configurable per operator; no configuration surface exists yet, so this
 * is the single default, and a configuration row would replace this object
 * rather than scatter numbers through the service.
 *
 * Why these five carry what they carry:
 *
 * - `sla_resolution` (30) is the promise in the contract, and the one
 *   factor a client can hold up against a signed service level, so it
 *   carries the most.
 * - `csat` (25) is the client's own verdict and the only input the client
 *   writes; it ranks second precisely because it is not derived from our
 *   own records.
 * - `budget` (20) is the commercial half of the relationship: a retainer
 *   burning ahead of its calendar ends in a difficult conversation
 *   whatever the service levels say.
 * - `reopen_rate` (15) is the quality behind the attainment. Work that
 *   comes back was never finished, and the SLA clock does not see it.
 * - `engagement` (10) is the weakest signal and moves the score least: a
 *   quiet client can be a perfectly happy one, so it nudges rather than
 *   decides.
 *
 * They sum to 100. A factor that cannot be measured in the window drops
 * out and the rest are renormalized, so an account with no surveys yet is
 * not scored as though it had bad ones.
 */
export const HEALTH_WEIGHTS: Record<HealthFactorKey, number> = {
  sla_resolution: 30,
  csat: 25,
  budget: 20,
  reopen_rate: 15,
  engagement: 10,
};

export const HEALTH_LABELS: Record<HealthFactorKey, string> = {
  sla_resolution: 'Resolution targets met',
  csat: 'Client satisfaction',
  budget: 'Budget position',
  reopen_rate: 'Work that came back',
  engagement: 'Client engagement',
};

/** Green is healthy, amber is worth a conversation, red is an escalation. */
export const HEALTH_BANDS = { green: 80, amber: 60 } as const;

export type HealthBand = 'green' | 'amber' | 'red' | 'unrated';

/**
 * A client that signs in about once a week is as engaged as this score
 * cares to measure; more often does not make the account healthier.
 */
export const ENGAGED_SIGNINS_PER_WEEK = 1;

/** A quarter of the resolved work coming back is a zero on quality. */
export const REOPEN_RATE_FLOOR_PERCENT = 25;

export interface BudgetInput {
  readonly availableMinutes: number;
  readonly consumedMinutes: number;
  /** How far through its own period the contract is, 0 to 100. */
  readonly percentElapsed: number;
}

export interface EngagementInput {
  readonly portalEnabled: boolean;
  readonly portalSignins: number;
  readonly surveysSent: number;
  readonly surveysAnswered: number;
  readonly windowDays: number;
}

export interface HealthInputs {
  readonly slaResolution: Ratio;
  readonly reopenRate: Ratio;
  /** The mean ticket-close score on the one to five scale, and how many said it. */
  readonly csat: { readonly responses: number; readonly mean: number | null };
  /** The current contract period, or null where the account has none open. */
  readonly budget: BudgetInput | null;
  readonly engagement: EngagementInput;
}

export interface HealthFactor {
  readonly key: HealthFactorKey;
  readonly label: string;
  readonly weight: number;
  /** 0 to 100, or null where the window holds nothing to judge. */
  readonly score: number | null;
  /** The points this factor puts into the final score, after renormalization. */
  readonly contribution: number;
  readonly detail: Record<string, number | boolean | null>;
}

export interface HealthScore {
  readonly score: number | null;
  readonly band: HealthBand;
  /** How much of the hundred was measurable this window. */
  readonly measured_weight: number;
  readonly factors: readonly HealthFactor[];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Attainment is already a percentage of the targets that came due. */
function slaScore(ratio: Ratio): number | null {
  return ratio.value === null ? null : clamp(ratio.value);
}

/**
 * The one to five scale as a percentage: a straight three is the middle of
 * the scale and scores fifty, a five scores a hundred.
 */
function csatScore(mean: number | null): number | null {
  return mean === null ? null : clamp(((mean - 1) / 4) * 100);
}

/**
 * Burn against the calendar, not against the total: a period half gone with
 * half its hours used is perfectly healthy. Every point of budget consumed
 * ahead of the period elapsed costs two, so a contract ten points ahead of
 * its calendar scores eighty and one fifty points ahead scores zero.
 */
function budgetScore(budget: BudgetInput | null): number | null {
  if (!budget || budget.availableMinutes <= 0) return null;
  const percentConsumed = (budget.consumedMinutes / budget.availableMinutes) * 100;
  return clamp(100 - Math.max(0, percentConsumed - budget.percentElapsed) * 2);
}

/** Work that came back, as a share of the work that was resolved. */
function reopenScore(ratio: Ratio): number | null {
  if (ratio.value === null) return null;
  return clamp(100 - (ratio.value / REOPEN_RATE_FLOOR_PERCENT) * 100);
}

/**
 * Signing in and answering surveys, weighed half and half. An account whose
 * portal is switched off is judged on its surveys alone, and one with
 * neither portal nor surveys is not judged at all: silence we never asked
 * for is not a signal.
 */
function engagementScore(input: EngagementInput): number | null {
  const expected = Math.max(1, input.windowDays / 7) * ENGAGED_SIGNINS_PER_WEEK;
  const signins = input.portalEnabled ? Math.min(1, input.portalSignins / expected) : null;
  const answered = input.surveysSent === 0 ? null : input.surveysAnswered / input.surveysSent;
  if (signins === null && answered === null) return null;
  if (signins === null) return clamp(answered! * 100);
  if (answered === null) return clamp(signins * 100);
  return clamp((signins * 0.5 + answered * 0.5) * 100);
}

export function healthBand(score: number | null): HealthBand {
  if (score === null) return 'unrated';
  if (score >= HEALTH_BANDS.green) return 'green';
  if (score >= HEALTH_BANDS.amber) return 'amber';
  return 'red';
}

/**
 * The composed score with the reasons behind it. Factors with nothing to
 * measure contribute nothing and are excluded from the denominator, so
 * `measured_weight` says how much of the hundred the score actually stands
 * on and a screen can say "on 75 of 100 points of signal".
 */
export function computeHealth(inputs: HealthInputs): HealthScore {
  const scores: Record<HealthFactorKey, number | null> = {
    sla_resolution: slaScore(inputs.slaResolution),
    csat: csatScore(inputs.csat.mean),
    budget: budgetScore(inputs.budget),
    reopen_rate: reopenScore(inputs.reopenRate),
    engagement: engagementScore(inputs.engagement),
  };
  const details: Record<HealthFactorKey, Record<string, number | boolean | null>> = {
    sla_resolution: {
      attainment_percent: inputs.slaResolution.value,
      met: inputs.slaResolution.numerator,
      due: inputs.slaResolution.denominator,
    },
    csat: { mean_score: inputs.csat.mean, responses: inputs.csat.responses },
    budget: {
      available_minutes: inputs.budget?.availableMinutes ?? null,
      consumed_minutes: inputs.budget?.consumedMinutes ?? null,
      percent_consumed:
        inputs.budget && inputs.budget.availableMinutes > 0
          ? round((inputs.budget.consumedMinutes / inputs.budget.availableMinutes) * 100)
          : null,
      percent_elapsed: inputs.budget ? round(inputs.budget.percentElapsed) : null,
    },
    reopen_rate: {
      reopened_percent: inputs.reopenRate.value,
      reopened: inputs.reopenRate.numerator,
      resolved: inputs.reopenRate.denominator,
    },
    engagement: {
      portal_enabled: inputs.engagement.portalEnabled,
      portal_signins: inputs.engagement.portalSignins,
      surveys_sent: inputs.engagement.surveysSent,
      surveys_answered: inputs.engagement.surveysAnswered,
    },
  };
  const keys = Object.keys(HEALTH_WEIGHTS) as HealthFactorKey[];
  const measured = keys.filter((key) => scores[key] !== null);
  const measuredWeight = measured.reduce((sum, key) => sum + HEALTH_WEIGHTS[key], 0);
  const total = measured.reduce((sum, key) => sum + scores[key]! * HEALTH_WEIGHTS[key], 0);
  const score = measuredWeight === 0 ? null : round(total / measuredWeight, 0);
  return {
    score,
    band: healthBand(score),
    measured_weight: measuredWeight,
    factors: keys.map((key) => ({
      key,
      label: HEALTH_LABELS[key],
      weight: HEALTH_WEIGHTS[key],
      score: scores[key] === null ? null : round(scores[key]!),
      contribution:
        scores[key] === null || measuredWeight === 0 ? 0 : round((scores[key]! * HEALTH_WEIGHTS[key]) / measuredWeight),
      detail: details[key],
    })),
  };
}
