import type { Measures, Period, Ratio } from './measures.js';
import { narrativeFor, packNarrative, type PackDocument, type PackNarrative, type PackTable } from './pdf.js';

/**
 * The quarterly business review pack (DR-08; Dashboards & Report Packs
 * functional 5.12: "quarterly pack with the WSR structure plus a
 * quarter-over-quarter section, a knowledge base contribution section
 * (articles created, deflections), a capacity and roster section, and a
 * renewal section. Same template and review flow").
 *
 * It is a second `PackDocument` over the same description the weekly report
 * uses, so it renders through the same PDF writer, the same deck writer and
 * the same review, edit, regenerate and approve flow, and the two can never
 * drift apart in layout. Everything here is pure over frozen numbers.
 */

/**
 * Quarters are calendar quarters in UTC. No account carries a fiscal year:
 * `acct.account_settings` has no such column and nothing in the product
 * sets one, so there is no fiscal calendar to prefer. When a fiscal start
 * month arrives it belongs exactly here, as an offset applied before the
 * quarter is chosen, and no caller changes.
 */
export function quarterOf(reference: Date): Period {
  const quarter = Math.floor(reference.getUTCMonth() / 3);
  return {
    start: new Date(Date.UTC(reference.getUTCFullYear(), quarter * 3, 1)),
    end: new Date(Date.UTC(reference.getUTCFullYear(), quarter * 3 + 3, 1)),
  };
}

/** The whole quarter before the one a date falls in. */
export function previousQuarter(reference: Date): Period {
  return quarterBefore(quarterOf(reference));
}

/** The quarter immediately before a quarter. */
export function quarterBefore(period: Period): Period {
  const start = period.start;
  return {
    start: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 3, 1)),
    end: start,
  };
}

/** "2026 Q3", as the cover and the comparison column name it. */
export function quarterLabel(period: Period): string {
  return `${period.start.getUTCFullYear()} Q${Math.floor(period.start.getUTCMonth() / 3) + 1}`;
}

/**
 * What a quarterly pack freezes in `acct.report_packs.measures`. A weekly
 * pack stores its `Measures` there and nothing else; a quarterly one needs
 * the knowledge, roster and renewal facts and the quarter it was compared
 * against as well, because "Regenerate with my edits" must rebuild the
 * document without recomputing a single figure the reviewer has read. The
 * `kind` marks the shape so a reader never has to guess which it is.
 */
export interface StoredQbr {
  readonly kind: 'qbr';
  readonly facts: QbrFacts;
  readonly previous: QbrComparison | null;
}

export function storedQbr(facts: QbrFacts, previous: QbrComparison | null): StoredQbr {
  return { kind: 'qbr', facts, previous };
}

function revivePeriod(period: { start: string | Date; end: string | Date }): Period {
  return { start: new Date(period.start), end: new Date(period.end) };
}

/**
 * A stored quarterly pack read back: JSON turned the two instants of every
 * period into strings, and the document builder wants dates. Anything that
 * is not a quarterly blob comes back as null, so a caller can fall back to
 * the weekly path rather than render nonsense.
 */
export function reviveQbr(stored: unknown): StoredQbr | null {
  const raw = stored as Partial<StoredQbr> | null;
  if (!raw || raw.kind !== 'qbr' || !raw.facts?.period) return null;
  return {
    kind: 'qbr',
    facts: { ...raw.facts, period: revivePeriod(raw.facts.period as unknown as { start: string; end: string }) },
    previous: raw.previous
      ? {
          ...raw.previous,
          period: revivePeriod(raw.previous.period as unknown as { start: string; end: string }),
        }
      : null,
  };
}

/** The satisfaction block: the ticket-close mean and the relationship survey beside it. */
export interface QbrSatisfaction {
  readonly responses: number;
  readonly mean: number | null;
  readonly quarterly: { readonly period: string; readonly responses: number; readonly average: number | null } | null;
}

/** Articles written and used in the quarter (functional 5.12: articles created, deflections). */
export interface QbrKnowledge {
  readonly articles_created: number;
  readonly versions_published: number;
  readonly solutions_linked: number;
  readonly resolved_by_article: number;
}

