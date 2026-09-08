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
}

export type MissingItem =
  | 'resolution_code'
  | 'unknown_resolution_code'
  | 'resolution_notes'
  | 'solution_link'
  | 'time_logged'
  | 'pause_reason'
  | 'change_window';

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
    if (!resolution.notes?.trim()) missing.push('resolution_notes');
  }
  const noSolution = Boolean(resolution.code && facts.noSolutionCodes.has(resolution.code));
  if (requirements.includes('solution_link') && !noSolution) {
    if (!resolution.solutionArticleId && !resolution.solutionCandidate) missing.push('solution_link');
  }
  if (requirements.includes('time_logged') && facts.loggedMinutes <= 0 && !resolution.timeExemptionReason?.trim()) {
    missing.push('time_logged');
  }
  // TM-10: a Change must belong to a scheduled change window before Scheduled.
  if (requirements.includes('change_window') && !facts.inChangeWindow) missing.push('change_window');
  return missing;
}
