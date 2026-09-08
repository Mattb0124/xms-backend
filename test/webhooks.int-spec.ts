import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
import { OutboxDispatcher } from '../src/worker/outbox-dispatcher.js';
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
  // The worker's outbox dispatcher ticks every second on its own. This file
  // hands rows to the handler itself and asserts on what arrived; a
  // background tick doing the same work races the explicit drain and
  // delivers some events twice. Stop the timer and keep the drain the only
  // thing that dispatches.
  worker.get(OutboxDispatcher).onModuleDestroy();
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

/**
 * Webhook administration from the console (Integrations functional 5.2 and
 * 5.4): a signed-in person administers the endpoints of an account they are
 * granted, whichever client registered them. The account's list is the
 * account's alone, a pause by hand stops delivery and names its reason, a
 * resume starts it again, the automatic pause after continuous failure
 * reads back with its own reason, and a dead letter replays exactly once.
 * The console routes are for people and the client routes are for keys, and
 * neither principal reaches the other's.
 */
describe('webhook administration from the console', () => {
  let secondAccountId: string;
  let integratorKey: string;
  let integratorId: string;
  let subscriptionId: string;
  let managerToken: string;

  const consoleUrl = (account: string, suffix = '') => `/v1/accounts/${account}/webhooks${suffix}`;
  const rowOf = (body: Record<string, unknown>[], id: string) => body.find((row) => row.id === id);

  it('registers an endpoint for a client of the account and shows the secret once', async () => {
    const second = await api()
      .post('/v1/admin/accounts')
      .set(bearer(adminToken))
      .send({ key: 'ACME', name: 'Acme' })
      .expect(201);
    secondAccountId = second.body.id;
    await api().post(`/v1/admin/accounts/${secondAccountId}/activate`).set(bearer(adminToken)).expect(201);

    const integrator = await api()
      .post('/v1/admin/api-clients')
      .set(bearer(adminToken))
      .send({
        name: 'Console integrator',
        scopes: ['tickets:view', 'webhooks:manage'],
        account_ids: [accountId, secondAccountId],
      })
      .expect(201);
    integratorKey = integrator.body.key;
    integratorId = integrator.body.id;

    const created = await api()
      .post(consoleUrl(accountId))
      .set(bearer(adminToken))
      .send({
        api_client_id: integratorId,
        endpoint_url: `http://127.0.0.1:${port}/console`,
        event_types: ['ticket.created'],
      })
      .expect(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    expect(created.body).toMatchObject({
      status: 'active',
      account_id: accountId,
      api_client_id: integratorId,
      paused_reason: null,
      paused_note: null,
    });
    subscriptionId = created.body.id;

    // The other account gets its own endpoint, so the two lists can be told apart.
    await api()
      .post(consoleUrl(secondAccountId))
      .set(bearer(adminToken))
      .send({
        api_client_id: integratorId,
        endpoint_url: `http://127.0.0.1:${port}/console-second`,
        event_types: ['ticket.created'],
      })
      .expect(201);

    // A client the account does not have is not a client this route knows.
    const unknownClient = await api()
      .post(consoleUrl(accountId))
      .set(bearer(adminToken))
      .send({
        api_client_id: randomUUID(),
        endpoint_url: `http://127.0.0.1:${port}/nowhere`,
        event_types: ['ticket.created'],
      })
      .expect(404);
    expect(unknownClient.body).toMatchObject({ code: 'not_found', entity: 'api_client' });

    // Nothing raised before this block should reach the new endpoints.
    await withSuperuser((client) => client.query('delete from sys.outbox'));
    received.length = 0;
  });

  it('shows a granted person one account only, and refuses the account they do not hold', async () => {
    const role = await api()
      .post('/v1/admin/roles')
      .set(bearer(adminToken))
      .send({ catalog: 'operator', name: 'Webhook manager', permissions: ['webhooks:manage'] })
      .expect(201);
    await api()
      .post('/v1/admin/users')
      .set(bearer(adminToken))
      .send({
        email: 'wendy@example.test',
        first_name: 'Wendy',
        last_name: 'Hooks',
        role_ids: [role.body.id],
        account_ids: [accountId],
      })
      .expect(201);
    managerToken = await devToken({ sub: 'dev_wendy', email: 'wendy@example.test', sid: 'sess_wendy' });

    const mine = await api().get(consoleUrl(accountId)).set(bearer(managerToken)).expect(200);
    expect(mine.body.every((row: { account_id: string }) => row.account_id === accountId)).toBe(true);
    expect(rowOf(mine.body, subscriptionId)).toMatchObject({
      account_id: accountId,
      client: { id: integratorId, name: 'Console integrator', status: 'active' },
    });
    expect(rowOf(mine.body, subscriptionId)!.secret).toBeUndefined();
    expect(rowOf(mine.body, subscriptionId)!.secret_ciphertext).toBeUndefined();

    // The other account's endpoint is not on this list, and the account
    // itself does not exist as far as this reader is concerned.
    const otherList = await api().get(consoleUrl(secondAccountId)).set(bearer(adminToken)).expect(200);
    expect(otherList.body).toHaveLength(1);
    expect(mine.body.map((row: { id: string }) => row.id)).not.toContain(otherList.body[0].id);
    const other = await api().get(consoleUrl(secondAccountId)).set(bearer(managerToken)).expect(404);
    expect(other.body).toMatchObject({ code: 'not_found', entity: 'account' });
  });

  it('pauses delivery with a reason and resumes it', async () => {
    mode = 'ok';
    await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({ account_id: accountId, type: 'incident', short_description: 'Before the pause' })
      .expect(201);
    await drainOutbox();
    expect(received).toHaveLength(1);

    const noReason = await api()
      .post(consoleUrl(accountId, `/${subscriptionId}/pause`))
      .set(bearer(managerToken))
      .send({ reason: '   ' })
      .expect(400);
    expect(noReason.body.code).toBe('reason_required');

    const paused = await api()
      .post(consoleUrl(accountId, `/${subscriptionId}/pause`))
      .set(bearer(managerToken))
      .send({ reason: 'Client asked us to stop during their change freeze' })
      .expect(200);
    expect(paused.body).toMatchObject({
      status: 'paused',
      paused_reason: 'owner',
      paused_note: 'Client asked us to stop during their change freeze',
    });
    await api()
      .post(consoleUrl(accountId, `/${subscriptionId}/pause`))
      .set(bearer(managerToken))
      .send({ reason: 'again' })
      .expect(409);

    await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({ account_id: accountId, type: 'incident', short_description: 'During the pause' })
      .expect(201);
    await drainOutbox();
    expect(received).toHaveLength(1);
    // The dispatcher hands each outbox row to a subscription once; this
    // harness re-drains the whole table, so the row nothing took while the
    // subscription was paused is cleared here and the next drain is about
    // the resume alone.
    await withSuperuser((client) => client.query('delete from sys.outbox'));

    const resumed = await api()
      .post(consoleUrl(accountId, `/${subscriptionId}/resume`))
      .set(bearer(managerToken))
      .expect(200);
    expect(resumed.body).toMatchObject({ status: 'active', paused_reason: null, paused_note: null });
    await api()
      .post(consoleUrl(accountId, `/${subscriptionId}/resume`))
      .set(bearer(managerToken))
      .expect(409);

    await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({ account_id: accountId, type: 'incident', short_description: 'After the resume' })
      .expect(201);
    await drainOutbox();
    expect(received).toHaveLength(2);
    // A pause is a stop, not a queue: nothing arrived between the two.
    const bodies = received.map((hit) => JSON.parse(hit.body).data.ticket.short_description);
    expect(bodies).toEqual(['Before the pause', 'After the resume']);

    const deliveries = await api()
      .get(consoleUrl(accountId, `/${subscriptionId}/deliveries`))
      .set(bearer(managerToken))
      .expect(200);
    expect(deliveries.body).toHaveLength(2);
    expect(deliveries.body[0]).toMatchObject({ status: 'delivered', response_status: 200, attempt: 1 });
  });

  it('reads back the automatic pause and its reason, and replays a dead letter once', async () => {
    mode = 'fail';
    received.length = 0;
    await withSuperuser((client) => client.query('delete from sys.outbox'));
    for (let index = 0; index < 3; index += 1)
      await api()
        .post('/v1/tickets')
        .set(bearer(adminToken))
        .send({ account_id: accountId, type: 'incident', short_description: `Console failure ${index}` })
        .expect(201);
    await drainOutbox();
    for (let round = 0; round < 6; round += 1) {
      await withSuperuser((client) =>
        client.query(
          `update acct.webhook_deliveries set next_attempt_at = now() - interval '1 second' where status = 'retrying'`,
        ),
      );
      await delivery.retryDue();
    }

    // The pause the worker applied reads back on the console with the
    // reason it chose, and with no note, because nobody typed one.
    const listed = await api().get(consoleUrl(accountId)).set(bearer(managerToken)).expect(200);
    expect(rowOf(listed.body, subscriptionId)).toMatchObject({
      status: 'paused',
      paused_reason: 'continuous_failure',
      paused_note: null,
      consecutive_failures: 3,
    });

    const dead = await api()
      .get(consoleUrl(accountId, `/dead-letters?subscription=${subscriptionId}`))
      .set(bearer(managerToken))
      .expect(200);
    expect(dead.body).toHaveLength(3);
    expect(dead.body[0]).toMatchObject({
      subscription_id: subscriptionId,
      status: 'dead_lettered',
      attempt: 5,
      event_type: 'ticket.created',
      endpoint_url: `http://127.0.0.1:${port}/console`,
    });
    expect(dead.body[0].first_failed_at).toBeDefined();

    // A paused subscription is not replayed into: it would fail again.
    const refused = await api()
      .post(consoleUrl(accountId, `/dead-letters/${dead.body[0].id}/replay`))
      .set(bearer(managerToken))
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'subscription_not_active', status: 'paused' });

    await api()
      .post(consoleUrl(accountId, `/${subscriptionId}/resume`))
      .set(bearer(managerToken))
      .expect(200);
    mode = 'ok';
    received.length = 0;
    const replayed = await api()
      .post(consoleUrl(accountId, `/dead-letters/${dead.body[0].id}/replay`))
      .set(bearer(managerToken))
      .expect(200);
    expect(replayed.body).toMatchObject({ replayed: dead.body[0].id });
    expect(replayed.body.delivery).toMatchObject({ status: 'delivered', response_status: 200, attempt: 6 });
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0].body)).toMatchObject({ id: dead.body[0].outbox_id, type: 'ticket.created' });

    // Once, and once only: the row is claimed, so a second press sends nothing.
    const again = await api()
      .post(consoleUrl(accountId, `/dead-letters/${dead.body[0].id}/replay`))
      .set(bearer(managerToken))
      .expect(409);
    expect(again.body.code).toBe('not_dead_lettered');
    expect(received).toHaveLength(1);
    const remaining = await api()
      .get(consoleUrl(accountId, `/dead-letters?subscription=${subscriptionId}`))
      .set(bearer(managerToken))
      .expect(200);
    expect(remaining.body).toHaveLength(2);
  });

  it('keeps the console routes for people and the client routes for keys', async () => {
    // The key holds webhooks:manage and is granted the account, so the guard
    // admits it; it is still not a person administering an account.
    await api().get(consoleUrl(accountId)).set(bearer(integratorKey)).expect(404);
    await api()
      .post(consoleUrl(accountId, `/${subscriptionId}/pause`))
      .set(bearer(integratorKey))
      .send({ reason: 'not mine to pause' })
      .expect(404);
    await api().get(consoleUrl(accountId, '/dead-letters')).set(bearer(integratorKey)).expect(404);

    // And a session has no client behind it, so the client routes are closed to it.
    await api().get('/v1/webhooks').set(bearer(managerToken)).expect(404);
    await api()
      .post('/v1/webhooks')
      .set(bearer(managerToken))
      .send({ account_id: accountId, endpoint_url: 'https://hooks.example.com/x', event_types: ['ticket.created'] })
      .expect(404);

    // The client's own view of its own subscriptions still works.
    const own = await api().get('/v1/webhooks').set(bearer(integratorKey)).expect(200);
    expect(own.body.map((row: { id: string }) => row.id)).toContain(subscriptionId);

    const removed = await api()
      .delete(consoleUrl(accountId, `/${subscriptionId}`))
      .set(bearer(managerToken))
      .expect(200);
    expect(removed.body).toEqual({ removed: subscriptionId });
    await api()
      .delete(consoleUrl(accountId, `/${subscriptionId}`))
      .set(bearer(managerToken))
      .expect(404);
    const after = await api().get(consoleUrl(accountId)).set(bearer(managerToken)).expect(200);
    expect(after.body.map((row: { id: string }) => row.id)).not.toContain(subscriptionId);
  });
});
