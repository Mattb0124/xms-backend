import { describe, expect, it } from 'vitest';
import { containerReason, type ContainerCandidate, type ContainerThresholds } from './container-jobs.js';

/**
 * The judgement behind container-case detection (TM-27), tested away from
 * the database because the boundary is the thing that matters: at the
 * threshold counts, one below it does not, and a threshold nobody set never
 * fires no matter how large the measure.
 */
const candidate = (over: Partial<ContainerCandidate> = {}): ContainerCandidate => ({
  id: 'ticket',
  number: '42',
  short_description: 'Monthly close support',
  assignee_id: null,
  created_at: '2026-08-01T00:00:00.000Z',
  entry_count: 0,
  effort_minutes: 0,
  elapsed_days: 0,
  ...over,
});

const thresholds = (over: Partial<ContainerThresholds> = {}): ContainerThresholds => ({
  timeEntries: null,
  elapsedDays: null,
  effortMinutes: null,
  ...over,
});

describe('containerReason', () => {
  it('says nothing when the account has set no threshold, however large the ticket', () => {
    expect(containerReason(candidate({ entry_count: 900, elapsed_days: 900, effort_minutes: 90_000 }), thresholds())).toBeNull();
  });

  it('fires at the threshold and not one below it', () => {
    const at = containerReason(candidate({ entry_count: 12 }), thresholds({ timeEntries: 12 }));
    expect(at).toContain('12 time entries against a threshold of 12');
    expect(containerReason(candidate({ entry_count: 11 }), thresholds({ timeEntries: 12 }))).toBeNull();
  });

  it('counts elapsed days and logged effort on their own terms', () => {
    expect(containerReason(candidate({ elapsed_days: 30 }), thresholds({ elapsedDays: 30 }))).toContain('open 30 days');
    // Minutes are read out as hours, because nobody discusses a container
    // case in minutes.
    expect(containerReason(candidate({ effort_minutes: 1200 }), thresholds({ effortMinutes: 960 }))).toContain(
      '20 hours logged against a threshold of 16',
    );
  });

  it('names every threshold the ticket crossed, not just the first', () => {
    const reason = containerReason(
      candidate({ entry_count: 20, elapsed_days: 45, effort_minutes: 3000 }),
      thresholds({ timeEntries: 12, elapsedDays: 30, effortMinutes: 960 }),
    );
    expect(reason).toContain('20 time entries');
    expect(reason).toContain('open 45 days');
    expect(reason).toContain('50 hours logged');
    // The wording says what happens next: a person decides, the detector
    // does not.
    expect(reason).toContain('Raised for a scope decision');
  });

  it('ignores a measure whose own threshold is off while another fires', () => {
    const reason = containerReason(
      candidate({ entry_count: 900, elapsed_days: 45 }),
      thresholds({ elapsedDays: 30 }),
    );
    expect(reason).toContain('open 45 days');
    expect(reason).not.toContain('time entries');
  });
});
