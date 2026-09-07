import { describe, expect, it } from 'vitest';
import { checkRequirements } from './close-discipline.js';

const facts = {
  loggedMinutes: 0,
  noSolutionCodes: new Set(['duplicate', 'cancelled_by_client']),
  knownCodes: new Set(['fixed', 'duplicate', 'cancelled_by_client']),
};
const RESOLVE = ['resolution', 'solution_link', 'time_logged'] as const;

describe('close discipline', () => {
  it('lists every missing item for an empty resolve', () => {
    expect(checkRequirements(RESOLVE, {}, facts)).toEqual([
      'resolution_code',
      'resolution_notes',
      'solution_link',
      'time_logged',
    ]);
  });

  it('accepts a full resolution with a solution link and logged time', () => {
    const input = { resolution: { code: 'fixed', notes: 'Rebuilt the cube', solutionArticleId: 'kb-1' } };
    expect(checkRequirements(RESOLVE, input, { ...facts, loggedMinutes: 30 })).toEqual([]);
  });

  it('accepts a new-article candidate in place of a link', () => {
    const input = {
      resolution: { code: 'fixed', notes: 'x', solutionCandidate: true, timeExemptionReason: 'Fixed by vendor' },
    };
    expect(checkRequirements(RESOLVE, input, facts)).toEqual([]);
  });

  it('waives the solution link for a no-solution code', () => {
    const input = {
      resolution: { code: 'duplicate', notes: 'Duplicate of CS0001000', timeExemptionReason: 'No work done' },
    };
    expect(checkRequirements(RESOLVE, input, facts)).toEqual([]);
  });

  it('rejects an unknown resolution code', () => {
    const input = { resolution: { code: 'magic', notes: 'x', solutionCandidate: true, timeExemptionReason: 'x' } };
    expect(checkRequirements(RESOLVE, input, facts)).toEqual(['unknown_resolution_code']);
  });

  it('requires a time exemption reason when nothing was logged', () => {
    const input = { resolution: { code: 'fixed', notes: 'x', solutionArticleId: 'kb' } };
    expect(checkRequirements(RESOLVE, input, facts)).toEqual(['time_logged']);
  });

  it('requires a pause reason on a pausing transition only', () => {
    expect(checkRequirements(['pause_reason'], {}, facts)).toEqual(['pause_reason']);
    expect(checkRequirements(['pause_reason'], { pauseReason: 'awaiting_client' }, facts)).toEqual([]);
    expect(checkRequirements([], {}, facts)).toEqual([]);
  });
});
