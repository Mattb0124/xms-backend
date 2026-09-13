import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { resetEnvForTests } from '../src/config/env.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * Account ownership and the team construct (TM-23). Three of the four halves
 * of the requirement: one named primary owner per account, an audited
 * handover, and teams grouping people and accounts. The fourth, ownership
 * driving default routing, waits on C-01 and is deliberately untested here
 * because it is deliberately unbuilt.
 *
 * The report-authorship half is asserted in reporting.int-spec, where a real
 * run is generated and can be checked against the account's owner.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let adminId: string;
let accountId: string;
let consultantId: string;
let consultantToken: string;

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
  const bootstrapped = await api().post('/v1/bootstrap').set(bearer(adminToken)).expect(201);
  adminId = bootstrapped.body.userId;

  const account = await api()
    .post('/v1/admin/accounts')
    .set(bearer(adminToken))
    .send({ key: 'BRK', name: 'Brookfield' })
    .expect(201);
  accountId = account.body.id;

  const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
  const consultant = roles.body.find((role: { name: string }) => role.name === 'Consultant');
  const invited = await api()
    .post('/v1/admin/users')
    .set(bearer(adminToken))
    .send({ email: 'cara@example.test', first_name: 'Cara', last_name: 'Lee', role_ids: [consultant.id] })
    .expect(201);
  consultantId = invited.body.id;
  consultantToken = await devToken({ sub: 'dev_consultant', email: 'cara@example.test', sid: 'sess_consultant' });
  // The consultant signs in once so the row is active rather than invited.
  await api().get('/v1/admin/me').set(bearer(consultantToken)).expect(200);
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = (): request.Agent => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const accountRow = (): Promise<{ owner_user_id: string | null; status: string; version: number }> =>
  withSuperuser((client) =>
    client.query(`select owner_user_id, status, version from op.accounts where id = $1`, [accountId]),
  ).then((result) => result.rows[0]);

describe('one named primary owner', () => {
  it('takes the account live and makes the administrator who did it the owner, audited', async () => {
    expect((await accountRow()).owner_user_id).toBeNull();
    await api().post(`/v1/admin/accounts/${accountId}/activate`).set(bearer(adminToken)).expect(201);

    const row = await accountRow();
    expect(row).toMatchObject({ status: 'active', owner_user_id: adminId });

    const audit = await withSuperuser((client) =>
      client.query(
        `select field, old_value, new_value from acct.audit_events
          where account_id = $1 and event_type = 'admin.account.owner_changed'`,
        [accountId],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].field).toBe('owner_user_id');
    expect(audit.rows[0].old_value).toBeNull();
    expect(audit.rows[0].new_value).toMatchObject({ user_id: adminId, reason: 'set when the account went live' });

    const security = await withSuperuser((client) =>
      client.query(
        `select attrs from sys.security_events where account_id = $1 and event_type = 'admin.account.owner_changed'`,
        [accountId],
      ),
    );
    expect(security.rows).toHaveLength(1);
    expect(security.rows[0].attrs).toMatchObject({ from: null, to: adminId, at: 'activation' });
  });

  it('refuses at the data layer to leave a live account without an owner', async () => {
    await expect(
      withSuperuser((client) => client.query(`update op.accounts set owner_user_id = null where id = $1`, [accountId])),
    ).rejects.toThrow(/ck_op_accounts_owner_when_live/);
  });

  it('will not change the owner through the general account edit', async () => {
    const current = await api().get(`/v1/admin/accounts/${accountId}`).set(bearer(adminToken)).expect(200);
    const response = await api()
      .patch(`/v1/admin/accounts/${accountId}`)
      .set(bearer(adminToken))
      .send({ version: current.body.version, owner_user_id: consultantId })
      .expect(400);
    // forbidNonWhitelisted: the field is not on the DTO any more, so the
    // only way to move ownership is the route that audits it.
    expect(JSON.stringify(response.body)).toContain('owner_user_id');
    expect((await accountRow()).owner_user_id).toBe(adminId);
  });
});

