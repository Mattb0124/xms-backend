/**
 * Pure rule (Accounts & Administration technical 3.1): the operator must
 * always keep at least one active administrator. Used by deactivate and by
 * role reconciliation before the write happens.
 */
export class LastAdministratorError extends Error {
  constructor() {
    super('The last active administrator cannot be removed or deactivated');
  }
}

export interface AdminCandidate {
  readonly userId: string;
  readonly active: boolean;
  readonly isAdministrator: boolean;
}

/**
 * `after` describes the administrators as they would be after the change.
 * Throws when no active administrator would remain.
 */
export function assertNotLastAdmin(after: readonly AdminCandidate[]): void {
  const remaining = after.filter((candidate) => candidate.active && candidate.isAdministrator);
  if (remaining.length === 0) throw new LastAdministratorError();
}
