import { describe, expect, it } from 'vitest';
import seed from '../../config/seeds/priority-matrix.json' with { type: 'json' };
import { PriorityMatrix, validateMatrix, type PriorityMatrixBody } from './priority-matrix.js';

describe('priority matrix', () => {
  const matrix = new PriorityMatrix(seed as PriorityMatrixBody);

  it('pins the default grid from the functional spec', () => {
    expect(matrix.derive('high', 'high')).toBe('p1');
    expect(matrix.derive('high', 'medium')).toBe('p2');
    expect(matrix.derive('high', 'low')).toBe('p3');
    expect(matrix.derive('medium', 'high')).toBe('p2');
    expect(matrix.derive('medium', 'medium')).toBe('p3');
    expect(matrix.derive('medium', 'low')).toBe('p4');
    expect(matrix.derive('low', 'high')).toBe('p3');
    expect(matrix.derive('low', 'medium')).toBe('p4');
    expect(matrix.derive('low', 'low')).toBe('p4');
  });

  it('falls back to the default when either input is missing', () => {
    expect(matrix.derive(null, 'high')).toBe('p3');
    expect(matrix.derive('high', undefined)).toBe('p3');
  });

  it('rejects an override with a hole or an unknown priority', () => {
    const body = JSON.parse(JSON.stringify(seed)) as PriorityMatrixBody;
    (body.cells.low as Record<string, string>).low = 'p9';
    expect(validateMatrix(body)).toEqual(['cell low/low is p9']);
    expect(() => new PriorityMatrix(body)).toThrow(/low\/low/);
  });
});
