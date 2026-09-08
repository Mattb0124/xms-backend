import {
  HttpException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { Request, Response } from 'express';
import { SecurityEventsService } from '../events/security-events.service.js';
import type { RequestContext } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.js';
import { RateLimiter } from './rate-limiter.js';

/**
 * Per-API-client rate limiting (Integrations technical section 5: 600
 * requests per minute by default, configurable on the client, with
 * `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `Retry-After` on a 429).
 *
 * Why an interceptor and not the middleware that carries the portal,
 * webhook and public policies:
 *
 * - The counter must key on the client, not on a string taken from the
 *   request. The middleware runs before the guard, so all it has is the
 *   bearer header; keying on a hash of it would count a rotated key as a
 *   new caller, and would let anyone create an unbounded number of counter
 *   entries by sending forged `xms_live_` strings. The interceptor runs
 *   after the guard, so it keys on `op.api_clients.id`, which is the thing
 *   the limit is configured on.
 * - The limit is per client and lives in the database. The guard has
 *   already read that row to authenticate the key, and puts the allowance
 *   on the principal; the middleware would have to look the credential up a
 *   second time, before it is known to be valid.
 * - The unauthenticated surfaces stay in the middleware, where they belong:
 *   they have no principal to key on and must be refused before any work.
 *
 * The cost of the placement is that a refused request has already paid for
 * one credential verification. That is the correct trade for an
 * authenticated caller with a contract; the coarse limits in front of it
 * (the WAF, and the public policies) carry the unauthenticated flood.
 */
const WINDOW_MS = 60_000;

/** The limit a client falls back to when its row predates the column. */
export const DEFAULT_API_CLIENT_PER_MINUTE = 600;

type GuardedRequest = Request & { principal?: Principal; requestContext?: RequestContext };

@Injectable()
export class ApiClientRateLimitInterceptor implements NestInterceptor {
  private readonly limiter = new RateLimiter();

  constructor(private readonly security: SecurityEventsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<GuardedRequest>();
    const principal = request.principal;
    if (!principal || principal.tokenType !== 'api_key' || !principal.sessionId) return next.handle();

    const limit = principal.rateLimitPerMinute ?? DEFAULT_API_CLIENT_PER_MINUTE;
    const decision = this.limiter.hit(`api_client:${principal.sessionId}`, limit, WINDOW_MS);
    const response = http.getResponse<Response>();
    response.setHeader('x-ratelimit-limit', String(limit));
    response.setHeader('x-ratelimit-remaining', String(decision.remaining));
    if (decision.allowed) return next.handle();

    response.setHeader('retry-after', String(decision.retryAfterSeconds));
    if (decision.firstRefusal) {
      void this.security.write({
        type: 'abuse.rate_limited',
        outcome: 'denied',
        actorKind: 'api_client',
        actorId: principal.userId,
        actorName: principal.displayName,
        principalKind: 'api_client',
        sessionId: principal.sessionId,
        requestId: request.requestContext?.requestId,
        entityKind: 'api_client',
        entityId: principal.sessionId,
        attrs: {
          policy: 'api_client',
          per_minute: limit,
          method: request.method,
          route: request.originalUrl.split('?')[0],
        },
        ipHash: request.requestContext?.ipHash,
        userAgentFamily: request.requestContext?.userAgentFamily,
      });
    }
    throw new HttpException(
      { code: 'rate_limited', policy: 'api_client', retry_after: decision.retryAfterSeconds },
      429,
    );
  }
}
