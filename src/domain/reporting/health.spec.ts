import { describe, expect, it } from 'vitest';
import {
  computeHealth,
  healthBand,
  HEALTH_WEIGHTS,
  type EngagementInput,
  type HealthFactorKey,
  type HealthInputs,
} from './health.js';
import type { Ratio } from './measures.js';

/**
 * The account health score (DR-09). Every factor is exercised on its own:
 * a factor with nothing to measure leaves the score to the others, and each
 * one moves the number in the direction it should.
 */
function ratio(numerator: number, denominator: number): Ratio {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10,
  };
}

const ENGAGED: EngagementInput = {
  portalEnabled: true,
  portalSignins: 13,
  surveysSent: 10,
  surveysAnswered: 10,
  windowDays: 90,
};

function inputs(overrides: Partial<HealthInputs> = {}): HealthInputs {
  return {
    slaResolution: ratio(10, 10),
    reopenRate: ratio(0, 10),
    csat: { responses: 10, mean: 5 },
    budget: { availableMinutes: 6000, consumedMinutes: 3000, percentElapsed: 50 },
    engagement: ENGAGED,
    ...overrides,
  };
}

const factor = (result: ReturnType<typeof computeHealth>, key: HealthFactorKey) =>
  result.factors.find((row) => row.key === key)!;

describe('account health score', () => {
  it('scores an account that meets every target on the full hundred points of signal', () => {
    const result = computeHealth(inputs());
    expect(result.score).toBe(100);
    expect(result.band).toBe('green');
    expect(result.measured_weight).toBe(100);
    expect(result.factors.map((row) => row.key)).toEqual(Object.keys(HEALTH_WEIGHTS));
    expect(factor(result, 'sla_resolution')).toMatchObject({ score: 100, weight: 30, contribution: 30 });
    expect(factor(result, 'csat').detail).toMatchObject({ mean_score: 5, responses: 10 });
  });

  it('reads the middle of the satisfaction scale as half the factor', () => {
    const result = computeHealth(inputs({ csat: { responses: 4, mean: 3 } }));
    expect(factor(result, 'csat').score).toBe(50);
    // Twenty-five points of the hundred, half earned: the other four
    // factors are perfect, so the score loses twelve and a half.
    expect(result.score).toBe(88);
  });

  it('drags the score when the budget burns ahead of its own calendar, and says by how much', () => {
    const result = computeHealth({
      ...inputs(),
      budget: { availableMinutes: 6000, consumedMinutes: 4800, percentElapsed: 50 },
    });
    const budget = factor(result, 'budget');
    // Eighty per cent consumed against fifty per cent elapsed: thirty
    // points ahead, and every point ahead costs two.
    expect(budget.detail).toMatchObject({ percent_consumed: 80, percent_elapsed: 50 });
    expect(budget.score).toBe(40);
    expect(result.score).toBe(88);
    expect(result.band).toBe('green');
  });

  it('never punishes a contract that is simply early in its period', () => {
    const result = computeHealth({
      ...inputs(),
      budget: { availableMinutes: 6000, consumedMinutes: 600, percentElapsed: 50 },
    });
    expect(factor(result, 'budget').score).toBe(100);
  });

  it('scores reopened work down to zero at a quarter of what was resolved', () => {
    expect(factor(computeHealth(inputs({ reopenRate: ratio(1, 20) })), 'reopen_rate').score).toBe(80);
    expect(factor(computeHealth(inputs({ reopenRate: ratio(5, 20) })), 'reopen_rate').score).toBe(0);
    expect(factor(computeHealth(inputs({ reopenRate: ratio(8, 20) })), 'reopen_rate').score).toBe(0);
  });

  it('weighs signing in and answering surveys half and half', () => {
    const quiet = computeHealth(
      inputs({ engagement: { ...ENGAGED, portalSignins: 0, surveysSent: 10, surveysAnswered: 10 } }),
    );
    expect(factor(quiet, 'engagement').score).toBe(50);
    // The portal being off is not a client being disengaged: the surveys
    // are then the whole of it.
    const noPortal = computeHealth(
      inputs({
        engagement: { ...ENGAGED, portalEnabled: false, portalSignins: 0, surveysSent: 4, surveysAnswered: 2 },
      }),
    );
    expect(factor(noPortal, 'engagement').score).toBe(50);
  });

  it('drops a factor it cannot measure and renormalizes the rest', () => {
    const result = computeHealth(
      inputs({
        csat: { responses: 0, mean: null },
        budget: null,
        engagement: { ...ENGAGED, portalEnabled: false, surveysSent: 0, surveysAnswered: 0 },
      }),
    );
    // Only attainment and reopens were measurable: 30 + 15 of the hundred.
    expect(result.measured_weight).toBe(45);
    expect(result.score).toBe(100);
    expect(factor(result, 'csat')).toMatchObject({ score: null, contribution: 0 });
    expect(factor(result, 'budget')).toMatchObject({ score: null, contribution: 0 });
    // The two that were measured now carry the whole score between them.
    expect(factor(result, 'sla_resolution').contribution + factor(result, 'reopen_rate').contribution).toBe(100);
  });

  it('rates nothing when there is nothing to rate', () => {
    const result = computeHealth({
      slaResolution: ratio(0, 0),
      reopenRate: ratio(0, 0),
      csat: { responses: 0, mean: null },
      budget: null,
      engagement: {
        portalEnabled: false,
        portalSignins: 0,
        surveysSent: 0,
        surveysAnswered: 0,
        windowDays: 90,
      },
    });
    expect(result).toMatchObject({ score: null, band: 'unrated', measured_weight: 0 });
    expect(result.factors.every((row) => row.score === null && row.contribution === 0)).toBe(true);
  });

  it('bands the score where the constants say', () => {
    expect(healthBand(100)).toBe('green');
    expect(healthBand(80)).toBe('green');
    expect(healthBand(79)).toBe('amber');
    expect(healthBand(60)).toBe('amber');
    expect(healthBand(59)).toBe('red');
    expect(healthBand(0)).toBe('red');
    expect(healthBand(null)).toBe('unrated');
  });

  it('falls to red when the service levels and the client both say so', () => {
    const result = computeHealth(
      inputs({
        slaResolution: ratio(4, 10),
        csat: { responses: 6, mean: 2 },
        reopenRate: ratio(3, 10),
        budget: { availableMinutes: 6000, consumedMinutes: 5400, percentElapsed: 40 },
        engagement: { ...ENGAGED, portalSignins: 1, surveysSent: 10, surveysAnswered: 2 },
      }),
    );
    expect(result.band).toBe('red');
    expect(result.score).toBeLessThan(60);
    expect(factor(result, 'sla_resolution').score).toBe(40);
    expect(factor(result, 'csat').score).toBe(25);
    expect(factor(result, 'reopen_rate').score).toBe(0);
  });
});
