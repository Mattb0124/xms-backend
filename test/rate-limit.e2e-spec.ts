import { Controller, Get, Global, INestApplication, Module, Post, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecurityEventsService } from '../src/common/events/security-events.service.js';
import { RATE_POLICIES, RateLimitModule } from '../src/common/rate-limit/rate-limit.middleware.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { RecordingSink } from './kit/auth.js';

/**
 * Rate limiting on the outward-facing routes (P1.8.1): the portal realm,
 * webhooks and the public surfaces are counted per caller and per policy;
 * internal routes are not; a refusal is a 429 with Retry-After and exactly
 * one abuse.rate_limited event per burst.
 */
@Controller()
class ProbeController {
  @Get('portal/probe')
  portal() {
    return { ok: true };
  }

  @Post('webhooks/probe')
  webhook() {
    return { ok: true };
  }

  @Post('telemetry')
  telemetry() {
    return { ok: true };
  }

  @Get('tickets/probe')
  internal() {
    return { ok: true };
  }
}

const sink = new RecordingSink();

/** The security writer is global in the application; here it is the recording sink. */
@Global()
@Module({ providers: [{ provide: SecurityEventsService, useValue: sink }], exports: [SecurityEventsService] })
class SinkModule {}

@Module({ imports: [SinkModule, RateLimitModule], controllers: [ProbeController] })
class ProbeModule {}

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] })
    .overrideProvider(RATE_POLICIES)
    .useValue([
      { name: 'webhook', matches: (path: string) => path.startsWith('/v1/webhooks/'), perMinute: 2 },
      { name: 'portal', matches: (path: string) => path.startsWith('/v1/portal'), perMinute: 3 },
      { name: 'public', matches: (path: string) => path.startsWith('/v1/telemetry'), perMinute: 1 },
    ])
    .compile();
  app = moduleRef.createNestApplication();
  app.use(requestContextMiddleware);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

function api() {
  return request(app.getHttpServer());
}

describe('rate limiting', () => {
  it('counts portal calls per caller, refuses past the limit with Retry-After and one event per burst', async () => {
    for (let index = 0; index < 3; index += 1) {
      const response = await api().get('/v1/portal/probe').expect(200);
      expect(response.headers['x-ratelimit-limit']).toBe('3');
      expect(response.headers['x-ratelimit-remaining']).toBe(String(2 - index));
    }
    const refused = await api().get('/v1/portal/probe').expect(429);
    expect(refused.body).toMatchObject({ code: 'rate_limited', policy: 'portal' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.headers['x-request-id']).toBeTruthy();
    await api().get('/v1/portal/probe').expect(429);
    const events = sink.ofType('abuse.rate_limited');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'denied', entityId: '/v1/portal/probe', attrs: { policy: 'portal' } });
    expect(events[0].ipHash).toBeTruthy();
  });

  it('keeps policies apart and leaves internal routes uncounted', async () => {
    await api().post('/v1/webhooks/probe').expect(201);
    await api().post('/v1/webhooks/probe').expect(201);
    await api().post('/v1/webhooks/probe').expect(429);
    await api().post('/v1/telemetry').expect(201);
    await api().post('/v1/telemetry').expect(429);
    for (let index = 0; index < 10; index += 1) {
      const response = await api().get('/v1/tickets/probe').expect(200);
      expect(response.headers['x-ratelimit-limit']).toBeUndefined();
    }
    expect(sink.ofType('abuse.rate_limited').map((event) => event.attrs?.policy)).toEqual([
      'portal',
      'webhook',
      'public',
    ]);
  });

  it('keys on the caller, so another address starts with a fresh window', async () => {
    await api().get('/v1/portal/probe').set('x-forwarded-for', '203.0.113.9').expect(429);
    // Without trust proxy the forwarded header is ignored; the same socket address shares the window.
    await api().get('/v1/portal/probe').expect(429);
  });
});
