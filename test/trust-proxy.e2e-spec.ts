import { Controller, Get, INestApplication, Module, Req, VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '../src/common/auth/decorators.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { trustProxyValue } from '../src/common/trust-proxy.js';

/**
 * The proxy setting behind the daily-salted IP hash and the rate-limit key
 * (security review finding 20). Behind an ALB, req.ip is the balancer for
 * every request: one caller's burst then refuses everyone, a distributed
 * attacker counts as one, and ip_hash on every security event is a constant,
 * which empties the Security dashboard's sign-in-failures-by-IP panel.
 */
@Controller('probe')
class ProbeController {
  @Get('ip')
  ip(@Req() request: Request & { requestContext?: RequestContext }): { ip?: string; ipHash?: string } {
    return { ip: request.ip, ipHash: request.requestContext?.ipHash };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

async function start(trustProxy?: string): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  if (trustProxy) app.set('trust proxy', trustProxyValue(trustProxy));
  app.use(requestContextMiddleware);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();
  return app;
}

let trusting: INestApplication;
let plain: INestApplication;

beforeAll(async () => {
  trusting = await start('1');
  plain = await start();
});

afterAll(async () => {
  await trusting?.close();
  await plain?.close();
});

const hashOf = async (app: INestApplication, forwardedFor?: string): Promise<string> => {
  let call = request(app.getHttpServer()).get('/v1/probe/ip');
  if (forwardedFor) call = call.set('x-forwarded-for', forwardedFor);
  return (await call.expect(200)).body.ipHash;
};

describe('trust proxy', () => {
  it('derives the caller from x-forwarded-for when a hop count is configured', async () => {
    const first = await hashOf(trusting, '203.0.113.9');
    const second = await hashOf(trusting, '198.51.100.4');
    const again = await hashOf(trusting, '203.0.113.9');
    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
    expect(again).toBe(first);
  });

  it('ignores the header when nothing is configured, so a caller cannot spoof it', async () => {
    const spoofed = await hashOf(plain, '203.0.113.9');
    const direct = await hashOf(plain);
    expect(spoofed).toBe(direct);
  });

  it('reads the setting as a hop count, a boolean or an address list', () => {
    expect(trustProxyValue('1')).toBe(1);
    expect(trustProxyValue('2')).toBe(2);
    expect(trustProxyValue('true')).toBe(true);
    expect(trustProxyValue('false')).toBe(false);
    expect(trustProxyValue('10.0.0.0/8')).toBe('10.0.0.0/8');
  });
});
