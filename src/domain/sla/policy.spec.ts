import { describe, expect, it } from 'vitest';
import { validateSlaPolicy } from './policy.js';

const good = {
  calendar: '24x7',
  targets: {
    incident: {
      p1: { response_minutes: 30, resolution_minutes: 240 },
      p2: { response_minutes: 60, resolution_minutes: null },
    },
  },
};

describe('validateSlaPolicy', () => {
  it('accepts the seeded shape', () => {
    expect(validateSlaPolicy(good)).toEqual([]);
  });

  it('refuses a body that is not an object or has no targets', () => {
    expect(validateSlaPolicy(null)).toEqual(['body must be an object']);
    expect(validateSlaPolicy([])).toEqual(['body must be an object']);
    expect(validateSlaPolicy({})).toEqual(['targets must be an object keyed by ticket type']);
    expect(validateSlaPolicy({ targets: {} })).toContain('targets must name at least one ticket type');
  });

  it('names each bad target precisely', () => {
    const problems = validateSlaPolicy({
      calendar: '',
      targets: {
        incident: { p9: { response_minutes: 0, resolution_minutes: '240' } },
        'Bad Type': [],
        problem: { p1: { response_minutes: 500, resolution_minutes: 240 } },
      },
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'calendar must be a non-empty string when present',
        'targets.incident.p9: unknown priority',
        'targets.incident.p9.response_minutes must be null or a positive integer of minutes',
        'targets.incident.p9.resolution_minutes must be null or a positive integer of minutes',
        'ticket type "Bad Type" is not a valid key',
        'targets.Bad Type must be an object keyed by priority',
        'targets.problem.p1: response cannot be later than resolution',
      ]),
    );
  });

  it('requires both minute fields even when null', () => {
    expect(validateSlaPolicy({ targets: { incident: { p1: { response_minutes: 30 } } } })).toEqual([
      'targets.incident.p1.resolution_minutes must be null or a positive integer of minutes',
    ]);
  });
});