describe('handing the account on', () => {
  it('refuses somebody who cannot see the account', async () => {
    const current = await api().get(`/v1/admin/accounts/${accountId}`).set(bearer(adminToken)).expect(200);
    const response = await api()
      .put(`/v1/admin/accounts/${accountId}/owner`)
      .set(bearer(adminToken))
      .send({ version: current.body.version, owner_user_id: consultantId })
      .expect(400);
    expect(response.body.code).toBe('owner_not_granted');
  });

  it('refuses a portal identity outright', async () => {
    const portal = await api()
      .post(`/v1/admin/accounts/${accountId}/portal-users`)
      .set(bearer(adminToken))
      .send({ email: 'client@example.test', first_name: 'Pat', last_name: 'Ray' })
      .expect(201);
    const current = await api().get(`/v1/admin/accounts/${accountId}`).set(bearer(adminToken)).expect(200);
    const response = await api()
      .put(`/v1/admin/accounts/${accountId}/owner`)
      .set(bearer(adminToken))
      .send({ version: current.body.version, owner_user_id: portal.body.id })
      .expect(400);
    expect(response.body.code).toBe('owner_not_internal');
  });

  it('hands the account to a granted consultant and names both people in the record', async () => {
    await api()
      .put(`/v1/admin/users/${consultantId}/grants`)
      .set(bearer(adminToken))
      .send({ account_ids: [accountId] })
      .expect(200);
    const current = await api().get(`/v1/admin/accounts/${accountId}`).set(bearer(adminToken)).expect(200);
    const response = await api()
      .put(`/v1/admin/accounts/${accountId}/owner`)
      .set(bearer(adminToken))
      .send({ version: current.body.version, owner_user_id: consultantId, reason: 'Cara picks up Brookfield' })
      .expect(200);
    expect(response.body.owner_user_id).toBe(consultantId);

    const audit = await withSuperuser((client) =>
      client.query(
        `select old_value, new_value from acct.audit_events
          where account_id = $1 and event_type = 'admin.account.owner_changed' order by created_at desc limit 1`,
        [accountId],
      ),
    );
    expect(audit.rows[0].old_value).toMatchObject({ user_id: adminId });
    expect(audit.rows[0].new_value).toMatchObject({
      user_id: consultantId,
      name: 'Cara Lee',
      reason: 'Cara picks up Brookfield',
    });
  });

  it('answers a stale version with a typed conflict', async () => {
    const response = await api()
      .put(`/v1/admin/accounts/${accountId}/owner`)
      .set(bearer(adminToken))
      .send({ version: 1, owner_user_id: adminId })
      .expect(409);
    expect(response.body.code).toBe('stale_version');
  });

  it('is closed to a consultant', async () => {
    const current = await api().get(`/v1/admin/accounts/${accountId}`).set(bearer(adminToken)).expect(200);
    await api()
      .put(`/v1/admin/accounts/${accountId}/owner`)
      .set(bearer(consultantToken))
      .send({ version: current.body.version, owner_user_id: consultantId })
      .expect(403);
  });
});

describe('teams', () => {
  let teamId: string;

  it('creates a team with a lead and audits it', async () => {
    const response = await api()
      .post('/v1/admin/teams')
      .set(bearer(adminToken))
      .send({ name: 'OneStream Technical', description: 'Technical delivery', lead_user_id: adminId })
      .expect(201);
    teamId = response.body.id;
    expect(response.body).toMatchObject({ name: 'OneStream Technical', status: 'active', lead_user_id: adminId });

    const audit = await withSuperuser((client) =>
      client.query(`select field, new_value from op.audit_events where entity_kind = 'team' and entity_id = $1`, [
        teamId,
      ]),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].field).toBe('created');
  });

  it('refuses a duplicate name', async () => {
    const response = await api()
      .post('/v1/admin/teams')
      .set(bearer(adminToken))
      .send({ name: 'onestream technical' })
      .expect(409);
    expect(response.body.code).toBe('team_name_in_use');
  });

  it('groups people and accounts, and reads them back with the account owner', async () => {
    await api()
      .put(`/v1/admin/teams/${teamId}/members`)
      .set(bearer(adminToken))
      .send({ user_ids: [adminId, consultantId, consultantId] })
      .expect(200);
    const accounts = await api()
      .put(`/v1/admin/teams/${teamId}/accounts`)
      .set(bearer(adminToken))
      .send({ account_ids: [accountId] })
      .expect(200);
    expect(accounts.body).toEqual([
      expect.objectContaining({ account_id: accountId, key: 'BRK', owner_user_id: consultantId }),
    ]);

    const team = await api().get(`/v1/admin/teams/${teamId}`).set(bearer(adminToken)).expect(200);
    // The duplicate id in the request collapses: membership is a set.
    expect(team.body.members).toHaveLength(2);
    expect(team.body.accounts).toHaveLength(1);

    const list = await api().get('/v1/admin/teams').set(bearer(adminToken)).expect(200);
    expect(list.body[0]).toMatchObject({ member_count: 2, account_count: 1, lead_name: 'Administrator' });
  });

  it('refuses a portal user on a team and an account held by another team', async () => {
    const portal = await withSuperuser((client) =>
      client.query(`select id from op.users where kind = 'portal' limit 1`),
    );
    const refused = await api()
      .put(`/v1/admin/teams/${teamId}/members`)
      .set(bearer(adminToken))
      .send({ user_ids: [portal.rows[0].id] })
      .expect(400);
    expect(refused.body.code).toBe('not_internal_users');

    const second = await api()
      .post('/v1/admin/teams')
      .set(bearer(adminToken))
      .send({ name: 'CSM' })
      .expect(201);
    const held = await api()
      .put(`/v1/admin/teams/${second.body.id}/accounts`)
      .set(bearer(adminToken))
      .send({ account_ids: [accountId] })
      .expect(409);
    expect(held.body.code).toBe('accounts_held_by_another_team');
  });

  it('retires a team and audits the field that moved', async () => {
    const current = await api().get(`/v1/admin/teams/${teamId}`).set(bearer(adminToken)).expect(200);
    await api()
      .patch(`/v1/admin/teams/${teamId}`)
      .set(bearer(adminToken))
      .send({ version: current.body.version, status: 'retired' })
      .expect(200);
    const audit = await withSuperuser((client) =>
      client.query(
        `select field, old_value, new_value from op.audit_events
          where entity_kind = 'team' and entity_id = $1 and field = 'status'`,
        [teamId],
      ),
    );
    expect(audit.rows).toEqual([{ field: 'status', old_value: 'active', new_value: 'retired' }]);
  });

  it('is closed to a consultant', async () => {
    await api().get('/v1/admin/teams').set(bearer(consultantToken)).expect(403);
  });
});
