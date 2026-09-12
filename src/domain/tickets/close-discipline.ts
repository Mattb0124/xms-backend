import type { TransitionRequirement } from './state-machine.js';

/**
 * The close discipline (Domain Model invariant 6, Ticket Management
 * technical 3.1): a ticket cannot reach a resolving state without logged
 * time (or an exemption reason), a resolution code, and a solution link or
 * a new-article candidate, unless the code is a no-solution code.
 */
export interface ResolutionInput {
  readonly code?: string | null;
  readonly notes?: string | null;
  readonly solutionArticleId?: string | null;
  readonly solutionCandidate?: boolean;
  readonly timeExemptionReason?: string | null;
}

export interface CloseDisciplineFacts {
  readonly loggedMinutes: number;
  /** The ticket belongs to a scheduled change window (TM-10). */
  readonly inChangeWindow?: boolean;
  readonly noSolutionCodes: ReadonlySet<string>;
  readonly knownCodes: ReadonlySet<string>;
  /**
   * The exemption reasons this account allows (TB-02). Only these let a
   * ticket resolve with nothing logged. Absent means the built-in set, never
   * "anything goes": a missing catalog must not open the gate.
   */
  readonly allowedExemptions?: ReadonlySet<string>;
  /**
   * How much resolution note counts as a resolution note (TB-02 under
   * revision 3). Absent means the default bar.
   */
  readonly minNotesChars?: number;
}

export type MissingItem =
  | 'resolution_code'
  | 'unknown_resolution_code'
  | 'resolution_notes'
  | 'resolution_notes_too_short'
  | 'solution_link'
  | 'time_logged'
  | 'unknown_exemption_reason'
  | 'pause_reason'
  | 'change_window';

/**
 * The reasons the workbook and Time & Budget 5.2 name. Held here as well as
 * in the seed so the rule has an answer when an account's catalog is missing
 * or malformed: the gate then falls back to these rather than to nothing,
 * which would let any string through.
 *
 * The labels live here too, not only the keys. A key-only fallback meant the
 * picker offered `administrative_close` to a human whenever the catalog was
 * unreadable, which is the sort of thing that ships.
 */
export const DEFAULT_TIME_EXEMPTION_REASONS: readonly { key: string; label: string }[] = [
  { key: 'duplicate', label: 'Duplicate of another ticket' },
  { key: 'cancelled_by_client', label: 'Cancelled by the client' },
  { key: 'resolved_by_client', label: 'Resolved by the client' },
  { key: 'administrative_close', label: 'Administrative close' },
  { key: 'merged', label: 'Merged into another ticket' },
];

/**
 * The default completeness bar. Forty characters is about one sentence: it
 * refuses "Fixed" and "done" without demanding an essay, and the account can
 * move it. The failure this exists for is a resolution record that cannot be
 * read back into a weekly report or turned into an article.
 */
export const DEFAULT_MIN_NOTES_CHARS = 40;

export interface TransitionInput {
  readonly pauseReason?: string | null;
  readonly resolution?: ResolutionInput;
}

