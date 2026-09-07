import { Global, INestApplication, Module, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SecurityEventsService } from '../src/common/events/security-events.service.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { CspModule, parseCspReports } from '../src/modules/security/csp.module.js';
import { RecordingSink } from './kit/auth.js';

/**
 * The CSP report endpoint (P1.8.1): both report shapes become one
 * abuse.csp_violation event each carrying the directive facts only; junk,
 * oversized and non-CSP bodies are dropped with the same 204 so a probe
 * learns nothing.
 */
const sink = new RecordingSink();

@Global()
@Module({ providers: [{ provide: SecurityEventsService, useValue: sink }], exports: [SecurityEventsService] })
class SinkModule {}

@Module({ imports: [SinkModule, CspModule] })
class ProbeModule {}

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(requestContextMiddleware);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  sink.events.length = 0;
});

function api() {
  return request(app.getHttpServer());
}

describe('CSP reports', () => {
  it('records a legacy report as one security event with the directive facts and no sample', async () => {
    await api()
      .post('/v1/csp-report')
      .set('content-type', 'application/csp-report')
      .send(
        JSON.stringify({
          'csp-report': {
            'document-uri': 'https://xms.example.test/tickets',
            'violated-directive': 'script-src',
            'effective-directive': 'script-src',
            'blocked-uri': 'https://evil.example/x.js',
            disposition: 'enforce',
            'status-code': 200,
            'script-sample': 'alert(1)',
          },
        }),
      )
      .expect(204);
    const events = sink.ofType('abuse.csp_violation');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'denied',
      actorKind: 'anonymous',
      entityKind: 'csp',
      entityId: 'script-src',
      attrs: {
        document_uri: 'https://xms.example.test/tickets',
        blocked_uri: 'https://evil.example/x.js',
        disposition: 'enforce',
        status_code: 200,
      },
    });
    expect(JSON.stringify(events[0])).not.toContain('alert(1)');
    expect(events[0].ipHash).toBeTruthy();
  });

  it('records each item of a Reporting API list and ignores other report types', async () => {
    await api()
      .post('/v1/csp-report')
      .set('content-type', 'application/reports+json')
      .send(
        JSON.stringify([
          {
            type: 'csp-violation',
            body: { documentURL: 'https://portal.example.test/', effectiveDirective: 'img-src', blockedURL: 'data' },
          },
          { type: 'deprecation', body: { id: 'x' } },
          {
            type: 'csp-violation',
            body: {
              documentURL: 'https://portal.example.test/',
              effectiveDirective: 'connect-src',
              blockedURL: 'wss://a',
            },
          },
        ]),
      )
      .expect(204);
    expect(sink.ofType('abuse.csp_violation').map((event) => event.entityId)).toEqual(['img-src', 'connect-src']);
  });

  it('drops junk, empty and non-CSP bodies silently', async () => {
    await api().post('/v1/csp-report').set('content-type', 'application/csp-report').send('not json').expect(204);
    await api().post('/v1/csp-report').set('content-type', 'application/json').send({ hello: 'world' }).expect(204);
    await api().post('/v1/csp-report').expect(204);
    expect(sink.events).toHaveLength(0);
  });

  it('clips long values and caps the number of reports', () => {
    const long = 'x'.repeat(1000);
    const reports = parseCspReports(
      Array.from({ length: 20 }, () => ({
        type: 'csp-violation',
        body: { effectiveDirective: 'style-src', blockedURL: long },
      })),
    );
    expect(reports).toHaveLength(10);
    expect(reports[0].blockedUri?.length).toBe(303);
  });
});
