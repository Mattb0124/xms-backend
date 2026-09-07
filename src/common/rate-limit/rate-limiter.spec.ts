import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

describe('fixed-window rate limiter', () => {
  it('allows up to the maximum in a window, then refuses with a retry hint', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(() => now);
    const decisions = Array.from({ length: 4 }, () => limiter.hit('ip:a', 3, 60_000));
    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, true, false]);
    expect(decisions.map((decision) => decision.remaining)).toEqual([2, 1, 0, 0]);
    expect(decisions[3].retryAfterSeconds).toBe(60);
    expect(decisions[3].firstRefusal).toBe(true);
    expect(limiter.hit('ip:a', 3, 60_000).firstRefusal).toBe(false);
    now += 30_000;
    expect(limiter.hit('ip:a', 3, 60_000)).toMatchObject({ allowed: false, retryAfterSeconds: 30 });
  });

  it('keeps keys apart and resets after the window', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    expect(limiter.hit('ip:a', 1, 1000).allowed).toBe(true);
    expect(limiter.hit('ip:b', 1, 1000).allowed).toBe(true);
    expect(limiter.hit('ip:a', 1, 1000).allowed).toBe(false);
    now = 1000;
    expect(limiter.hit('ip:a', 1, 1000)).toMatchObject({ allowed: true, firstRefusal: false });
  });

  it('prunes expired windows so the map stays bounded', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    for (let index = 0; index < 100; index += 1) limiter.hit(`ip:${index}`, 5, 1000);
    expect(limiter.size()).toBe(100);
    now = 2000;
    limiter.hit('ip:new', 5, 1000);
    expect(limiter.size()).toBe(1);
  });
});
