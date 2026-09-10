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
 * Accounts & Administration over the real database (P1.3.7, P1.4.3,
 * P1.4.4, P1.4.5 done-when): bootstrap yields an administrator through the
 * documented steps only; an administrator creates an account and edits its
 * settings with audit and security events; a non-administrator gets 403;
 * inviting a user creates the row; grants change the Principal's account
 * set on the next request; removing the last administrator is refused; the
 * resolver returns the Incident machine for a new account.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let adminId: string;

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
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const asAdmin = (token = adminToken) => ({ authorization: `Bearer ${token}` });

describe('bootstrap', () => {
  it('refuses an email outside the configured list', async () => {
    const token = await devToken({ sub: 'dev_other', email: 'other@example.test' });
    await api().post('/v1/bootstrap').set(asAdmin(token)).expect(401);
  });

  it('creates the first administrator, the system roles and the configuration defaults', async () => {
    const response = await api().post('/v1/bootstrap').set(asAdmin()).expect(201);
    adminId = response.body.userId;
    expect(response.body.email).toBe(ADMIN_EMAIL);
    const roles = await withSuperuser((client) =>
      client.query(`select name, catalog from op.roles where is_system order by catalog, name`),
    );
    expect(roles.rows.map((row) => `${row.catalog}:${row.name}`)).toEqual([
      'operator:Account Owner',
      'operator:Administrator',
      'operator:Consultant',
      'operator:Dispatcher',
      'operator:Finance',
      'portal:Account Admin',
      'portal:Read Only',
      'portal:Requester',
    ]);
    const defaults = await withSuperuser((client) =>
      client.query(`select kind, scope_key from op.config_defaults where status = 'active' order by 1, 2`),
    );
    expect(defaults.rows).toHaveLength(11);
    const event = await withSuperuser((client) =>
      client.query(`select actor_id from sys.security_events where event_type = 'auth.bootstrap.completed'`),
    );
    expect(event.rows[0].actor_id).toBe(adminId);
  });

  it('cannot be replayed once an administrator exists', async () => {
    const response = await api().post('/v1/bootstrap').set(asAdmin()).expect(409);
    expect(response.body.code).toBe('already_bootstrapped');
  });
});

describe('me', () => {
  it('returns the principal with the transitive administrator permissions', async () => {
    const response = await api().get('/v1/admin/me').set(asAdmin()).expect(200);
    expect(response.body.principal).toMatchObject({ kind: 'internal', userId: adminId, email: ADMIN_EMAIL });
    expect(response.body.principal.permissions).toEqual(
      expect.arrayContaining(['admin:accounts', 'admin:users', 'tickets:view', 'time:log']),
    );
  });
});

