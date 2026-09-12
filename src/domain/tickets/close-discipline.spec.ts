import { describe, expect, it } from 'vitest';
import {
  allowedExemptions,
  checkRequirements,
  DEFAULT_MIN_NOTES_CHARS,
  minNotesChars,
  type CloseDisciplineFacts,
} from './close-discipline.js';

const facts: CloseDisciplineFacts = {
  loggedMinutes: 0,
  noSolutionCodes: new Set(['duplicate', 'cancelled_by_client']),
  knownCodes: new Set(['fixed', 'duplicate', 'cancelled_by_client']),
};
const RESOLVE = ['resolution', 'solution_link', 'time_logged'] as const;

/** A resolution note that clears the default bar, so a test about something else is about that thing. */
const NOTES = 'Rebuilt the consolidation cube and reran the close.';

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
    const input = { resolution: { code: 'fixed', notes: NOTES, solutionArticleId: 'kb-1' } };
    expect(checkRequirements(RESOLVE, input, { ...facts, loggedMinutes: 30 })).toEqual([]);
  });

  it('accepts a new-article candidate in place of a link', () => {
    const input = {
      resolution: { code: 'fixed', notes: NOTES, solutionCandidate: true, timeExemptionReason: 'merged' },
    };
    expect(checkRequirements(RESOLVE, input, facts)).toEqual([]);
  });

  it('waives the solution link for a no-solution code', () => {
    const input = {
      resolution: { code: 'duplicate', notes: NOTES, timeExemptionReason: 'duplicate' },
    };
    expect(checkRequirements(RESOLVE, input, facts)).toEqual([]);
  });

  it('rejects an unknown resolution code', () => {
    const input = {
      resolution: { code: 'magic', notes: NOTES, solutionCandidate: true, timeExemptionReason: 'merged' },
    };
    expect(checkRequirements(RESOLVE, input, facts)).toEqual(['unknown_resolution_code']);
  });

  it('requires a time exemption reason when nothing was logged', () => {
    const input = { resolution: { code: 'fixed', notes: NOTES, solutionArticleId: 'kb' } };
    expect(checkRequirements(RESOLVE, input, facts)).toEqual(['time_logged']);
  });

  it('requires a pause reason on a pausing transition only', () => {
    expect(checkRequirements(['pause_reason'], {}, facts)).toEqual(['pause_reason']);
    expect(checkRequirements(['pause_reason'], { pauseReason: 'awaiting_client' }, facts)).toEqual([]);
    expect(checkRequirements([], {}, facts)).toEqual([]);
  });
});

/**
 * TB-02 under revision 3. The two holes this closes: any non-blank string
 * satisfied the time gate, and any non-blank string was a resolution note.
 */
describe('the time exemption vocabulary', () => {
  const resolve = (reason: string, over: Partial<CloseDisciplineFacts> = {}) =>
    checkRequirements(
      RESOLVE,
      { resolution: { code: 'duplicate', notes: NOTES, timeExemptionReason: reason } },
      { ...facts, ...over },
    );

  it('refuses a reason nobody put on the list, which is what free text allowed', () => {
    expect(resolve('.')).toEqual(['unknown_exemption_reason']);
    expect(resolve('no work done')).toEqual(['unknown_exemption_reason']);
    expect(resolve('Fixed by vendor')).toEqual(['unknown_exemption_reason']);
  });

  it('accepts each of the five the spec names', () => {
    for (const reason of ['duplicate', 'cancelled_by_client', 'resolved_by_client', 'administrative_close', 'merged']) {
      expect(resolve(reason)).toEqual([]);
    }
  });

  it('honours an account that narrowed or widened the list', () => {
    expect(resolve('merged', { allowedExemptions: new Set(['duplicate']) })).toEqual(['unknown_exemption_reason']);
    expect(resolve('goodwill', { allowedExemptions: new Set(['goodwill']) })).toEqual([]);
  });

  it('falls back to the built-in list rather than opening the gate when the catalog is missing', () => {
    // A missing or emptied catalog must not mean "any reason will do". The
    // gate exists to be closed.
    expect(allowedExemptions({ allowedExemptions: undefined }).has('merged')).toBe(true);
    expect(allowedExemptions({ allowedExemptions: new Set() }).has('merged')).toBe(true);
    expect(resolve('anything', { allowedExemptions: new Set() })).toEqual(['unknown_exemption_reason']);
  });

  it('never asks for an exemption when time was logged', () => {
    const input = { resolution: { code: 'fixed', notes: NOTES, solutionArticleId: 'kb' } };
    expect(checkRequirements(RESOLVE, input, { ...facts, loggedMinutes: 1 })).toEqual([]);
  });
});

describe('resolution notes completeness', () => {
  const withNotes = (notes: string, over: Partial<CloseDisciplineFacts> = {}) =>
    checkRequirements(
      RESOLVE,
      { resolution: { code: 'duplicate', notes, timeExemptionReason: 'duplicate' } },
      { ...facts, ...over },
    );

  it('tells empty and too-short apart, because they need different things said', () => {
    expect(withNotes('   ')).toEqual(['resolution_notes']);
    expect(withNotes('Fixed')).toEqual(['resolution_notes_too_short']);
  });

  it('passes at the bar and refuses one character below it', () => {
    expect(withNotes('a'.repeat(DEFAULT_MIN_NOTES_CHARS))).toEqual([]);
    expect(withNotes('a'.repeat(DEFAULT_MIN_NOTES_CHARS - 1))).toEqual(['resolution_notes_too_short']);
  });

  it('measures the trimmed note, so padding is not completeness', () => {
    expect(withNotes(`  ${'a'.repeat(DEFAULT_MIN_NOTES_CHARS - 1)}  `)).toEqual(['resolution_notes_too_short']);
  });

  it('honours an account that moved the bar, and ignores a nonsensical one', () => {
    expect(withNotes('Fixed', { minNotesChars: 5 })).toEqual([]);
    expect(withNotes('Fixed', { minNotesChars: 0 })).toEqual([]);
    expect(minNotesChars({ minNotesChars: -1 })).toBe(DEFAULT_MIN_NOTES_CHARS);
    expect(minNotesChars({ minNotesChars: Number.NaN })).toBe(DEFAULT_MIN_NOTES_CHARS);
    expect(minNotesChars({ minNotesChars: undefined })).toBe(DEFAULT_MIN_NOTES_CHARS);
    expect(minNotesChars({ minNotesChars: 12.7 })).toBe(12);
  });
});
