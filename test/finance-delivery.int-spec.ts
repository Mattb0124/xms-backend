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
import { OBJECT_STORE } from '../src/common/storage/storage.module.js';
import type { ObjectStore } from '../src/common/storage/object-store.js';
import { resetEnvForTests } from '../src/config/env.js';
import { verifySignature } from '../src/domain/integrations/webhooks.js';
import { FinanceService } from '../src/modules/integrations/finance.module.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * Finance delivery (INT-02 cut): an administrator sets the account's
 * destination (the HTTPS secret shown once), a period locking delivers its
 * file on its own as a signed post with the manifest, finance acknowledges
 * through the API with its scope, a re-delivery supersedes the earlier one,
 * an object-store destination writes the file and the manifest under the
 * prefix, and a failing endpoint leaves a failed delivery with its reason.
 */
const ADMIN_EMAIL = 'admin@example.test';
const today = new Date().toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 8)}01`;
const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);

let app: INestApplication;
let worker: INestApplication;
let adminToken: string;
let apiKey: string;
let accountId: string;
let periodId: string;
let finance: FinanceService;
let store: ObjectStore;
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
      res.statusCode = mode === 'ok' ? 202 : 503;
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
  finance = worker.get(FinanceService);
  store = worker.get<ObjectStore>(OBJECT_STORE);

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
    .send({ name: 'Retainer', model: 'retainer', period_starts_on: monthStart, period_ends_on: monthEnd })
    .expect(201);
  const ticket = await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({
      account_id: accountId,
      type: 'incident',
      short_description: 'Billable work',
      impact: 'high',
      urgency: 'high',
    })
    .expect(201);
  await api()
    .post(`/v1/tickets/${ticket.body.key}/transitions`)
    .set(bearer(adminToken))
    .send({ version: 1, to: 'in_progress' })
    .expect(201);
  await api()
    .post(`/v1/tickets/${ticket.body.key}/time`)
    .set(bearer(adminToken))
    .send({ performed_on: today, minutes: 90, activity_type: 'analysis' })
    .expect(201);
  const period = await api()
    .post(`/v1/accounts/${accountId}/billing-periods`)
    .set(bearer(adminToken))
    .send({ starts_on: monthStart, ends_on: monthEnd })
    .expect(201);
  periodId = period.body.id;
  const client = await api()
    .post('/v1/admin/api-clients')
    .set(bearer(adminToken))
    .send({ name: 'Finance system', scopes: ['exports:read'], account_ids: [accountId] })
    .expect(201);
  apiKey = client.body.key;
});

afterAll(async () => {
  await worker?.close();
  await app?.close();
  await closePools();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function lockPeriod(): Promise<void> {
  const listed = await api().get(`/v1/accounts/${accountId}/billing-periods`).set(bearer(adminToken)).expect(200);
  const period = listed.body.find((row: { id: string }) => row.id === periodId);
  await api()
    .post(`/v1/accounts/${accountId}/billing-periods/${periodId}/lock`)
    .set(bearer(adminToken))
    .send({ version: period.version })
    .expect(201);
}

async function drainLockEvents(): Promise<void> {
  const rows = await withSuperuser((client) =>
    client.query(
      `select id, account_id, aggregate, aggregate_id, event_type, payload, correlation_id, origin, created_at from sys.outbox where event_type = 'billing_period.locked' order by id`,
    ),
  );
  for (const row of rows.rows)
    await finance.onOutbox({
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

describe('finance delivery (INT-02)', () => {
  let secret: string;
  let deliveryId: string;

  it('sets an HTTPS destination with the secret shown once and refuses a bad one', async () => {
    const bad = await api()
      .put(`/v1/finance/destinations/${accountId}`)
      .set(bearer(adminToken))
      .send({ kind: 'https', endpoint_url: 'ftp://finance.example.com/in' })
      .expect(400);
    expect(bad.body.code).toBe('invalid_endpoint');
    const missing = await api()
      .put(`/v1/finance/destinations/${accountId}`)
      .set(bearer(adminToken))
      .send({ kind: 'https' })
      .expect(400);
    expect(missing.body.code).toBe('endpoint_required');
    const set = await api()
      .put(`/v1/finance/destinations/${accountId}`)
      .set(bearer(adminToken))
      .send({ kind: 'https', endpoint_url: `http://127.0.0.1:${port}/finance`, format: 'csv' })
      .expect(200);
    expect(set.body).toMatchObject({ kind: 'https', format: 'csv', enabled: true });
    expect(set.body.secret).toMatch(/^whsec_/);
    secret = set.body.secret;
    const read = await api().get(`/v1/finance/destinations/${accountId}`).set(bearer(adminToken)).expect(200);
    expect(read.body.secret).toBeUndefined();
    expect(read.body.secret_kid).toBe(set.body.secret_kid);
    await api().get(`/v1/finance/destinations/${accountId}`).set(bearer(apiKey)).expect(403);
  });

  it('a locked period delivers itself as a signed post with the manifest, and finance acknowledges', async () => {
    await lockPeriod();
    await drainLockEvents();
    expect(received).toHaveLength(1);
    const hit = received[0];
    expect(hit.headers['x-xms-event']).toBe('finance.export');
    expect(
      verifySignature(String(hit.headers['x-xms-signature']), secret, String(hit.headers['x-xms-timestamp']), hit.body),
    ).toBe(true);
    const posted = JSON.parse(hit.body);
    expect(posted.manifest).toMatchObject({
      account_key: 'BRK',
      period_id: periodId,
      format: 'csv',
      row_count: 1,
      supersedes: null,
    });
    const csv = Buffer.from(posted.file, 'base64').toString('utf8');
    expect(csv.split('\r\n')[0]).toMatch(/^kind,id,entry_id,account,contract,period/);
    expect(csv).toContain(',90,');
    const deliveries = await api()
      .get(`/v1/finance/deliveries?account_id=${accountId}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(deliveries.body).toHaveLength(1);
    expect(deliveries.body[0]).toMatchObject({ status: 'delivered', destination_kind: 'https', response_status: 202 });
    deliveryId = deliveries.body[0].id;
    const period = await api().get(`/v1/accounts/${accountId}/billing-periods`).set(bearer(adminToken)).expect(200);
    expect(period.body[0].status).toBe('exported');
    // Finance acknowledges with its own scope, and only once.
    const ack = await api()
      .post(`/v1/finance/deliveries/${deliveryId}/ack`)
      .set(bearer(apiKey))
      .send({ reference: 'INV-2026-09' })
      .expect(201);
    expect(ack.body).toMatchObject({ status: 'acknowledged', ack_reference: 'INV-2026-09' });
    const again = await api().post(`/v1/finance/deliveries/${deliveryId}/ack`).set(bearer(apiKey)).send({}).expect(409);
    expect(again.body.code).toBe('not_deliverable');
  });

  it('re-delivery supersedes the earlier one; a failing endpoint leaves a failed delivery with its reason', async () => {
    received.length = 0;
    const redelivered = await api()
      .post('/v1/finance/deliveries')
      .set(bearer(adminToken))
      .send({ period_id: periodId })
      .expect(201);
    expect(redelivered.body).toMatchObject({ status: 'delivered', supersedes_id: deliveryId });
    expect(JSON.parse(received[0].body).manifest.supersedes).toBe(deliveryId);
    const rows = await withSuperuser((client) =>
      client.query(`select status from acct.finance_deliveries where billing_period_id = $1 order by created_at`, [
        periodId,
      ]),
    );
    expect(rows.rows.map((row) => row.status)).toEqual(['superseded', 'delivered']);
    mode = 'fail';
    const failed = await api()
      .post('/v1/finance/deliveries')
      .set(bearer(adminToken))
      .send({ period_id: periodId })
      .expect(201);
    expect(failed.body).toMatchObject({ status: 'failed', error: 'http 503', response_status: 503 });
    mode = 'ok';
    const audit = await withSuperuser((client) =>
      client.query(
        `select event_type from acct.audit_events where account_id = $1 and event_type like 'finance.%' order by created_at`,
        [accountId],
      ),
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      'finance.destination.set',
      'finance.delivered',
      'finance.acknowledged',
      'finance.delivered',
      'finance.delivery_failed',
    ]);
  });

  it('an object-store destination writes the file and the manifest under the prefix', async () => {
    const set = await api()
      .put(`/v1/finance/destinations/${accountId}`)
      .set(bearer(adminToken))
      .send({ kind: 'object_store', object_prefix: 'finance/thg', format: 'csv' })
      .expect(200);
    expect(set.body.secret).toBeUndefined();
    const delivered = await api()
      .post('/v1/finance/deliveries')
      .set(bearer(adminToken))
      .send({ period_id: periodId })
      .expect(201);
    expect(delivered.body).toMatchObject({ status: 'delivered', destination_kind: 'object_store' });
    expect(delivered.body.manifest_key).toBe(`finance/thg/BRK/${monthStart.slice(0, 7)}/manifest.json`);
    const manifest = JSON.parse((await store.getObject(delivered.body.manifest_key)).toString('utf8'));
    expect(manifest).toMatchObject({ account_key: 'BRK', row_count: 1 });
    const file = (await store.getObject(`finance/thg/BRK/${monthStart.slice(0, 7)}/finance.csv`)).toString('utf8');
    expect(file).toContain('kind,id,entry_id');
    const disabled = await api()
      .put(`/v1/finance/destinations/${accountId}`)
      .set(bearer(adminToken))
      .send({ kind: 'object_store', object_prefix: 'finance/thg', enabled: false })
      .expect(200);
    expect(disabled.body.enabled).toBe(false);
    const refused = await api()
      .post('/v1/finance/deliveries')
      .set(bearer(adminToken))
      .send({ period_id: periodId })
      .expect(409);
    expect(refused.body.code).toBe('no_destination');
  });
});