/** Who worked the account in the quarter and for how long. */
export interface QbrRoster {
  readonly people: number;
  readonly minutes: number;
  readonly by_person: readonly { readonly name: string; readonly minutes: number }[];
}

/** One contract as the renewal section reads it. */
export interface QbrRenewal {
  readonly name: string;
  readonly model: string;
  readonly period_ends_on: string | null;
  readonly days_to_renewal: number | null;
  readonly available_minutes: number;
  readonly consumed_minutes: number;
}

export interface QbrFacts {
  readonly period: Period;
  readonly measures: Measures;
  readonly satisfaction: QbrSatisfaction;
  readonly knowledge: QbrKnowledge;
  readonly roster: QbrRoster;
  readonly renewals: readonly QbrRenewal[];
  readonly notable: readonly {
    key: string;
    title: string;
    state: string;
    priority: string;
    age_days: number;
  }[];
}

/** The previous quarter, where there is one to compare against. */
export interface QbrComparison {
  readonly period: Period;
  readonly measures: Measures;
  readonly satisfaction: QbrSatisfaction;
}

/** The sections of a quarterly pack a narrative may speak to, in document order. */
export const QBR_NARRATIVE_KEYS = [
  'headline',
  'service_levels',
  'quarter_over_quarter',
  'backlog',
  'consumption',
  'satisfaction',
  'knowledge',
  'roster',
  'outlook',
] as const;

export type QbrNarrativeKey = (typeof QBR_NARRATIVE_KEYS)[number];

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function hours(minutes: number): string {
  return String(Math.round(minutes / 60));
}

function percent(ratio: Ratio): string {
  return ratio.value === null ? 'n/a' : `${ratio.value}%`;
}

function score(mean: number | null): string {
  return mean === null ? 'n/a' : `${Math.round(mean * 10) / 10} of 5`;
}

/** A change between two quarters, in the unit the row is measured in. */
function change(now: number | null, before: number | null, suffix = ''): string {
  if (now === null || before === null) return 'n/a';
  const delta = Math.round((now - before) * 10) / 10;
  return delta === 0 ? 'no change' : `${delta > 0 ? '+' : ''}${delta}${suffix}`;
}

function comparison(current: QbrFacts, previous: QbrComparison | null): PackTable | null {
  if (!previous) return null;
  const rows: string[][] = [];
  const line = (
    label: string,
    now: number | null,
    before: number | null,
    format: (value: number) => string,
    suffix = '',
  ) =>
    rows.push([
      label,
      now === null ? 'n/a' : format(now),
      before === null ? 'n/a' : format(before),
      change(now, before, suffix),
    ]);
  // Only measures the period owns are compared. "Open" is a count of the
  // backlog as it stands right now, so the same number would appear in both
  // columns and mean nothing; it lives on the summary tiles instead.
  const whole = (value: number) => String(value);
  line('Requests raised', current.measures.volume_created, previous.measures.volume_created, whole);
  line('Requests resolved', current.measures.volume_resolved, previous.measures.volume_resolved, whole);
  line(
    'Response targets met',
    current.measures.sla_response_attainment.value,
    previous.measures.sla_response_attainment.value,
    (value) => `${value}%`,
    ' pts',
  );
  line(
    'Resolution targets met',
    current.measures.sla_resolution_attainment.value,
    previous.measures.sla_resolution_attainment.value,
    (value) => `${value}%`,
    ' pts',
  );
  line(
    'Average time to resolve',
    current.measures.mttr_minutes === null ? null : Math.round(current.measures.mttr_minutes / 60),
    previous.measures.mttr_minutes === null ? null : Math.round(previous.measures.mttr_minutes / 60),
    (value) => `${value} h`,
    ' h',
  );
  line(
    'Work that came back',
    current.measures.reopen_rate.value,
    previous.measures.reopen_rate.value,
    (value) => `${value}%`,
    ' pts',
  );
  line(
    'Contract hours consumed',
    Math.round(current.measures.consumption_minutes / 60),
    Math.round(previous.measures.consumption_minutes / 60),
    (value) => `${value} h`,
    ' h',
  );
  line('Satisfaction', current.satisfaction.mean, previous.satisfaction.mean, (value) => score(value));
  return {
    caption: `${quarterLabel(current.period)} against ${quarterLabel(previous.period)}`,
    columns: ['Measure', quarterLabel(current.period), quarterLabel(previous.period), 'Change'],
    rows,
  };
}

