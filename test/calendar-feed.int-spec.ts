import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { resetEnvForTests } from '../src/config/env.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * The change calendar as an ICS feed (INT-05; Integrations functional 5.6).
 * The signed-in route answers one account; the token route answers every
 * account its owner is granted and is the one a calendar client polls, so
 * what is under test is the token as a credential, the revocation, and the
 * stamps and identifiers a subscriber depends on.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let caraToken: string;
let accountId: string;
let otherAccountId: string;
let windowId: string;

const days = (count: number): string => new Date(Date.now() + count * 86_400_000).toISOString();

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
    API_BASE_URL: 'https://api.xms.test',
  });
  resetEnvForTests();
  const { AppModule } = await import('../src/app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.use(requestContextMiddleware);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();

  adminToken = await devToken({ sub: 'dev_admin', email: ADMIN_EMAIL, sid: 'sess_admin' });
  await api().post('/v1/bootstrap').set(bearer(adminToken)).expect(201);

  accountId = await newAccount('BRK', 'Brookfield');
  otherAccountId = await newAccount('ACM', 'Acme');

  const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
  const consultant = roles.body.find((role: { name: string }) => role.name === 'Consultant');
  await api()
    .post('/v1/admin/users')
    .set(bearer(adminToken))
    .send({
      email: 'cara@example.test',
      first_name: 'Cara',
      last_name: 'Lee',
      role_ids: [consultant.id],
      account_ids: [accountId],
    })
    .expect(201);
  caraToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });
  await api().get('/v1/accounts').set(bearer(caraToken)).expect(200);

  windowId = await newWindow(accountId, {
    name: 'Azure Files cutover',
    description: 'Estate move; two nights',
    starts_at: days(10),
    ends_at: days(11),
    freeze_windows: [{ starts_at: days(20), ends_at: days(22), reason: 'Year end close' }],
  });
  await newWindow(otherAccountId, { name: 'Acme patching', starts_at: days(12), ends_at: days(13) });
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const lines = (document: string): string[] => document.split('\r\n');

async function newAccount(key: string, name: string): Promise<string> {
  const account = await api().post('/v1/admin/accounts').set(bearer(adminToken)).send({ key, name }).expect(201);
  await api().post(`/v1/admin/accounts/${account.body.id}/activate`).set(bearer(adminToken)).expect(201);
  await api()
    .post(`/v1/accounts/${account.body.id}/contracts`)
    .set(bearer(adminToken))
    .send({ name: 'Support retainer', model: 'retainer', period_hours: 100 })
    .expect(201);
  return account.body.id;
}

async function newWindow(account: string, body: Record<string, unknown>): Promise<string> {
  const created = await api()
    .post('/v1/ticket-groups')
    .set(bearer(adminToken))
    .send({ account_id: account, kind: 'change_window', status: 'active', ...body })
    .expect(201);
  return created.body.id;
}

