import { describe, expect, it } from 'vitest';
import { ageBucket, computeMeasures, notableTickets, previousWeek, type TicketFacts } from './measures.js';

const now = new Date('2026-09-10T12:00:00Z');
const period = { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-09-08T00:00:00Z') };

function ticket(overrides: Partial<TicketFacts>): TicketFacts {
  return {
    id: overrides.key ?? 'id',
    key: 'CS0000001',
    type: 'incident',
    state: 'in_progress',
    priority: 'p3',
    createdAt: new Date('2026-09-02T09:00:00Z'),
    resolvedAt: null,
    closedAt: null,
    reopenCount: 0,
    responseBreached: false,
    resolutionBreached: false,
    responseMet: false,
    resolutionMet: false,
    resolutionDueAt: null,
    resolutionRemainingMinutes: null,
    resolutionTargetMinutes: null,
    shortDescription: 'x',
    ...overrides,
  };
}

describe('measures', () => {
  it('computes the ten day-30 measures from facts', () => {
    const tickets = [
      ticket({ key: 'A', priority: 'p1', resolutionBreached: true }),
      ticket({
        key: 'B',
        priority: 'p2',
        createdAt: new Date('2026-08-20T00:00:00Z'),
        resolutionRemainingMinutes: 20,
        resolutionTargetMinutes: 240,
      }),
      ticket({
        key: 'C',
        state: 'resolved',
        createdAt: new Date('2026-09-03T08:00:00Z'),
        resolvedAt: new Date('2026-09-03T10:00:00Z'),
        responseMet: true,
        resolutionMet: true,
      }),
      ticket({
        key: 'D',
        state: 'closed',
        createdAt: new Date('2026-09-04T08:00:00Z'),
        resolvedAt: new Date('2026-09-04T12:00:00Z'),
        responseMet: true,
        resolutionBreached: true,
        reopenCount: 1,
      }),
      ticket({
        key: 'E',
        state: 'resolved',
        createdAt: new Date('2026-08-01T00:00:00Z'),
        resolvedAt: new Date('2026-08-02T00:00:00Z'),
        resolutionMet: true,
      }),
    ];
    const time = [
      { minutes: 60, consumesContract: true, performedOn: '2026-09-02' },
      { minutes: 30, consumesContract: false, performedOn: '2026-09-02' },
    ];
    const result = computeMeasures(tickets, time, period, now);
    expect(result.open_tickets).toBe(2);
    expect(result.open_by_priority).toEqual({ p1: 1, p2: 1 });
    expect(result.breached_now).toBe(1);
    expect(result.at_risk_now).toBe(1);
    expect(result.backlog_by_age).toEqual({ '0_1d': 0, '1_3d': 0, '3_7d': 0, '7_14d': 1, '14d_plus': 1 });
    expect(result.volume_created).toBe(3);
    expect(result.volume_resolved).toBe(2);
    expect(result.sla_response_attainment).toEqual({ numerator: 2, denominator: 2, value: 100 });
    expect(result.sla_resolution_attainment).toEqual({ numerator: 1, denominator: 2, value: 50 });
    expect(result.mttr_minutes).toBe(180);
    expect(result.reopen_rate).toEqual({ numerator: 1, denominator: 2, value: 50 });
    expect(result.consumption_minutes).toBe(60);
    expect(result.time_logged_minutes).toBe(90);
    expect(result.oldest_open_days).toBe(21.5);
  });

  it('reports null ratios when nothing was judged', () => {
    const result = computeMeasures([], [], period, now);
    expect(result.sla_resolution_attainment.value).toBeNull();
    expect(result.mttr_minutes).toBeNull();
  });

  it('buckets ages and orders notable tickets breached first, then priority, then age', () => {
    expect(ageBucket(new Date('2026-09-10T00:00:00Z'), now)).toBe('0_1d');
    expect(ageBucket(new Date('2026-09-01T00:00:00Z'), now)).toBe('7_14d');
    const notable = notableTickets(
      [
        ticket({ key: 'old', priority: 'p3', createdAt: new Date('2026-08-01T00:00:00Z') }),
        ticket({ key: 'p1', priority: 'p1' }),
        ticket({ key: 'breached', priority: 'p4', resolutionBreached: true }),
        ticket({ key: 'closed', state: 'closed' }),
      ],
      now,
    );
    expect(notable.map((row) => row.key)).toEqual(['breached', 'p1', 'old']);
    expect(Object.keys(notable[0]).sort()).toEqual(['age_days', 'breached', 'key', 'priority', 'state', 'title']);
  });

  it('computes the previous ISO week', () => {
    const week = previousWeek(new Date('2026-09-09T15:00:00Z'));
    expect(week.start.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(week.end.toISOString()).toBe('2026-09-07T00:00:00.000Z');
  });
});
