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
 * The configuration item register (TM-19; Knowledge Base functional 5.8,
 * technical 2.6). The table has existed since migration 0007; what is under
 * test is the register's own routes, the picker search behind them, and the
 * check that a configuration item named on a ticket belongs to that
 * ticket's account.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let caraToken: string;
let accountId: string;
let otherAccountId: string;

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
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

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

async function newItem(body: Record<string, unknown>, account = accountId): Promise<Record<string, never>> {
  const created = await api()
    .post(`/v1/accounts/${account}/configuration-items`)
    .set(bearer(adminToken))
    .send(body)
    .expect(201);
  return created.body;
}

describe('the configuration item register', () => {
  it('creates, reads, renames, retires and deletes an item', async () => {
    const created = (await newItem({
      ci_type: 'application',
      name: 'OneStream consolidation app',
      attributes: { version: '8.2', tier: 'production' },
      external_ref: 'sys_id_1234',
    })) as unknown as { id: string; version: number; status: string; attributes: Record<string, unknown> };
    expect(created.status).toBe('active');
    expect(created.attributes).toEqual({ version: '8.2', tier: 'production' });

    const record = await api().get(`/v1/configuration-items/${created.id}`).set(bearer(adminToken)).expect(200);
    expect(record.body.name).toBe('OneStream consolidation app');
    expect(record.body.tickets).toEqual([]);

    const renamed = await api()
      .patch(`/v1/configuration-items/${created.id}`)
      .set(bearer(adminToken))
      .send({ version: created.version, name: 'OneStream consolidation', attributes: { version: '8.3' } })
      .expect(200);
    expect(renamed.body.name).toBe('OneStream consolidation');
    expect(renamed.body.attributes).toEqual({ version: '8.3' });
    expect(renamed.body.version).toBe(created.version + 1);

    const stale = await api()
      .patch(`/v1/configuration-items/${created.id}`)
      .set(bearer(adminToken))
      .send({ version: created.version, name: 'Too late' })
      .expect(409);
    expect(stale.body.code).toBe('stale_version');

    const retired = await api()
      .patch(`/v1/configuration-items/${created.id}`)
      .set(bearer(adminToken))
      .send({ version: renamed.body.version, status: 'retired' })
      .expect(200);
    expect(retired.body.status).toBe('retired');

    const audit = await withSuperuser((client) =>
      client.query(
        `select event_type from acct.audit_events where entity_kind = 'configuration_item' and entity_id = $1 order by created_at`,
        [created.id],
      ),
    );
    expect(audit.rows.map((row: { event_type: string }) => row.event_type)).toEqual(['created', 'updated', 'updated']);

    await api().delete(`/v1/configuration-items/${created.id}`).set(bearer(adminToken)).expect(204);
    await api().get(`/v1/configuration-items/${created.id}`).set(bearer(adminToken)).expect(404);
  });

  it('searches by name for the picker, active items first', async () => {
    await newItem({ ci_type: 'server', name: 'BRK-APP-01' });
    await newItem({ ci_type: 'server', name: 'BRK-APP-02', status: 'retired' });
    await newItem({ ci_type: 'environment', name: 'Production estate' });

    const matched = await api()
      .get(`/v1/accounts/${accountId}/configuration-items?q=brk-app`)
      .set(bearer(caraToken))
      .expect(200);
    expect(matched.body.map((item: { name: string }) => item.name)).toEqual(['BRK-APP-01', 'BRK-APP-02']);

    const servers = await api()
      .get(`/v1/accounts/${accountId}/configuration-items?ci_type=server&status=active`)
      .set(bearer(caraToken))
      .expect(200);
    expect(servers.body.map((item: { name: string }) => item.name)).toEqual(['BRK-APP-01']);

    const nothing = await api()
      .get(`/v1/accounts/${accountId}/configuration-items?q=nothing-like-this`)
      .set(bearer(caraToken))
      .expect(200);
    expect(nothing.body).toEqual([]);
  });

  it('refuses a configuration item of another account on create and on patch, and keeps the register apart', async () => {
    const mine = (await newItem({ ci_type: 'integration', name: 'SAP inbound feed' })) as unknown as { id: string };
    const theirs = (await newItem({ ci_type: 'integration', name: 'Acme feed' }, otherAccountId)) as unknown as {
      id: string;
    };

    const refusedOnCreate = await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        type: 'incident',
        short_description: 'Feed failed overnight',
        configuration_item_id: theirs.id,
      })
      .expect(404);
    expect(refusedOnCreate.body).toMatchObject({ code: 'not_found', entity: 'configuration_item' });

    const ticket = await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        type: 'incident',
        short_description: 'Feed failed overnight',
        configuration_item_id: mine.id,
      })
      .expect(201);
    expect(ticket.body.configuration_item_id).toBe(mine.id);

    const refusedOnPatch = await api()
      .patch(`/v1/tickets/${ticket.body.key}`)
      .set(bearer(adminToken))
      .send({ version: ticket.body.version, configuration_item_id: theirs.id })
      .expect(404);
    expect(refusedOnPatch.body).toMatchObject({ code: 'not_found', entity: 'configuration_item' });

    const unchanged = await api().get(`/v1/tickets/${ticket.body.key}`).set(bearer(adminToken)).expect(200);
    expect(unchanged.body.configuration_item_id).toBe(mine.id);

    // Cara is granted Brookfield only: the other account's register is not hers to read.
    await api().get(`/v1/accounts/${otherAccountId}/configuration-items`).set(bearer(caraToken)).expect(404);
    await api().get(`/v1/configuration-items/${theirs.id}`).set(bearer(caraToken)).expect(404);

    // The item's record lists the ticket that names it, and it cannot be deleted while it does.
    const record = await api().get(`/v1/configuration-items/${mine.id}`).set(bearer(adminToken)).expect(200);
    expect(record.body.tickets.map((row: { key: string }) => row.key)).toEqual([ticket.body.key]);
    const inUse = await api().delete(`/v1/configuration-items/${mine.id}`).set(bearer(adminToken)).expect(409);
    expect(inUse.body).toMatchObject({ code: 'configuration_item_in_use', tickets: 1 });
  });

  it('keeps writing behind admin:config while reading stays with tickets:view', async () => {
    const refused = await api()
      .post(`/v1/accounts/${accountId}/configuration-items`)
      .set(bearer(caraToken))
      .send({ ci_type: 'report', name: 'Cara should not write this' })
      .expect(403);
    expect(refused.body.code).toBe('forbidden');

    const readable = await api()
      .get(`/v1/accounts/${accountId}/configuration-items`)
      .set(bearer(caraToken))
      .expect(200);
    expect(readable.body.length).toBeGreaterThan(0);
  });
});