/**
 * The quarterly pack as a document. The weekly report's own four sections
 * keep their shape and their narrative keys, so a reader of both sees the
 * same headings saying the same things, and the four quarterly sections
 * follow them.
 */
export function qbrDocument(
  accountName: string,
  facts: QbrFacts,
  previous: QbrComparison | null,
  narrative: string | PackNarrative,
  generatedAt = new Date(),
): PackDocument {
  const prose = packNarrative(narrative);
  const measures = facts.measures;
  const ages = Object.entries(measures.backlog_by_age)
    .filter(([, count]) => count > 0)
    .map(([bucket, count]) => [
      bucket.replace('_', ' to ').replace('d', ' days').replace('plus', 'or more'),
      String(count),
    ]);
  const quarterOverQuarter = comparison(facts, previous);
  const consumed = facts.renewals.reduce((sum, row) => sum + row.consumed_minutes, 0);
  const available = facts.renewals.reduce((sum, row) => sum + row.available_minutes, 0);
  return {
    title: 'Quarterly business review',
    accountName,
    periodStart: day(facts.period.start),
    periodEnd: day(new Date(facts.period.end.getTime() - 1)),
    generatedAt: generatedAt.toISOString(),
    sections: [
      {
        title: `Quarter summary: ${quarterLabel(facts.period)}`,
        paragraphs: [narrativeFor(prose, 'headline')].filter(Boolean),
        tiles: [
          { label: 'Requests raised', value: String(measures.volume_created) },
          { label: 'Requests resolved', value: String(measures.volume_resolved) },
          { label: 'Open now', value: String(measures.open_tickets) },
        ],
      },
      {
        title: 'Service levels',
        paragraphs: [narrativeFor(prose, 'service_levels')].filter(Boolean),
        tiles: [
          { label: 'Past target', value: String(measures.breached_now) },
          { label: 'At risk', value: String(measures.at_risk_now) },
          { label: 'Response met', value: percent(measures.sla_response_attainment) },
          { label: 'Resolution met', value: percent(measures.sla_resolution_attainment) },
          {
            label: 'Avg time to resolve',
            value: measures.mttr_minutes === null ? 'n/a' : `${hours(measures.mttr_minutes)} h`,
          },
          { label: 'Work that came back', value: percent(measures.reopen_rate) },
        ],
      },
      {
        title: 'Quarter over quarter',
        paragraphs: [
          narrativeFor(prose, 'quarter_over_quarter'),
          quarterOverQuarter ? '' : 'This is the first quarter on record, so there is nothing to compare it against.',
        ].filter(Boolean),
        tables: quarterOverQuarter ? [quarterOverQuarter] : [],
      },
      {
        title: 'Backlog and notable requests',
        paragraphs: [narrativeFor(prose, 'backlog')].filter(Boolean),
        tables: [
          ...(ages.length > 0 ? [{ caption: 'Backlog by age', columns: ['Age', 'Open'], rows: ages }] : []),
          ...(facts.notable.length > 0
            ? [
                {
                  caption: 'Notable requests',
                  columns: ['Key', 'Title', 'State', 'Priority', 'Age'],
                  rows: facts.notable.map((row) => [
                    row.key,
                    row.title.slice(0, 60),
                    row.state.replace(/_/g, ' '),
                    row.priority.toUpperCase(),
                    `${row.age_days} d`,
                  ]),
                },
              ]
            : []),
        ],
      },
      {
        title: 'Consumption and burn',
        paragraphs: [
          `${hours(measures.consumption_minutes)} contract hours consumed this quarter; ${hours(measures.time_logged_minutes)} hours logged in total.`,
          narrativeFor(prose, 'consumption'),
        ].filter(Boolean),
        tables:
          facts.renewals.length > 0
            ? [
                {
                  caption: 'Against the contract',
                  columns: ['Contract', 'Model', 'Available', 'Consumed', 'Remaining'],
                  rows: facts.renewals.map((row) => [
                    row.name,
                    row.model.replace(/_/g, ' '),
                    `${hours(row.available_minutes)} h`,
                    `${hours(row.consumed_minutes)} h`,
                    `${hours(Math.max(0, row.available_minutes - row.consumed_minutes))} h`,
                  ]),
                },
              ]
            : [],
      },
      {
        title: 'Satisfaction',
        paragraphs: [
          facts.satisfaction.responses === 0
            ? 'Nobody scored a closed request this quarter.'
            : `${facts.satisfaction.responses} scores on closed requests, averaging ${score(facts.satisfaction.mean)}.`,
          facts.satisfaction.quarterly
            ? `The relationship survey for ${facts.satisfaction.quarterly.period} drew ${facts.satisfaction.quarterly.responses} responses, averaging ${score(facts.satisfaction.quarterly.average)}.`
            : 'The quarterly relationship survey has no responses for this period.',
          narrativeFor(prose, 'satisfaction'),
        ].filter(Boolean),
      },
      {
        title: 'Knowledge base contribution',
        paragraphs: [narrativeFor(prose, 'knowledge')].filter(Boolean),
        tiles: [
          { label: 'Articles written', value: String(facts.knowledge.articles_created) },
          { label: 'Versions published', value: String(facts.knowledge.versions_published) },
          { label: 'Linked to requests', value: String(facts.knowledge.solutions_linked) },
          { label: 'Requests they resolved', value: String(facts.knowledge.resolved_by_article) },
        ],
      },
      {
        title: 'Capacity and roster',
        paragraphs: [
          facts.roster.people === 0
            ? 'Nobody logged time against this account this quarter.'
            : `${facts.roster.people} people logged ${hours(facts.roster.minutes)} hours on this account.`,
          narrativeFor(prose, 'roster'),
        ].filter(Boolean),
        tables:
          facts.roster.by_person.length > 0
            ? [
                {
                  caption: 'Hours by person',
                  columns: ['Person', 'Hours'],
                  rows: facts.roster.by_person.map((row) => [row.name, hours(row.minutes)]),
                },
              ]
            : [],
      },
      {
        title: 'Renewal and outlook',
        paragraphs: [
          ...facts.renewals.map((row) =>
            row.period_ends_on === null
              ? `${row.name} runs without a period end date.`
              : `${row.name} runs to ${row.period_ends_on}${row.days_to_renewal === null ? '' : `, ${row.days_to_renewal} days away`}.`,
          ),
          available > 0
            ? `${hours(consumed)} of ${hours(available)} contracted hours were used this quarter.`
            : 'No contracted hours were set for this quarter.',
          narrativeFor(prose, 'outlook'),
        ].filter(Boolean),
      },
    ],
  };
}