describe('the change calendar feed', () => {
  it('answers a signed-in reader with the account it names and nothing else', async () => {
    const feed = await api().get(`/v1/accounts/${accountId}/change-calendar.ics`).set(bearer(caraToken)).expect(200);
    expect(feed.headers['content-type']).toContain('text/calendar');
    const body = feed.text;
    expect(lines(body)).toContain(`UID:change-window-${windowId}@xms`);
    expect(lines(body)).toContain('SUMMARY:BRK: Azure Files cutover');
    expect(lines(body)).toContain(`UID:change-freeze-${windowId}-0@xms`);
    expect(lines(body)).toContain('SUMMARY:BRK: freeze\\, Year end close');
    expect(lines(body)).toContain('TRANSP:TRANSPARENT');
    expect(body).not.toContain('Acme patching');
    // Every stamp is UTC and there is no zone block for a client to argue with.
    expect(body).not.toContain('VTIMEZONE');
    for (const line of lines(body).filter((candidate) => /^DT(START|END|STAMP):/.test(candidate)))
      expect(line).toMatch(/^DT(START|END|STAMP):\d{8}T\d{6}Z$/);

    // Cara is granted Brookfield only.
    await api().get(`/v1/accounts/${otherAccountId}/change-calendar.ics`).set(bearer(caraToken)).expect(404);
  });

  it('serves a calendar client on the feed token alone and stops on revocation', async () => {
    const minted = await api().post('/v1/me/calendar-token').set(bearer(caraToken)).expect(201);
    expect(minted.body.token).toEqual(expect.any(String));
    expect(minted.body.url).toBe(
      `https://api.xms.test/v1/calendar-feed/${minted.body.id}/change-calendar.ics?token=${encodeURIComponent(minted.body.token)}`,
    );

    // The token itself is never stored; only its hash is.
    const stored = await withSuperuser((client) =>
      client.query('select token_hash, last_used_at, revoked_at from op.calendar_feed_tokens where id = $1', [
        minted.body.id,
      ]),
    );
    expect(stored.rows[0].token_hash).not.toBe(minted.body.token);
    expect(stored.rows[0].last_used_at).toBeNull();

    const path = `/v1/calendar-feed/${minted.body.id}/change-calendar.ics`;
    // No bearer header at all: the token in the query is the whole credential.
    const feed = await api()
      .get(`${path}?token=${encodeURIComponent(minted.body.token)}`)
      .expect(200);
    expect(lines(feed.text)).toContain(`UID:change-window-${windowId}@xms`);
    expect(feed.text).not.toContain('Acme patching');

    const used = await withSuperuser((client) =>
      client.query('select last_used_at from op.calendar_feed_tokens where id = $1', [minted.body.id]),
    );
    expect(used.rows[0].last_used_at).not.toBeNull();

    // A wrong token and an unknown feed answer the same 404, so neither confirms an id.
    const wrong = await api().get(`${path}?token=not-the-token`).expect(404);
    expect(wrong.body.code).toBe('not_found');
    await api()
      .get(`/v1/calendar-feed/00000000-0000-4000-8000-0000000000ff/change-calendar.ics?token=anything`)
      .expect(404);
    // The token is the credential, so the route refuses without one.
    await api().get(path).expect(400);

    await api().delete('/v1/me/calendar-token').set(bearer(caraToken)).expect(204);
    await api()
      .get(`${path}?token=${encodeURIComponent(minted.body.token)}`)
      .expect(404);
    const revoked = await withSuperuser((client) =>
      client.query('select revoked_at from op.calendar_feed_tokens where id = $1', [minted.body.id]),
    );
    expect(revoked.rows[0].revoked_at).not.toBeNull();
  });

  it('spans the granted accounts, filters to one, and bumps the sequence when the window moves', async () => {
    const minted = await api().post('/v1/me/calendar-token').set(bearer(adminToken)).expect(201);
    const path = `/v1/calendar-feed/${minted.body.id}/change-calendar.ics`;
    const token = encodeURIComponent(minted.body.token);

    // The administrator is granted every live account, so one subscription carries both.
    const all = await api().get(`${path}?token=${token}`).expect(200);
    expect(all.text).toContain('SUMMARY:BRK: Azure Files cutover');
    expect(all.text).toContain('SUMMARY:ACM: Acme patching');

    const one = await api().get(`${path}?token=${token}&account_id=${accountId}`).expect(200);
    expect(one.text).toContain('SUMMARY:BRK: Azure Files cutover');
    expect(one.text).not.toContain('Acme patching');
    // A window nobody has edited is sequence 0.
    expect(lines(one.text)).toContain('SEQUENCE:0');

    const record = await api().get(`/v1/ticket-groups/${windowId}`).set(bearer(adminToken)).expect(200);
    await api()
      .patch(`/v1/ticket-groups/${windowId}`)
      .set(bearer(adminToken))
      .send({
        version: record.body.version,
        starts_at: days(30),
        ends_at: days(31),
        change_window_reason: 'The client moved the cutover weekend',
      })
      .expect(200);

    const moved = await api().get(`${path}?token=${token}&account_id=${accountId}`).expect(200);
    expect(lines(moved.text)).toContain(`UID:change-window-${windowId}@xms`);
    expect(lines(moved.text)).toContain('SEQUENCE:1');

    const cancelledRecord = await api().get(`/v1/ticket-groups/${windowId}`).set(bearer(adminToken)).expect(200);
    await api()
      .patch(`/v1/ticket-groups/${windowId}`)
      .set(bearer(adminToken))
      .send({ version: cancelledRecord.body.version, status: 'cancelled' })
      .expect(200);

    // A cancelled window stays in the feed as CANCELLED: a subscriber already
    // holds the event and needs it written back to be rid of it.
    const cancelled = await api().get(`${path}?token=${token}&account_id=${accountId}`).expect(200);
    expect(lines(cancelled.text)).toContain(`UID:change-window-${windowId}@xms`);
    expect(lines(cancelled.text)).toContain('STATUS:CANCELLED');
    expect(lines(cancelled.text)).toContain('SEQUENCE:2');
  });
});