/** Returns the list of missing items for the transition's requirements; empty means allowed. */
export function checkRequirements(
  requirements: readonly TransitionRequirement[],
  input: TransitionInput,
  facts: CloseDisciplineFacts,
): MissingItem[] {
  const missing: MissingItem[] = [];
  const resolution = input.resolution ?? {};
  if (requirements.includes('pause_reason') && !input.pauseReason) missing.push('pause_reason');
  if (requirements.includes('resolution')) {
    if (!resolution.code) missing.push('resolution_code');
    else if (!facts.knownCodes.has(resolution.code)) missing.push('unknown_resolution_code');
    const notes = resolution.notes?.trim() ?? '';
    // Empty and too-short are different answers, because they need different
    // things from the person: one has written nothing, the other has written
    // "Fixed" and needs telling what the bar is.
    if (!notes) missing.push('resolution_notes');
    else if (notes.length < minNotesChars(facts)) missing.push('resolution_notes_too_short');
  }
  const noSolution = Boolean(resolution.code && facts.noSolutionCodes.has(resolution.code));
  if (requirements.includes('solution_link') && !noSolution) {
    if (!resolution.solutionArticleId && !resolution.solutionCandidate) missing.push('solution_link');
  }
  if (requirements.includes('time_logged') && facts.loggedMinutes <= 0) {
    const reason = resolution.timeExemptionReason?.trim();
    // An exemption is one of a short list of real reasons, not a sentence
    // somebody typed. Free text here meant a full stop resolved a ticket
    // with nothing logged against it (TB-02, Time & Budget 5.2).
    if (!reason) missing.push('time_logged');
    else if (!allowedExemptions(facts).has(reason)) missing.push('unknown_exemption_reason');
  }
  // TM-10: a Change must belong to a scheduled change window before Scheduled.
  if (requirements.includes('change_window') && !facts.inChangeWindow) missing.push('change_window');
  return missing;
}

/** The bar in force, refusing a nonsensical configured value rather than trusting it. */
export function minNotesChars(facts: Pick<CloseDisciplineFacts, 'minNotesChars'>): number {
  const configured = facts.minNotesChars;
  if (configured === undefined || !Number.isFinite(configured) || configured < 0) return DEFAULT_MIN_NOTES_CHARS;
  return Math.floor(configured);
}

/** The exemption vocabulary in force; an empty or absent catalog falls back, never opens. */
export function allowedExemptions(facts: Pick<CloseDisciplineFacts, 'allowedExemptions'>): ReadonlySet<string> {
  const configured = facts.allowedExemptions;
  if (!configured || configured.size === 0) {
    return new Set(DEFAULT_TIME_EXEMPTION_REASONS.map((reason) => reason.key));
  }
  return configured;
}

/** The `close_discipline` catalog as an account configures it (TB-02). */
export interface CloseDisciplineBody {
  min_resolution_notes_chars?: number;
  time_exemption_reasons?: { key: string; label: string }[];
}

/**
 * Refuse a catalog that would weaken the gate by accident. An administrator
 * editing this is editing the rule that decides whether a ticket can be
 * closed with nothing logged against it, so a malformed body is a 400 rather
 * than a silent fallback.
 */
export function validateCloseDiscipline(body: unknown): string[] {
  const problems: string[] = [];
  if (!body || typeof body !== 'object') return ['body must be an object'];
  const { min_resolution_notes_chars: bar, time_exemption_reasons: reasons } = body as CloseDisciplineBody;
  if (bar !== undefined) {
    if (typeof bar !== 'number' || !Number.isInteger(bar) || bar < 0 || bar > 4000) {
      problems.push('min_resolution_notes_chars must be a whole number from 0 to 4000');
    }
  }
  if (reasons !== undefined) {
    if (!Array.isArray(reasons) || reasons.length === 0) {
      // Not "any reason will do": an empty list would mean no ticket can ever
      // be resolved with zero time, which is a rule nobody chose by deleting
      // every row from a table.
      problems.push('time_exemption_reasons must be a non-empty array');
    } else {
      const seen = new Set<string>();
      for (const [index, reason] of reasons.entries()) {
        const key = (reason as { key?: unknown })?.key;
        const label = (reason as { label?: unknown })?.label;
        if (typeof key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(key)) {
          problems.push(`time_exemption_reasons[${index}].key must be lower_snake_case`);
        } else if (seen.has(key)) {
          problems.push(`time_exemption_reasons[${index}].key is a duplicate of ${key}`);
        } else {
          seen.add(key);
        }
        if (typeof label !== 'string' || label.trim() === '') {
          problems.push(`time_exemption_reasons[${index}].label must be a non-empty string`);
        }
      }
    }
  }
  return problems;
}