describe('accounts', () => {
  let accountId: string;
  let consultantToken: string;
  let consultantId: string;

  it('lets an administrator create an account with its settings row and audit trail', async () => {
    const response = await api()
      .post('/v1/admin/accounts')
      .set(asAdmin())
      .send({ key: 'BRK', name: 'Brookfield' })
      .expect(201);
    accountId = response.body.id;
    expect(response.body).toMatchObject({ key: 'BRK', status: 'onboarding', isolation_tier: 'shared' });
    const audit = await withSuperuser((client) =>
      client.query(`select event_type, actor_id from acct.audit_events where account_id = $1 order by created_at`, [
        accountId,
      ]),
    );
    expect(audit.rows).toEqual([{ event_type: 'admin.account.created', actor_id: adminId }]);
    const security = await withSuperuser((client) =>
      client.query(
        `select event_type from sys.security_events where account_id = $1 and event_type = 'admin.account.created'`,
        [accountId],
      ),
    );
    expect(security.rows).toHaveLength(1);
  });

  it('rejects an unknown field and a malformed key through the global pipe', async () => {
    const response = await api()
      .post('/v1/admin/accounts')
      .set(asAdmin())
      .send({ key: 'bad key', name: 'X', hacker: true })
      .expect(400);
    expect(response.body.code).toBe('validation_failed');
  });

  it('reads and edits the settings, requiring ai:configure for the AI switch and writing the switch event', async () => {
    const before = await api().get(`/v1/admin/accounts/${accountId}/settings`).set(asAdmin()).expect(200);
    expect(before.body).toMatchObject({ ai_enabled: false, portal_enabled: false, version: 1 });
    const after = await api()
      .put(`/v1/admin/accounts/${accountId}/settings`)
      .set(asAdmin())
      .send({ version: 1, ai_enabled: true, portal_enabled: true })
      .expect(200);
    expect(after.body).toMatchObject({ ai_enabled: true, portal_enabled: true, version: 2 });
    const events = await withSuperuser((client) =>
      client.query(
        `select event_type, attrs from sys.security_events where account_id = $1 and event_type like 'admin.account.%' order by occurred_at`,
        [accountId],
      ),
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      'admin.account.created',
      'admin.account.settings_changed',
      'admin.account.ai_switch_changed',
    ]);
    expect(events.rows[1].attrs.keys.sort()).toEqual(['ai_enabled', 'portal_enabled']);
    const audit = await withSuperuser((client) =>
      client.query(
        `select field, old_value, new_value from acct.audit_events where account_id = $1 and event_type = 'admin.account.settings_changed' order by field`,
        [accountId],
      ),
    );
    expect(audit.rows).toEqual([
      { field: 'ai_enabled', old_value: false, new_value: true },
      { field: 'portal_enabled', old_value: false, new_value: true },
    ]);
  });

  it('returns 409 stale_version on a concurrent settings edit', async () => {
    const response = await api()
      .put(`/v1/admin/accounts/${accountId}/settings`)
      .set(asAdmin())
      .send({ version: 1, csat_enabled: true })
      .expect(409);
    expect(response.body.code).toBe('stale_version');
  });

  it('activates the account and refuses an invalid status transition', async () => {
    await api().post(`/v1/admin/accounts/${accountId}/activate`).set(asAdmin()).expect(201);
    const response = await api().post(`/v1/admin/accounts/${accountId}/activate`).set(asAdmin()).expect(409);
    expect(response.body.code).toBe('invalid_transition');
  });

  it('invites a consultant who gets no accounts until granted, then sees the account on the next request', async () => {
    const roles = await api().get('/v1/admin/roles?catalog=operator').set(asAdmin()).expect(200);
    const consultant = roles.body.find((role: { name: string }) => role.name === 'Consultant');
    const invited = await api()
      .post('/v1/admin/users')
      .set(asAdmin())
      .send({ email: 'Consultant@Example.test', first_name: 'Cara', last_name: 'Lee', role_ids: [consultant.id] })
      .expect(201);
    consultantId = invited.body.id;
    expect(invited.body).toMatchObject({ email: 'consultant@example.test', status: 'invited', kind: 'internal' });
    consultantToken = await devToken({
      sub: 'dev_consultant',
      email: 'consultant@example.test',
      sid: 'sess_consultant',
    });

    const first = await api().get('/v1/admin/me').set(asAdmin(consultantToken)).expect(200);
    expect(first.body.principal.accountIds).toEqual([]);
    expect(first.body.principal.permissions).toContain('tickets:resolve');
    const bound = await withSuperuser((client) =>
      client.query(`select status, clerk_user_id from op.users where id = $1`, [consultantId]),
    );
    expect(bound.rows[0]).toEqual({ status: 'active', clerk_user_id: 'dev_consultant' });

    await api()
      .put(`/v1/admin/users/${consultantId}/grants`)
      .set(asAdmin())
      .send({ account_ids: [accountId] })
      .expect(200);
    const second = await api().get('/v1/admin/me').set(asAdmin(consultantToken)).expect(200);
    expect(second.body.principal.accountIds).toEqual([accountId]);
    expect(second.body.accounts).toEqual([
      { id: accountId, key: 'BRK', name: 'Brookfield', status: 'active', owner_id: null, owner_name: null },
    ]);
  });

  it('gives a consultant 403 on the admin routes with a security event', async () => {
    await api().get('/v1/admin/accounts').set(asAdmin(consultantToken)).expect(403);
    await api()
      .put(`/v1/admin/accounts/${accountId}/settings`)
      .set(asAdmin(consultantToken))
      .send({ version: 2, csat_enabled: true })
      .expect(403);
    const denied = await withSuperuser((client) =>
      client.query(
        `select count(*)::int as n from sys.security_events where event_type = 'authz.permission.denied' and actor_id = $1`,
        [consultantId],
      ),
    );
    expect(denied.rows[0].n).toBe(2);
  });

  it('reconciles the account grantees as a whole set', async () => {
    const response = await api()
      .put(`/v1/admin/accounts/${accountId}/grants`)
      .set(asAdmin())
      .send({ user_ids: [] })
      .expect(200);
    expect(response.body).toEqual([]);
    const me = await api().get('/v1/admin/me').set(asAdmin(consultantToken)).expect(200);
    expect(me.body.principal.accountIds).toEqual([]);
  });

  it('refuses to deactivate or demote the last administrator', async () => {
    const admin = await api().get(`/v1/admin/users/${adminId}`).set(asAdmin()).expect(200);
    const deactivate = await api()
      .patch(`/v1/admin/users/${adminId}`)
      .set(asAdmin())
      .send({ version: admin.body.version, status: 'deactivated' })
      .expect(409);
    expect(deactivate.body.code).toBe('last_administrator');
    const demote = await api().put(`/v1/admin/users/${adminId}/roles`).set(asAdmin()).send({ roles: [] }).expect(409);
    expect(demote.body.code).toBe('last_administrator');
    const still = await api().get('/v1/admin/me').set(asAdmin()).expect(200);
    expect(still.body.principal.permissions).toContain('admin:users');
  });

  it('manages groups with reconciled membership of internal users only', async () => {
    const group = await api().post('/v1/admin/groups').set(asAdmin()).send({ name: 'OneStream Technical' }).expect(201);
    const members = await api()
      .put(`/v1/admin/groups/${group.body.id}/members`)
      .set(asAdmin())
      .send({ user_ids: [consultantId] })
      .expect(200);
    expect(members.body.members.map((member: { user_id: string }) => member.user_id)).toEqual([consultantId]);
    // Nobody left the group, so nothing waits to be reassigned (TM-08).
    expect(members.body.reassign).toEqual([]);
    const directory = await api().get('/v1/groups').set(asAdmin(consultantToken)).expect(200);
    expect(directory.body.map((row: { name: string }) => row.name)).toEqual(['OneStream Technical']);
  });

  it('serves the resolved configuration defaults and pins the Incident machine', async () => {
    const response = await api().get('/v1/admin/config/state_machine?scope=incident').set(asAdmin()).expect(200);
    expect(response.body.active.version).toBe(1);
    expect(response.body.active.body.initial).toBe('new');
    expect(response.body.active.body.states.map((state: { key: string }) => state.key)).toEqual([
      'new',
      'assigned',
      'in_progress',
      'awaiting_client',
      'awaiting_third_party',
      'resolved',
      'closed',
      'cancelled',
    ]);
    await api().get('/v1/admin/config/nonsense').set(asAdmin()).expect(400);
  });

  it('creates a draft version, refuses an invalid one, and activates with an audit and security event', async () => {
    const current = await api().get('/v1/admin/config/priority_matrix').set(asAdmin()).expect(200);
    const body = current.body.active.body;
    body.cells.low.low = 'p3';
    const draft = await api()
      .post('/v1/admin/config/priority_matrix/versions')
      .set(asAdmin())
      .send({ body })
      .expect(201);
    expect(draft.body).toMatchObject({ version: 2, status: 'draft' });
    await api()
      .post('/v1/admin/config/priority_matrix/versions')
      .set(asAdmin())
      .send({ body: { cells: {}, default: 'p1' } })
      .expect(400);
    const activated = await api()
      .post(`/v1/admin/config/priority_matrix/versions/${draft.body.id}/activate`)
      .set(asAdmin())
      .expect(201);
    expect(activated.body.status).toBe('active');
    const after = await api().get('/v1/admin/config/priority_matrix').set(asAdmin()).expect(200);
    expect(after.body.active.version).toBe(2);
    expect(after.body.versions.map((row: { status: string }) => row.status)).toEqual(['active', 'retired']);
    const event = await withSuperuser((client) =>
      client.query(`select attrs from sys.security_events where event_type = 'admin.config.changed'`),
    );
    expect(event.rows[0].attrs).toMatchObject({ kind: 'priority_matrix', version: 2, previousVersion: 1 });
  });
});
