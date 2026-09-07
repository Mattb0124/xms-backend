/**
 * Skills matrix (Capacity & Allocation functional 5.8, technical 2.9;
 * CAP-07): the people lens is a heat map of levels; the account lens names,
 * per account and required technology, the people at the required level,
 * flagging a single point of failure where exactly one qualifies and a gap
 * where nobody does.
 */
export const SPOF_LEVEL = 3;

export interface SkillHolder {
  readonly person_id: string;
  readonly code: string;
  readonly level: number;
}

export type CoverageStatus = 'ok' | 'spof' | 'gap';

export interface Coverage {
  readonly code: string;
  readonly qualified: string[];
  readonly status: CoverageStatus;
}

/** Per required code, who is at the level and what that means for the account. */
export function coverage(
  required: readonly string[],
  holders: readonly SkillHolder[],
  requiredLevel = SPOF_LEVEL,
): Coverage[] {
  return [...new Set(required)].sort().map((code) => {
    const qualified = [
      ...new Set(holders.filter((row) => row.code === code && row.level >= requiredLevel).map((row) => row.person_id)),
    ].sort();
    const status: CoverageStatus = qualified.length === 0 ? 'gap' : qualified.length === 1 ? 'spof' : 'ok';
    return { code, qualified, status };
  });
}

export interface HeatRow {
  readonly person_id: string;
  readonly levels: Record<string, number>;
}

/** People as rows, skill codes as columns, level per cell (absent means none). */
export function heatMap(personIds: readonly string[], holders: readonly SkillHolder[]): HeatRow[] {
  return personIds.map((personId) => ({
    person_id: personId,
    levels: Object.fromEntries(holders.filter((row) => row.person_id === personId).map((row) => [row.code, row.level])),
  }));
}
