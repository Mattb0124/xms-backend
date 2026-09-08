import {
  Inject,
  Injectable,
  Module,
  Optional,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { loadEnv } from '../../config/env.js';
import type { RequestContext } from '../auth/decorators.js';
import { SecurityEventsService } from '../events/security-events.service.js';
import { RateLimiter } from './rate-limiter.js';

/**
 * Rate limiting on the routes that face the outside without a signed-in
 * internal user (Security & Tenancy section 9; P1.8.1): the portal realm,
 * inbound webhooks, and the public surfaces (bootstrap, telemetry, the
 * local store, development helpers). Runs before the guard, so the key is
 * the daily-salted IP hash from the request context; the sign-in page and
 * the WAF carry the coarser limits. A refusal is a 429 with Retry-After
 * and one `abuse.rate_limited` security event per key per window.
 */
export interface RatePolicy {
  readonly name: 'portal' | 'webhook' | 'public';
  readonly matches: (path: string) => boolean;
  readonly perMinute: number;
}

const WINDOW_MS = 60_000;
export const RATE_POLICIES = Symbol('RATE_POLICIES');

export function policiesFromEnv(env = loadEnv()): RatePolicy[] {
  return [
    {
      name: 'webhook',
      matches: (path) => /^\/v\d+\/webhooks\//.test(path),
      perMinute: env.RATE_LIMIT_WEBHOOK_PER_MINUTE,
    },
    {
      name: 'portal',
      matches: (path) => /^\/v\d+\/portal(\/|$)/.test(path),
      perMinute: env.RATE_LIMIT_PORTAL_PER_MINUTE,
    },
    {
      name: 'public',
      // csat is the one unauthenticated write in the product: the survey
      // link route, whose token is its only credential.
      matches: (path) => /^\/v\d+\/(bootstrap|telemetry|storage|dev|csp-report|csat)(\/|$)/.test(path),
      perMinute: env.RATE_LIMIT_PUBLIC_PER_MINUTE,
    },
  ];
}

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly limiter = new RateLimiter();
  private readonly policies: RatePolicy[];

  constructor(
    private readonly security: SecurityEventsService,
    @Optional() @Inject(RATE_POLICIES) policies?: RatePolicy[],
  ) {
    this.policies = policies ?? policiesFromEnv();
  }

  use(request: Request & { requestContext?: RequestContext }, response: Response, next: NextFunction): void {
    const path = request.originalUrl.split('?')[0];
    const policy = this.policies.find((candidate) => candidate.perMinute > 0 && candidate.matches(path));
    if (!policy) {
      next();
      return;
    }
    const caller = request.requestContext?.ipHash ?? request.ip ?? 'unknown';
    const decision = this.limiter.hit(`${policy.name}:${caller}`, policy.perMinute, WINDOW_MS);
    response.setHeader('x-ratelimit-limit', String(policy.perMinute));
    response.setHeader('x-ratelimit-remaining', String(decision.remaining));
    if (decision.allowed) {
      next();
      return;
    }
    response.setHeader('retry-after', String(decision.retryAfterSeconds));
    if (decision.firstRefusal) {
      void this.security.write({
        type: 'abuse.rate_limited',
        outcome: 'denied',
        actorKind: 'anonymous',
        actorId: 'anonymous',
        requestId: request.requestContext?.requestId,
        entityKind: 'route',
        entityId: path,
        attrs: { policy: policy.name, per_minute: policy.perMinute, method: request.method },
        ipHash: request.requestContext?.ipHash,
        userAgentFamily: request.requestContext?.userAgentFamily,
      });
    }
    response.status(429).json({
      statusCode: 429,
      code: 'rate_limited',
      policy: policy.name,
      retry_after: decision.retryAfterSeconds,
      requestId: request.requestContext?.requestId,
    });
  }
}

@Module({
  providers: [RateLimitMiddleware, { provide: RATE_POLICIES, useFactory: policiesFromEnv }],
})
export class RateLimitModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RateLimitMiddleware).forRoutes('*');
  }
}
