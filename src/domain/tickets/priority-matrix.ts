/**
 * The priority matrix (Ticket Management functional 5.3). The server derives
 * priority whenever impact and urgency are present; an account override is
 * the same shape with different cells.
 */
export type Level = 'high' | 'medium' | 'low';
export type Priority = 'p1' | 'p2' | 'p3' | 'p4';

export interface PriorityMatrixBody {
  /** cells[impact][urgency] */
  readonly cells: Record<Level, Record<Level, Priority>>;
  readonly default: Priority;
}

export const LEVELS: readonly Level[] = ['high', 'medium', 'low'];
export const PRIORITIES: readonly Priority[] = ['p1', 'p2', 'p3', 'p4'];

export class PriorityMatrix {
  constructor(readonly body: PriorityMatrixBody) {
    const problems = validateMatrix(body);
    if (problems.length > 0) throw new Error(`Invalid priority matrix: ${problems.join('; ')}`);
  }

  derive(impact: Level | null | undefined, urgency: Level | null | undefined): Priority {
    if (!impact || !urgency) return this.body.default;
    return this.body.cells[impact][urgency];
  }
}

export function validateMatrix(body: PriorityMatrixBody): string[] {
  const problems: string[] = [];
  if (!body?.cells) return ['no cells'];
  for (const impact of LEVELS) {
    for (const urgency of LEVELS) {
      const cell = body.cells[impact]?.[urgency];
      if (!PRIORITIES.includes(cell)) problems.push(`cell ${impact}/${urgency} is ${String(cell)}`);
    }
  }
  if (!PRIORITIES.includes(body.default)) problems.push(`default is ${String(body.default)}`);
  return problems;
}
