import { describe, expect, it } from 'vitest';
import { coverage, heatMap } from './skills.js';

const holders = [
  { person_id: 'ana', code: 'onestream', level: 4 },
  { person_id: 'ben', code: 'onestream', level: 2 },
  { person_id: 'ana', code: 'anaplan', level: 3 },
  { person_id: 'cara', code: 'anaplan', level: 3 },
  { person_id: 'cara', code: 'close', level: 1 },
];

describe('coverage', () => {
  it('flags a single point of failure, a gap, and ok, sorted by code', () => {
    expect(coverage(['onestream', 'anaplan', 'sap', 'onestream'], holders)).toEqual([
      { code: 'anaplan', qualified: ['ana', 'cara'], status: 'ok' },
      { code: 'onestream', qualified: ['ana'], status: 'spof' },
      { code: 'sap', qualified: [], status: 'gap' },
    ]);
  });

  it('the flag clears when a second person reaches the level', () => {
    const raised = [...holders, { person_id: 'ben', code: 'onestream', level: 3 }];
    expect(coverage(['onestream'], raised)[0]).toMatchObject({ status: 'ok', qualified: ['ana', 'ben'] });
    expect(coverage(['onestream'], holders, 4)[0]).toMatchObject({ status: 'spof' });
    expect(coverage(['onestream'], holders, 5)[0]).toMatchObject({ status: 'gap' });
  });
});

describe('heatMap', () => {
  it('lays out a level per person and code', () => {
    expect(heatMap(['ana', 'ben', 'dee'], holders)).toEqual([
      { person_id: 'ana', levels: { onestream: 4, anaplan: 3 } },
      { person_id: 'ben', levels: { onestream: 2 } },
      { person_id: 'dee', levels: {} },
    ]);
  });
});
