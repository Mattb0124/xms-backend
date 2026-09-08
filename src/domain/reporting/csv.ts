/**
 * One neutraliser for every tabular export (security review finding 40).
 * A cell whose first character is `= + - @` or a tab or carriage return is
 * read as a formula by Excel, Numbers and Sheets, so it is prefixed with an
 * apostrophe. CSV output additionally quotes and doubles embedded quotes
 * (RFC 4180). ExcelJS writes a string cell value as a string and never as a
 * formula, so the workbook paths were harmless as they stood; they used a
 * shorter character set than the CSV paths, and one rule in one place is
 * what keeps the next export from getting it wrong.
 */
const LEADING = /^[=+\-@\t\r]/;

export function neutraliseFormula(text: string): string {
  return LEADING.test(text) ? `'${text}` : text;
}

/** The same rule for a cell of any type; objects are serialised first. */
export function neutraliseCell(value: unknown): unknown {
  return typeof value === 'string' ? neutraliseFormula(value) : value;
}

/** One CSV cell: neutralised, then quoted when it carries a quote, comma or newline. */
export function csvCell(value: unknown): string {
  const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
  const safe = neutraliseFormula(text);
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A whole sheet as CRLF-joined RFC 4180 rows. */
export function toCsvRows(columns: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [columns.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\r\n');
}
