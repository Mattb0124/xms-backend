import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { resetEnvForTests } from '../src/config/env.js';
import { verifySignature } from '../src/domain/integrations/webhooks.js';
import { WebhookDeliveryService } from '../src/modules/integrations/webhooks.module.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * API clients and outbound webhooks (INT-05 cut): an administrator creates
 * a scoped client and sees the key once; the client registers an endpoint
 * for public events (HTTPS only, no private hosts unless the deployment
 * allows it), receives a signed delivery for a ticket it may see, the
 * signature verifies with the secret shown once, a failing endpoint is
 * retried and dead-lettered until the subscription pauses itself, and a
 * revoked client loses its subscriptions.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let worker: INestApplication;
let adminToken: string;
let accountId: string;
let apiKey: string;
let clientId: string;
let delivery: WebhookDeliveryService;
let server: Server;
let port: number;
let mode: 'ok' | 'fail' = 'ok';
const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];

beforeAll(async () => {
  await resetDatabase();
  const db = urls();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL_APP: db.app,
    DATABASE_URL_PORTAL: db.portal,
    DATABASE_URL_WORKER: db.worker,
    AUTH_DEV_SECRET: DEV_SECRET,
    BOOTSTRAP_ADMIN_EMAILS: ADMIN_EMAIL,
    STORAGE_KIND: 'local',
    STORAGE_LOCAL_ROOT: mkdtempSync(join(tmpdir(), 'xms-store-')),
    MAIL_TRANSPORT: 'file',
    WEBHOOK_SECRETS_KEY: 'test-sealing-key-for-webhooks-only',
    WEBHOOK_ALLOW_PRIVATE: 'true',
  });
  resetEnvForTests();
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ headers: req.headers as Record<string, string | undefined>, body });
      res.statusCode = mode === 'ok' ? 200 : 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;

  const { AppModule } = await import('../src/app.module.js');
  const { WorkerModule } = await import('../src/worker/worker.module.js');
  const apiRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = apiRef.createNestApplication({ bufferLogs: true });
  app.use(requestContextMiddleware);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  const workerRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  worker = workerRef.createNestApplication({ bufferLogs: true });
  await worker.init();
  delivery = worker.get(WebhookDeliveryService);

  adminToken = await devToken({ sub: 'dev_admin', email: ADMIN_EMAIL, sid: 'sess_admin' });
  await api().post('/v1/bootstrap').set(bearer(adminToken)).expect(201);
  const account = await api()
    .post('/v1/admin/accounts')
    .set(bearer(adminToken))
    .send({ key: 'BRK', name: 'Brookfield' })
    .expect(201);
  accountId = account.body.id;
  await api().post(`/v1/admin/accounts/${accountId}/activate`).set(bearer(adminToken)).expect(201);
  await api()
    .post(`/v1/accounts/${accountId}/contracts`)
    .set(bearer(adminToken))
    .send({ name: 'Retainer', model: 'retainer' })
    .expect(201);
});

