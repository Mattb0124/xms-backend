/**
 * Forward demand (Capacity & Allocation functional 5.7; CAP-08): pipeline
 * hours weighted by their probability and project hours committed, per
 * month and per account or prospect, and the parser for the spreadsheet
 * template (one row per line: source, account key or prospect, month,
 * hours, probability, role).
 */
export interface DemandLine {
  readonly source: 'pipeline' | 'project' | 'import';
  readonly account_id: string | null;
  readonly prospect_name: string | null;
  readonly period_month: string;
  readonly hours: number;
  readonly probability: number;
}

export interface DemandTotals {
  readonly pipeline_minutes_weighted: number;
  readonly project_minutes: number;
  readonly total_minutes: number;
}

/** Minutes of demand: pipeline weighted by probability, project as committed. */
export function demandTotals(lines: readonly DemandLine[]): DemandTotals {
  let pipeline = 0;
  let project = 0;
  for (const line of lines) {
    const minutes = line.hours * 60;
    if (line.source === 'project') project += minutes;
    else pipeline += minutes * line.probability;
  }
  return {
    pipeline_minutes_weighted: Math.round(pipeline),
    project_minutes: Math.round(project),
    total_minutes: Math.round(pipeline + project),
  };
}

export interface ParsedDemandRow {
  readonly line: number;
  readonly source: 'pipeline' | 'project';
  readonly account_key: string | null;
  readonly prospect_name: string | null;
  readonly period_month: string;
  readonly hours: number;
  readonly probability: number;
  readonly role: string | null;
}

export interface ParsedDemand {
  readonly rows: ParsedDemandRow[];
  readonly problems: { line: number; problem: string }[];
}

export const DEMAND_TEMPLATE_COLUMNS = [
  'source',
  'account',
  'prospect',
  'month',
  'hours',
  'probability',
  'role',
] as const;

function splitCsvLine(text: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      cells.push(current);
      current = '';
    } else current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/**
 * Parses the CSV template: a header row naming the columns in any order,
 * then one row per demand line. Every problem is reported with its line;
 * a file with any problem imports nothing.
 */
/** The import's own bounds, which must match the single-row DTO's. */
export const MAX_DEMAND_ROWS = 5000;
export const MAX_DEMAND_PROBLEMS = 100;
export const MAX_DEMAND_HOURS = 100_000;
export const MAX_PROSPECT_NAME = 160;

export function parseDemandCsv(content: string): ParsedDemand {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const problems: { line: number; problem: string }[] = [];
  if (lines.length === 0) return { rows: [], problems: [{ line: 0, problem: 'the file is empty' }] };
  if (lines.length - 1 > MAX_DEMAND_ROWS)
    return { rows: [], problems: [{ line: 0, problem: `at most ${MAX_DEMAND_ROWS} rows per import` }] };
  const header = splitCsvLine(lines[0]).map((cell) => cell.toLowerCase());
  const index = Object.fromEntries(DEMAND_TEMPLATE_COLUMNS.map((column) => [column, header.indexOf(column)]));
  for (const column of ['source', 'month', 'hours'] as const)
    if (index[column] < 0) problems.push({ line: 1, problem: `missing column ${column}` });
  if (problems.length > 0) return { rows: [], problems };
  const cell = (cells: string[], column: (typeof DEMAND_TEMPLATE_COLUMNS)[number]): string =>
    index[column] >= 0 ? (cells[index[column]] ?? '') : '';
  const rows: ParsedDemandRow[] = [];
  lines.slice(1).forEach((text, offset) => {
    const line = offset + 2;
    const cells = splitCsvLine(text);
    const source = cell(cells, 'source').toLowerCase();
    if (source !== 'pipeline' && source !== 'project')
      problems.push({ line, problem: `source must be pipeline or project, got "${source}"` });
    const accountKey = cell(cells, 'account') || null;
    const prospect = cell(cells, 'prospect') || null;
    if (!accountKey && !prospect) problems.push({ line, problem: 'an account key or a prospect name is required' });
    const month = cell(cells, 'month');
    if (!/^\d{4}-(0[1-9]|1[0-2])(-01)?$/.test(month))
      problems.push({ line, problem: `month must be YYYY-MM, got "${month}"` });
    if (prospect && prospect.length > MAX_PROSPECT_NAME)
      problems.push({ line, problem: `prospect name must be at most ${MAX_PROSPECT_NAME} characters` });
    const hours = Number(cell(cells, 'hours'));
    if (!Number.isFinite(hours) || hours < 0 || hours > MAX_DEMAND_HOURS)
      problems.push({
        line,
        problem: `hours must be a number between 0 and ${MAX_DEMAND_HOURS}, got "${cell(cells, 'hours')}"`,
      });
    const rawProbability = cell(cells, 'probability');
    const probability =
      rawProbability === '' ? 1 : Number(rawProbability.replace('%', '')) / (rawProbability.includes('%') ? 100 : 1);
    if (!Number.isFinite(probability) || probability <= 0 || probability > 1)
      problems.push({ line, problem: `probability must be between 0 and 1 (or a percent), got "${rawProbability}"` });
    const role = cell(cells, 'role').toLowerCase() || null;
    if (role && !/^[a-z][a-z0-9_]{1,39}$/.test(role))
      problems.push({ line, problem: `role "${role}" is not a role code` });
    rows.push({
      line,
      source: source === 'project' ? 'project' : 'pipeline',
      account_key: accountKey ? accountKey.toUpperCase() : null,
      prospect_name: prospect,
      period_month: `${month.slice(0, 7)}-01`,
      hours,
      probability: source === 'project' ? 1 : probability,
      role,
    });
  });
  // The whole problem list is serialised into the 400 response.
  return {
    rows: problems.length > 0 ? [] : rows,
    problems:
      problems.length > MAX_DEMAND_PROBLEMS
        ? [
            ...problems.slice(0, MAX_DEMAND_PROBLEMS),
            { line: 0, problem: `and ${problems.length - MAX_DEMAND_PROBLEMS} more` },
          ]
        : problems,
  };
}
