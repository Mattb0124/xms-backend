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
import { EICAR } from '../src/modules/attachments/attachments.module.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * Attachments over the API with the local store (P1.6.1, P1.6.2 done-when,
 * TM-14): presign with the allowlist and the account size cap, upload
 * through the signed URL, confirm triggers the scan, downloads only for
 * clean, EICAR is quarantined within the flow, the portal sees public
 * clean attachments only, a tampered signature is refused.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let portalToken: string;
let accountId: string;
let key: string;

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
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  app.use(requestContextMiddleware);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
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
  const roles = await api().get('/v1/admin/roles?catalog=portal').set(bearer(adminToken)).expect(200);
  const requester = roles.body.find((role: { name: string }) => role.name === 'Requester');
  await api()
    .post(`/v1/admin/accounts/${accountId}/portal-users`)
    .set(bearer(adminToken))
    .send({ email: 'pat@client.test', first_name: 'Pat', last_name: 'Client', role_ids: [requester.id] })
    .expect(201);
  portalToken = await devToken({ sub: 'dev_pat', email: 'pat@client.test', org: 'acct-brk', sid: 'sess_pat' });
  const ticket = await api()
    .post('/v1/portal/tickets')
    .set(bearer(portalToken))
    .send({ type: 'incident', short_description: 'Report broken' })
    .expect(201);
  key = ticket.body.key;
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const localPath = (url: string): string => url.replace(/^https?:\/\/[^/]+/, '');

async function upload(
  token: string,
  base: string,
  fileName: string,
  contentType: string,
  body: Buffer,
  extra: Record<string, unknown> = {},
) {
  const presigned = await api()
    .post(`${base}/tickets/${key}/attachments/presign`)
    .set(bearer(token))
    .send({ file_name: fileName, content_type: contentType, size_bytes: body.length })
    .expect(201);
  expect(presigned.body.attachment.scan_state).toBe('pending');
  await request(app.getHttpServer())
    .put(localPath(presigned.body.upload.url))
    .set('content-type', contentType)
    .send(body)
    .expect(200);
  const confirmed = await api()
    .post(`${base}/tickets/${key}/attachments/${presigned.body.attachment.id}/confirm`)
    .set(bearer(token))
    .send(extra)
    .expect(201);
  return confirmed.body;
}

describe('attachments', () => {
  it('rejects a disallowed type and an oversize file with abuse events', async () => {
    const bad = await api()
      .post(`/v1/tickets/${key}/attachments/presign`)
      .set(bearer(adminToken))
      .send({ file_name: 'tool.exe', content_type: 'application/octet-stream', size_bytes: 10 })
      .expect(400);
    expect(bad.body.code).toBe('unsupported_type');
    const mismatch = await api()
      .post(`/v1/tickets/${key}/attachments/presign`)
      .set(bearer(adminToken))
      .send({ file_name: 'notes.txt', content_type: 'image/png', size_bytes: 10 })
      .expect(400);
    expect(mismatch.body.code).toBe('unsupported_type');
    const huge = await api()
      .post(`/v1/tickets/${key}/attachments/presign`)
      .set(bearer(adminToken))
      .send({ file_name: 'big.pdf', content_type: 'application/pdf', size_bytes: 30 * 1024 * 1024 })
      .expect(400);
    expect(huge.body.code).toBe('too_large');
    const events = await withSuperuser((client) =>
      client.query(`select count(*)::int as n from sys.security_events where event_type = 'abuse.upload.rejected'`),
    );
    expect(events.rows[0].n).toBe(3);
  });

  it('uploads a clean file through the signed URL, scans it on confirm and serves a download', async () => {
    const confirmed = await upload(adminToken, '/v1', 'notes.txt', 'text/plain', Buffer.from('hello'), {
      visibility: 'public',
    });
    expect(confirmed).toMatchObject({ scan_state: 'clean', visibility: 'public', size_bytes: '5' });
    const download = await api().get(`/v1/attachments/${confirmed.id}/download`).set(bearer(adminToken)).expect(200);
    const fetched = await request(app.getHttpServer()).get(localPath(download.body.url)).expect(200);
    expect(fetched.text).toBe('hello');
    expect(fetched.headers['content-disposition']).toContain('notes.txt');
    // A tampered signature is refused by the store route.
    await request(app.getHttpServer())
      .get(localPath(download.body.url).replace(/signature=[^&]+/, 'signature=forged'))
      .expect(401);
    // The signature covers the file name and the content type as well, both
    // of which are written straight into the response headers, so a holder
    // of a valid link cannot flip the type to text/html (finding 34).
    await request(app.getHttpServer())
      .get(localPath(download.body.url).replace(/contentType=[^&]*/, 'contentType=text%2Fhtml'))
      .expect(401);
    await request(app.getHttpServer())
      .get(localPath(download.body.url).replace(/fileName=[^&]*/, 'fileName=other.txt'))
      .expect(401);
  });

  it('quarantines EICAR on confirm and refuses its download', async () => {
    const confirmed = await upload(adminToken, '/v1', 'eicar.txt', 'text/plain', Buffer.from(EICAR));
    expect(confirmed.scan_state).toBe('quarantined');
    const refused = await api().get(`/v1/attachments/${confirmed.id}/download`).set(bearer(adminToken)).expect(403);
    expect(refused.body.code).toBe('quarantined');
    const notifications = await withSuperuser((client) =>
      client.query(`select type from acct.notifications where type = 'attachment.quarantined'`),
    );
    expect(notifications.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('the portal uploads public attachments and sees only clean public ones', async () => {
    const confirmed = await upload(portalToken, '/v1/portal', 'screen.png', 'image/png', Buffer.from('PNG'));
    expect(confirmed).toMatchObject({ origin: 'portal', visibility: 'public', scan_state: 'clean' });
    await upload(adminToken, '/v1', 'internal.txt', 'text/plain', Buffer.from('internal'));
    const portalList = await api().get(`/v1/portal/tickets/${key}/attachments`).set(bearer(portalToken)).expect(200);
    expect(portalList.body.map((row: { file_name: string }) => row.file_name).sort()).toEqual([
      'notes.txt',
      'screen.png',
    ]);
    const internalList = await api().get(`/v1/tickets/${key}/attachments`).set(bearer(adminToken)).expect(200);
    expect(internalList.body).toHaveLength(4);
    const internal = internalList.body.find((row: { file_name: string }) => row.file_name === 'internal.txt');
    await api().get(`/v1/portal/attachments/${internal.id}/download`).set(bearer(portalToken)).expect(404);
    await api().get(`/v1/portal/attachments/${confirmed.id}/download`).set(bearer(portalToken)).expect(200);
    const refusedUpload = await api()
      .post(`/v1/tickets/${key}/attachments/presign`)
      .set(bearer(portalToken))
      .send({ file_name: 'x.txt', content_type: 'text/plain', size_bytes: 1 })
      .expect(403);
    expect(refusedUpload.body.code).toBe('wrong_realm');
  });

  it('soft deletes and hides the row', async () => {
    const list = await api().get(`/v1/tickets/${key}/attachments`).set(bearer(adminToken)).expect(200);
    const target = list.body.find((row: { file_name: string }) => row.file_name === 'internal.txt');
    await api().delete(`/v1/attachments/${target.id}`).set(bearer(adminToken)).expect(204);
    await api().get(`/v1/attachments/${target.id}/download`).set(bearer(adminToken)).expect(404);
  });
});
