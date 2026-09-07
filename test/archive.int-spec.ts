import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { OBJECT_STORE } from '../src/common/storage/storage.module.js';
import type { ObjectStore } from '../src/common/storage/object-store.js';
import { resetEnvForTests } from '../src/config/env.js';
import { ArchiveService, archiveKey, DigestService } from '../src/modules/integrity/integrity.module.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * The event archive (XA-04 cold storage): the previous day's canonical rows
 * of every stream go to the object store as gzipped NDJSON, once, with a
 * row count and checksum recorded beside the day's digest; the file holds
 * exactly the rows the digest hashed; the admin route lists the archives.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let worker: INestApplication;
let adminToken: string;
let archive: ArchiveService;
let digests: DigestService;
let store: ObjectStore;

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
  });
  resetEnvForTests();
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
  archive = worker.get(ArchiveService);
  digests = worker.get(DigestService);
  store = worker.get<ObjectStore>(OBJECT_STORE);

  adminToken = await devToken({ sub: 'dev_admin', email: ADMIN_EMAIL, sid: 'sess_admin' });
  await api().post('/v1/bootstrap').set(bearer(adminToken)).expect(201);
  const account = await api()
    .post('/v1/admin/accounts')
    .set(bearer(adminToken))
    .send({ key: 'BRK', name: 'Brookfield' })
    .expect(201);
  await api().post(`/v1/admin/accounts/${account.body.id}/activate`).set(bearer(adminToken)).expect(201);
  await api()
    .post(`/v1/accounts/${account.body.id}/contracts`)
    .set(bearer(adminToken))
    .send({ name: 'Retainer', model: 'retainer' })
    .expect(201);
  await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({ account_id: account.body.id, type: 'incident', short_description: 'Archive me' })
    .expect(201);
});

afterAll(async () => {
  await worker?.close();
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('event archive (XA-04)', () => {
  it('writes each stream and day once, with the rows the digest hashed, and lists them', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000);
    // Digests first, so the archive rows can point at them.
    await digests.writeMissing(tomorrow);
    // The usage stream archives only once the request telemetry has landed, so two or three streams.
    const first = await archive.exportMissing(tomorrow);
    expect(first).toMatch(/^archived [23]$/);
    const archived = Number(first.slice('archived '.length));
    expect(await archive.exportMissing(tomorrow)).toBe('archived 0');
    const rows = await withSuperuser((client) =>
      client.query(
        `select stream, day::text as day, row_count, byte_count, checksum, digest_id from sys.event_archives order by stream`,
      ),
    );
    expect(rows.rows).toHaveLength(archived);
    expect(rows.rows.map((row) => `${row.stream}:${row.day}`)).toEqual(
      expect.arrayContaining([`audit:${today}`, `security:${today}`]),
    );
    for (const row of rows.rows) {
      // The usage digest may not exist yet when its first events land between the two jobs.
      if (row.stream !== 'usage') expect(row.digest_id).not.toBeNull();
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
    const security = rows.rows.find((row) => row.stream === 'security')!;
    expect(security.row_count).toBeGreaterThan(0);
    const file = await store.getObject(archiveKey('security', today));
    expect(file.byteLength).toBe(security.byte_count);
    const lines = gunzipSync(file).toString('utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(security.row_count);
    expect(JSON.parse(lines[0])).toHaveProperty('event_type');
    const audit = rows.rows.find((row) => row.stream === 'audit')!;
    const auditLines = gunzipSync(await store.getObject(archiveKey('audit', today)))
      .toString('utf8')
      .split('\n')
      .filter(Boolean);
    expect(auditLines.length).toBe(audit.row_count);
    expect(auditLines.some((line) => JSON.parse(line).event_type === 'ticket.created')).toBe(true);

    const listed = await api().get('/v1/admin/integrity/archives').set(bearer(adminToken)).expect(200);
    expect(listed.body).toHaveLength(archived);
    expect(listed.body.map((row: { stream: string }) => row.stream)).toEqual(
      expect.arrayContaining(['audit', 'security']),
    );
    const events = await withSuperuser((client) =>
      client.query(`select count(*)::int as n from sys.security_events where event_type = 'integrity.archive.written'`),
    );
    expect(events.rows[0].n).toBe(archived);
    await api().get('/v1/admin/integrity/archives').expect(401);
  });
});
