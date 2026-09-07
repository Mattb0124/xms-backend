import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { resetEnvForTests } from '../src/config/env.js';
import { dayOf, DigestService, nextDay } from '../src/modules/integrity/integrity.module.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * Tamper evidence (P1.7.6 cut, XA-04): a digest per stream per day over the
 * real tables, chained to the previous day, stored as a file, announced by
 * `integrity.digest.written`; verification matches an untouched day and
 * raises `integrity.digest.mismatch` when a row was altered underneath the
 * append-only trigger; the job is idempotent and the admin routes are gated.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let digests: DigestService;
let storeRoot: string;
const today = dayOf(new Date());
const yesterday = dayOf(new Date(Date.now() - 86_400_000));
const twoDaysAgo = dayOf(new Date(Date.now() - 2 * 86_400_000));

beforeAll(async () => {
  await resetDatabase();
  const db = urls();
  storeRoot = mkdtempSync(join(tmpdir(), 'xms-store-'));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL_APP: db.app,
    DATABASE_URL_PORTAL: db.portal,
    DATABASE_URL_WORKER: db.worker,
    AUTH_DEV_SECRET: DEV_SECRET,
    BOOTSTRAP_ADMIN_EMAILS: ADMIN_EMAIL,
    STORAGE_KIND: 'local',
    STORAGE_LOCAL_ROOT: storeRoot,
    MAIL_TRANSPORT: 'file',
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
  digests = app.get(DigestService);
  adminToken = await devToken({ sub: 'dev_admin', email: ADMIN_EMAIL, sid: 'sess_admin' });
  await api().post('/v1/bootstrap').set(bearer(adminToken)).expect(201);
  const account = await api()
    .post('/v1/admin/accounts')
    .set(bearer(adminToken))
    .send({ key: 'BRK', name: 'Brookfield' })
    .expect(201);
  await api().post(`/v1/admin/accounts/${account.body.id}/activate`).set(bearer(adminToken)).expect(201);
  // Backdated security rows so a past day carries content for the chain test.
  await withSuperuser((client) =>
    client.query(
      `insert into sys.security_events (event_type, outcome, actor_kind, actor_id, occurred_at, attrs)
       values ('auth.signin.success', 'success', 'user', 'u1', $1::date + interval '10 hours', '{}'),
              ('auth.signin.failed', 'denied', 'user', 'u2', $1::date + interval '11 hours', '{}'),
              ('auth.signin.success', 'success', 'user', 'u3', $2::date + interval '9 hours', '{}')`,
      [twoDaysAgo, yesterday],
    ),
  );
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

function api() {
  return request(app.getHttpServer());
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('digest chain', () => {
  it('writes one digest per stream per past day, chained, with a file and a security event', async () => {
    const outcome = await digests.writeMissing();
    expect(outcome).toMatch(/^digests \d+$/);
    const rows = await withSuperuser((client) =>
      client.query<{
        stream: string;
        day: string;
        row_count: number;
        digest: string;
        previous_digest: string | null;
        object_key: string;
      }>(
        `select stream, day::text as day, row_count, digest, previous_digest, object_key from sys.event_digests order by stream, day`,
      ),
    );
    const security = rows.rows.filter((row) => row.stream === 'security');
    expect(security.map((row) => row.day)).toEqual([twoDaysAgo, yesterday]);
    expect(security[0].row_count).toBe(2);
    expect(security[0].previous_digest).toBeNull();
    expect(security[1].row_count).toBe(1);
    expect(security[1].previous_digest).toBe(security[0].digest);
    expect(security[1].digest).toMatch(/^[0-9a-f]{64}$/);
    // The file mirrors the row.
    const file = join(storeRoot, security[1].object_key);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      stream: 'security',
      day: yesterday,
      digest: security[1].digest,
    });
    const written = await withSuperuser((client) =>
      client.query(
        `select attrs from sys.security_events where event_type = 'integrity.digest.written' order by occurred_at`,
      ),
    );
    expect(written.rows.length).toBe(rows.rows.length);
    expect(written.rows.map((row) => row.attrs.stream)).toContain('security');
    // Today is never digested by the nightly pass (it is still being written).
    expect(rows.rows.some((row) => row.day === today)).toBe(false);
  });

  it('is idempotent: a second pass writes nothing new', async () => {
    const before = await withSuperuser((client) => client.query(`select count(*)::int as n from sys.event_digests`));
    expect(await digests.writeMissing()).toBe('digests 0');
    const after = await withSuperuser((client) => client.query(`select count(*)::int as n from sys.event_digests`));
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('verifies an untouched day and records the check', async () => {
    const result = await digests.verify('security', yesterday, 'test');
    expect(result.matched).toBe(true);
    expect(result.expected).toBe(result.actual);
    expect(await digests.verifyRecent()).toMatch(/^verified \d+, mismatched 0$/);
    // At most once a day per digest.
    expect(await digests.verifyRecent()).toBe('verified 0, mismatched 0');
  });

  it('detects a row altered underneath the append-only trigger and raises the mismatch event', async () => {
    await withSuperuser(async (client) => {
      await client.query(`alter table sys.security_events disable trigger all`);
      await client.query(`update sys.security_events set actor_id = 'tampered' where actor_id = 'u2'`);
      await client.query(`alter table sys.security_events enable trigger all`);
    });
    const result = await digests.verify('security', twoDaysAgo, 'test');
    expect(result.matched).toBe(false);
    expect(result.actual).not.toBe(result.expected);
    const mismatch = await withSuperuser((client) =>
      client.query(`select outcome, attrs from sys.security_events where event_type = 'integrity.digest.mismatch'`),
    );
    expect(mismatch.rows).toHaveLength(1);
    expect(mismatch.rows[0]).toMatchObject({ outcome: 'failed', attrs: { stream: 'security', day: twoDaysAgo } });
    // The following day still verifies: the chain input is the stored previous digest, not a recomputation.
    expect((await digests.verify('security', yesterday, 'test')).matched).toBe(true);
  });

  it('digests the audit stream across every account and a day with no rows', async () => {
    const audit = await digests.write('audit', today, 'test');
    expect(audit.row_count).toBeGreaterThan(0);
    expect((await digests.verify('audit', today, 'test')).matched).toBe(true);
    const empty = await digests.write('usage', nextDay(today), 'test');
    expect(empty.row_count).toBe(0);
    expect(empty.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('admin routes', () => {
  it('exposes status and the digest list to audit readers and verification to exporters', async () => {
    const status = await api().get('/v1/admin/integrity/status').set(bearer(adminToken)).expect(200);
    expect(status.body.digests.map((row: { stream: string }) => row.stream).sort()).toEqual([
      'audit',
      'security',
      'usage',
    ]);
    expect(status.body.last_mismatch_at).toBeTruthy();
    const list = await api()
      .get('/v1/admin/integrity/digests?stream=security&days=10')
      .set(bearer(adminToken))
      .expect(200);
    expect(list.body.length).toBe(2);
    expect(list.body[0]).toMatchObject({ stream: 'security', last_matched: expect.any(Boolean) });
    const verify = await api()
      .post('/v1/admin/integrity/verify')
      .set(bearer(adminToken))
      .send({ stream: 'security', day: yesterday })
      .expect(201);
    expect(verify.body).toMatchObject({ matched: true });
    await api()
      .post('/v1/admin/integrity/verify')
      .set(bearer(adminToken))
      .send({ stream: 'security', day: '2020-01-01' })
      .expect(400);
    await api().get('/v1/admin/integrity/status').expect(401);
  });
});
