import { describe, expect, it } from 'vitest';
import { demandTotals, parseDemandCsv } from './demand.js';

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
      '2:hours must be a number, got "x"',
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
