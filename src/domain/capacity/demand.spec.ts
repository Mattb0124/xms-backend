import { describe, expect, it } from 'vitest';
import { demandTotals, MAX_DEMAND_PROBLEMS, MAX_DEMAND_ROWS, parseDemandCsv } from './demand.js';

describe('demandTotals', () => {
  it('weights pipeline by probability and takes project hours as committed', () => {
    const totals = demandTotals([
      {
        source: 'pipeline',
        account_id: null,
        prospect_name: 'Acme',
        period_month: '2026-12-01',
        hours: 200,
        probability: 0.5,
      },
      {
        source: 'project',
        account_id: 'a',
        prospect_name: null,
        period_month: '2026-12-01',
        hours: 40,
        probability: 1,
      },
      {
        source: 'import',
        account_id: 'a',
        prospect_name: null,
        period_month: '2026-12-01',
        hours: 10,
        probability: 0.2,
      },
    ]);
    expect(totals).toEqual({ pipeline_minutes_weighted: 6120, project_minutes: 2400, total_minutes: 8520 });
  });
});

describe('parseDemandCsv', () => {
  it('reads the template in any column order and normalises months, keys and percents', () => {
    const parsed = parseDemandCsv(
      [
        'month,source,account,prospect,hours,probability,role',
        '2026-12,pipeline,,Acme Corp,200,50%,consultant',
        '2026-11-01,project,brk,,40,,',
        '2027-01,Pipeline,"aus",,"12.5",0.25,Architect',
      ].join('\n'),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows).toEqual([
      {
        line: 2,
        source: 'pipeline',
        account_key: null,
        prospect_name: 'Acme Corp',
        period_month: '2026-12-01',
        hours: 200,
        probability: 0.5,
        role: 'consultant',
      },
      {
        line: 3,
        source: 'project',
        account_key: 'BRK',
        prospect_name: null,
        period_month: '2026-11-01',
        hours: 40,
        probability: 1,
        role: null,
      },
      {
        line: 4,
        source: 'pipeline',
        account_key: 'AUS',
        prospect_name: null,
        period_month: '2027-01-01',
        hours: 12.5,
        probability: 0.25,
        role: 'architect',
      },
    ]);
  });

  it('names every problem with its line and imports nothing when one exists', () => {
    const parsed = parseDemandCsv(
      ['source,month,hours,probability', 'plan,2026-13,x,2', 'pipeline,2026-12,10,0.5'].join('\r\n'),
    );
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems.map((row) => `${row.line}:${row.problem}`)).toEqual([
      '2:source must be pipeline or project, got "plan"',
      '2:an account key or a prospect name is required',
      '2:month must be YYYY-MM, got "2026-13"',
      '2:hours must be a number between 0 and 100000, got "x"',
      '2:probability must be between 0 and 1 (or a percent), got "2"',
      '3:an account key or a prospect name is required',
    ]);
    expect(parseDemandCsv('').problems).toEqual([{ line: 0, problem: 'the file is empty' }]);
    expect(parseDemandCsv('a,b\n1,2').problems.map((row) => row.problem)).toEqual([
      'missing column source',
      'missing column month',
      'missing column hours',
    ]);
  });
});

describe('the import bounds', () => {
  const header = 'source,account,prospect,month,hours,probability,role\n';

  it('refuses a file with more rows than the import accepts, before parsing any of them', () => {
    const rows = Array.from({ length: MAX_DEMAND_ROWS + 1 }, () => 'project,BRK,,2026-01,8,,consultant').join('\n');
    const parsed = parseDemandCsv(header + rows);
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems).toEqual([{ line: 0, problem: `at most ${MAX_DEMAND_ROWS} rows per import` }]);
  });

  it('mirrors the single-row bounds on hours and the prospect name', () => {
    const parsed = parseDemandCsv(
      header +
        `pipeline,,${'x'.repeat(161)},2026-01,8,0.5,consultant\n` +
        'pipeline,,Acme,2026-01,100001,0.5,consultant\n',
    );
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems.map((row) => row.problem)).toEqual([
      'prospect name must be at most 160 characters',
      'hours must be a number between 0 and 100000, got "100001"',
    ]);
  });

  it('caps the problem list it serialises into the response', () => {
    const rows = Array.from({ length: 300 }, () => 'plan,,,,,,').join('\n');
    const parsed = parseDemandCsv(header + rows);
    expect(parsed.problems.length).toBe(MAX_DEMAND_PROBLEMS + 1);
    expect(parsed.problems.at(-1)).toMatchObject({ line: 0 });
    expect(String(parsed.problems.at(-1)?.problem)).toMatch(/^and \d+ more$/);
  });
});