/**
 * The templated words a quarterly pack ships with when Axel writes none
 * (the `wsr_narrative` capability has no builder). One paragraph per
 * section the numbers can speak for; a reviewer rewrites what they want.
 */
export function templatedQbrNarrative(
  accountName: string,
  facts: QbrFacts,
  previous: QbrComparison | null,
): PackNarrative {
  const measures = facts.measures;
  const attainment = measures.sla_resolution_attainment.value;
  const sections = [
    {
      key: 'headline',
      text: `${accountName}: ${quarterLabel(facts.period)}. ${measures.volume_created} requests were raised and ${measures.volume_resolved} resolved, with ${measures.open_tickets} open now.`,
    },
    {
      key: 'service_levels',
      text:
        attainment === null
          ? 'No resolution targets came due this quarter.'
          : `Resolution targets were met on ${attainment} percent of the requests that came due.`,
    },
    ...(previous
      ? [
          {
            key: 'quarter_over_quarter',
            text: `Compared with ${quarterLabel(previous.period)}, volume moved from ${previous.measures.volume_created} raised to ${measures.volume_created}.`,
          },
        ]
      : []),
    {
      key: 'consumption',
      text: `${hours(measures.consumption_minutes)} contract hours were consumed.`,
    },
    {
      key: 'knowledge',
      text: `${facts.knowledge.articles_created} articles were written and ${facts.knowledge.solutions_linked} were linked to requests.`,
    },
  ];
  return { sections: sections.filter((section) => section.text.trim().length > 0) };
}
