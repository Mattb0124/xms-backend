/**
 * A fixed-window counter per key (Security & Tenancy section 9, P1.8.1):
 * cheap, dependency-free and sufficient for the pilot's two API tasks. The
 * window resets on the minute boundary of the first hit; a blocked call is
 * told when to retry. Keys are pruned once their window has passed so the
 * map stays bounded by the number of distinct callers per window.
 *
 * Deviation recorded: limits are per process, not shared across tasks; the
 * WAF in front of the load balancer carries the global limits (Platform).
 */
export interface LimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  /** True on the first refusal of a window, so the caller writes one event per burst. */
  readonly firstRefusal: boolean;
}

interface Window {
  count: number;
  startedAt: number;
  refused: boolean;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private lastPrune = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  hit(key: string, max: number, windowMs: number): LimitDecision {
    const at = this.now();
    this.prune(at, windowMs);
    let window = this.windows.get(key);
    if (!window || at - window.startedAt >= windowMs) {
      window = { count: 0, startedAt: at, refused: false };
      this.windows.set(key, window);
    }
    window.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((window.startedAt + windowMs - at) / 1000));
    if (window.count > max) {
      const firstRefusal = !window.refused;
      window.refused = true;
      return { allowed: false, remaining: 0, retryAfterSeconds, firstRefusal };
    }
    return { allowed: true, remaining: max - window.count, retryAfterSeconds, firstRefusal: false };
  }

  size(): number {
    return this.windows.size;
  }

  private prune(at: number, windowMs: number): void {
    if (at - this.lastPrune < windowMs) return;
    this.lastPrune = at;
    for (const [key, window] of this.windows) {
      if (at - window.startedAt >= windowMs) this.windows.delete(key);
    }
  }
}