afterAll(async () => {
  await worker?.close();
  await app?.close();
  await closePools();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function drainOutbox(): Promise<void> {
  const rows = await withSuperuser((client) =>
    client.query(
      `select id, account_id, aggregate, aggregate_id, event_type, payload, correlation_id, origin, created_at from sys.outbox order by id`,
    ),
  );
  for (const row of rows.rows)
    await delivery.onOutbox({
      id: String(row.id),
      account_id: row.account_id,
      aggregate: row.aggregate,
      aggregate_id: row.aggregate_id,
      event_type: row.event_type,
      payload: row.payload,
      correlation_id: row.correlation_id,
      origin: row.origin,
      created_at: row.created_at,
      attempts: 0,
    });
}

describe('API clients', () => {
  it('an administrator creates a scoped client and sees the key once; the key reads what it is granted', async () => {
    const scopes = await api().get('/v1/admin/api-clients/scopes').set(bearer(adminToken)).expect(200);
    expect(scopes.body.map((row: { scope: string }) => row.scope)).toContain('webhooks:manage');
    const created = await api()
      .post('/v1/admin/api-clients')
      .set(bearer(adminToken))
      .send({ name: 'Integrator', scopes: ['tickets:view', 'webhooks:manage'], account_ids: [accountId] })
      .expect(201);
    expect(created.body.key).toMatch(/^xms_live_/);
    expect(created.body).toMatchObject({ name: 'Integrator', status: 'active', account_ids: [accountId] });
    // The grants come back as persisted, with the key and name the screen shows.
    expect(created.body.accounts).toEqual([{ id: accountId, key: 'BRK', name: 'Brookfield' }]);
    apiKey = created.body.key;
    clientId = created.body.id;
    const listed = await api().get('/v1/admin/api-clients').set(bearer(adminToken)).expect(200);
    expect(listed.body[0]).toMatchObject({ id: clientId, key_prefix: apiKey.slice(0, 16) });
    expect(listed.body[0].accounts).toEqual([{ id: accountId, key: 'BRK', name: 'Brookfield' }]);
    expect(listed.body[0].key).toBeUndefined();
    const tickets = await api().get('/v1/tickets').set(bearer(apiKey)).expect(200);
    expect(tickets.body).toBeDefined();
    await api().get('/v1/admin/api-clients').set(bearer(apiKey)).expect(403);
    const bad = await api()
      .post('/v1/admin/api-clients')
      .set(bearer(adminToken))
      .send({ name: 'Wrong', scopes: ['admin:users'], account_ids: [accountId] })
      .expect(400);
    expect(bad.body.code).toBe('validation_failed');
  });

  it('defaults the rate limit to 600 a minute, takes a configured one and enforces it on the key', async () => {
    // The default from 0029, on the client created above.
    const listed = await api().get('/v1/admin/api-clients').set(bearer(adminToken)).expect(200);
    expect(listed.body[0].rate_limit_per_minute).toBe(600);
    const headers = await api().get('/v1/tickets').set(bearer(apiKey)).expect(200);
    expect(headers.headers['x-ratelimit-limit']).toBe('600');

    const slow = await api()
      .post('/v1/admin/api-clients')
      .set(bearer(adminToken))
      .send({ name: 'Rationed', scopes: ['tickets:view'], account_ids: [accountId], rate_limit_per_minute: 2 })
      .expect(201);
    expect(slow.body.rate_limit_per_minute).toBe(2);
    const slowKey: string = slow.body.key;
    for (const remaining of ['1', '0']) {
      const allowed = await api().get('/v1/tickets').set(bearer(slowKey)).expect(200);
      expect(allowed.headers['x-ratelimit-limit']).toBe('2');
      expect(allowed.headers['x-ratelimit-remaining']).toBe(remaining);
    }
    const refused = await api().get('/v1/tickets').set(bearer(slowKey)).expect(429);
    expect(refused.body).toMatchObject({ code: 'rate_limited', policy: 'api_client' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // The rationed client's window is its own: the first key still answers.
    await api().get('/v1/tickets').set(bearer(apiKey)).expect(200);
    const events = await withSuperuser((client) =>
      client.query<{ attrs: { policy: string; per_minute: number } }>(
        `select attrs from sys.security_events where event_type = 'abuse.rate_limited'`,
      ),
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].attrs).toMatchObject({ policy: 'api_client', per_minute: 2 });
    // A limit outside the column's range is refused before it reaches the database.
    await api()
      .post('/v1/admin/api-clients')
      .set(bearer(adminToken))
      .send({ name: 'Zero', scopes: ['tickets:view'], account_ids: [accountId], rate_limit_per_minute: 0 })
      .expect(400);
  });
});

describe('webhooks (INT-05)', () => {
  let subscriptionId: string;
  let secret: string;

  it('registers an endpoint with the secret shown once and refuses private or plain destinations by default', async () => {
    const types = await api().get('/v1/webhooks/event-types').set(bearer(apiKey)).expect(200);
    expect(types.body).toContain('ticket.created');
    const plain = await api()
      .post('/v1/webhooks')
      .set(bearer(apiKey))
      .send({ account_id: accountId, endpoint_url: 'ftp://hooks.example.com/x', event_types: ['ticket.created'] })
      .expect(400);
    expect(plain.body).toMatchObject({ code: 'invalid_endpoint', problem: 'not_https' });
    const created = await api()
      .post('/v1/webhooks')
      .set(bearer(apiKey))
      .send({
        account_id: accountId,
        endpoint_url: `http://127.0.0.1:${port}/hooks`,
        event_types: ['ticket.created', 'ticket.transitioned', 'comment.created'],
      })
      .expect(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    expect(created.body).toMatchObject({
      status: 'active',
      event_types: ['ticket.created', 'ticket.transitioned', 'comment.created'],
    });
    subscriptionId = created.body.id;
    secret = created.body.secret;
    const again = await api()
      .post('/v1/webhooks')
      .set(bearer(apiKey))
      .send({ account_id: accountId, endpoint_url: `http://127.0.0.1:${port}/hooks`, event_types: ['ticket.created'] })
      .expect(409);
    expect(again.body.code).toBe('endpoint_exists');
    const listed = await api().get('/v1/webhooks').set(bearer(apiKey)).expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].secret).toBeUndefined();
    expect(listed.body[0].secret_ciphertext).toBeUndefined();
    // The routes belong to API clients: an internal user holding the permission still has no client behind it.
    await api().get('/v1/webhooks').set(bearer(adminToken)).expect(404);
  });

  it('delivers a signed public payload for a ticket event and records the attempt', async () => {
    const ticket = await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        type: 'incident',
        short_description: 'Webhook me',
        impact: 'high',
        urgency: 'high',
      })
      .expect(201);
    await drainOutbox();
    expect(received).toHaveLength(1);
    const hit = received[0];
    expect(hit.headers['x-xms-event']).toBe('ticket.created');
    expect(hit.headers['x-xms-delivery']).toBeDefined();
    const signature = String(hit.headers['x-xms-signature']);
    const timestamp = String(hit.headers['x-xms-timestamp']);
    expect(verifySignature(signature, secret, timestamp, hit.body)).toBe(true);
    expect(verifySignature(signature, 'whsec_wrong', timestamp, hit.body)).toBe(false);
    const envelope = JSON.parse(hit.body);
    expect(envelope).toMatchObject({ type: 'ticket.created', account_id: accountId });
    expect(envelope.data.ticket).toMatchObject({ key: ticket.body.key, state: 'new', type: 'incident' });
    expect(envelope.data.ticket.account_id).toBeUndefined();
    const deliveries = await api().get(`/v1/webhooks/${subscriptionId}/deliveries`).set(bearer(apiKey)).expect(200);
    expect(deliveries.body).toHaveLength(1);
    expect(deliveries.body[0]).toMatchObject({
      event_type: 'ticket.created',
      attempt: 1,
      status: 'delivered',
      response_status: 200,
    });
  });

  it('retries a failing endpoint with backoff, dead-letters after five attempts and pauses the subscription after three', async () => {
    mode = 'fail';
    received.length = 0;
    await withSuperuser((client) => client.query('delete from sys.outbox'));
    for (let index = 0; index < 3; index += 1) {
      await api()
        .post('/v1/tickets')
        .set(bearer(adminToken))
        .send({ account_id: accountId, type: 'incident', short_description: `Failing ${index}` })
        .expect(201);
    }
    await drainOutbox();
    let rows = await withSuperuser((client) =>
      client.query(
        `select status, count(*)::int as n from acct.webhook_deliveries where subscription_id = $1 group by status`,
        [subscriptionId],
      ),
    );
    expect(Object.fromEntries(rows.rows.map((row) => [row.status, row.n]))).toMatchObject({
      retrying: 3,
      delivered: 1,
    });
    // Bring every retry forward and run the retry job until nothing is due.
    for (let round = 0; round < 6; round += 1) {
      await withSuperuser((client) =>
        client.query(
          `update acct.webhook_deliveries set next_attempt_at = now() - interval '1 second' where status = 'retrying'`,
        ),
      );
      await delivery.retryDue();
    }
    rows = await withSuperuser((client) =>
      client.query(
        `select status, count(*)::int as n from acct.webhook_deliveries where subscription_id = $1 group by status`,
        [subscriptionId],
      ),
    );
    const counts = Object.fromEntries(rows.rows.map((row) => [row.status, row.n]));
    expect(counts.dead_lettered).toBe(3);
    expect(counts.replayed).toBe(12);
    expect(counts.retrying).toBeUndefined();
    const paused = await api().get('/v1/webhooks').set(bearer(apiKey)).expect(200);
    expect(paused.body[0]).toMatchObject({
      status: 'paused',
      paused_reason: 'continuous_failure',
      consecutive_failures: 3,
    });
    mode = 'ok';
  });

  it('rotates the secret, removes the subscription, and a revoked client is refused', async () => {
    const rotated = await api().post(`/v1/webhooks/${subscriptionId}/rotate-secret`).set(bearer(apiKey)).expect(201);
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(secret);
    await api().delete(`/v1/webhooks/${subscriptionId}`).set(bearer(apiKey)).expect(200);
    await api().delete(`/v1/webhooks/${subscriptionId}`).set(bearer(apiKey)).expect(404);
    await api().post(`/v1/admin/api-clients/${clientId}/revoke`).set(bearer(adminToken)).expect(200);
    await api().get('/v1/webhooks').set(bearer(apiKey)).expect(401);
    const again = await api().post(`/v1/admin/api-clients/${clientId}/revoke`).set(bearer(adminToken)).expect(409);
    expect(again.body.code).toBe('already_revoked');
  });

  it('revoking a client pauses its live subscriptions and stops delivering to them', async () => {
    const created = await api()
      .post('/v1/admin/api-clients')
      .set(bearer(adminToken))
      .send({ name: 'Second', scopes: ['tickets:view', 'webhooks:manage'], account_ids: [accountId] })
      .expect(201);
    const secondKey: string = created.body.key;
    const secondId: string = created.body.id;
    const subscription = await api()
      .post('/v1/webhooks')
      .set(bearer(secondKey))
      .send({
        account_id: accountId,
        endpoint_url: `http://127.0.0.1:${port}/hooks`,
        event_types: ['ticket.created'],
      })
      .expect(201);
    await api().post(`/v1/admin/api-clients/${secondId}/revoke`).set(bearer(adminToken)).expect(200);

    // The pause is a write to an account-scoped table: under an unbound
    // connection it matches no row and silently does nothing.
    const paused = await withSuperuser((client) =>
      client.query<{ status: string; paused_reason: string | null }>(
        'select status, paused_reason from acct.webhook_subscriptions where id = $1',
        [subscription.body.id],
      ),
    );
    expect(paused.rows[0]).toMatchObject({ status: 'paused', paused_reason: 'client_revoked' });

    // And nothing further reaches the endpoint the revoked credential chose.
    received.length = 0;
    await withSuperuser((client) => client.query('delete from sys.outbox'));
    await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({ account_id: accountId, type: 'incident', short_description: 'After revocation' })
      .expect(201);
    await drainOutbox();
    expect(received).toHaveLength(0);
    const deliveries = await withSuperuser((client) =>
      client.query<{ n: number }>('select count(*)::int as n from acct.webhook_deliveries where subscription_id = $1', [
        subscription.body.id,
      ]),
    );
    expect(deliveries.rows[0].n).toBe(0);
  });
});
