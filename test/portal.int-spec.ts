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
 * The client portal over the real database (P2.16 cut, Security section 5
 * and the realm rule): a portal user submits, sees the public thread only
 * (never a work note, never an internal field), may cancel and confirm
 * closure but nothing else, cannot reach an internal route, and cannot
 * read another requester's ticket without the org-wide permission.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let portalToken: string;
let otherPortalToken: string;
let accountId: string;

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
    .send({ name: 'Support retainer', model: 'retainer' })
    .expect(201);
  const roles = await api().get('/v1/admin/roles?catalog=portal').set(bearer(adminToken)).expect(200);
  const requester = roles.body.find((role: { name: string }) => role.name === 'Requester');
  await api()
    .post(`/v1/admin/accounts/${accountId}/portal-users`)
    .set(bearer(adminToken))
    .send({ email: 'pat@client.test', first_name: 'Pat', last_name: 'Client', role_ids: [requester.id] })
    .expect(201);
  await api()
    .post(`/v1/admin/accounts/${accountId}/portal-users`)
    .set(bearer(adminToken))
    .send({ email: 'sam@client.test', first_name: 'Sam', last_name: 'Client', role_ids: [requester.id] })
    .expect(201);
  portalToken = await devToken({ sub: 'dev_pat', email: 'pat@client.test', org: 'acct-brk', sid: 'sess_pat' });
  otherPortalToken = await devToken({ sub: 'dev_sam', email: 'sam@client.test', org: 'acct-brk', sid: 'sess_sam' });
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('portal realm', () => {
  it('resolves the portal principal bound to exactly one account', async () => {
    const me = await api().get('/v1/portal/me').set(bearer(portalToken)).expect(200);
    expect(me.body.principal).toMatchObject({ kind: 'portal', email: 'pat@client.test' });
    expect(me.body.principal.permissions).toEqual(['portal:kb', 'portal:submit']);
    expect(me.body.account).toMatchObject({ key: 'BRK', name: 'Brookfield' });
  });

  it('refuses a portal token on every internal route with 403 and a realm event', async () => {
    await api().get('/v1/tickets').set(bearer(portalToken)).expect(403);
    await api().get('/v1/admin/me').set(bearer(portalToken)).expect(403);
    await api().get('/v1/accounts').set(bearer(portalToken)).expect(403);
    const denied = await withSuperuser((client) =>
      client.query(`select count(*)::int as n from sys.security_events where event_type = 'authz.realm.denied'`),
    );
    expect(denied.rows[0].n).toBe(3);
  });

  it('refuses an internal token on the portal routes', async () => {
    await api().get('/v1/portal/me').set(bearer(adminToken)).expect(403);
  });
});

describe('portal requests', () => {
  let key: string;

  it('submits a request as the portal user, recorded with source portal and the requester contact', async () => {
    const response = await api()
      .post('/v1/portal/tickets')
      .set(bearer(portalToken))
      .send({
        type: 'incident',
        short_description: 'Cannot open the consolidation report',
        description: 'Error 500 since this morning',
        impact: 'high',
        urgency: 'medium',
      })
      .expect(201);
    key = response.body.key;
    expect(response.body).toMatchObject({
      state: 'new',
      state_label: 'New',
      priority: 'p2',
      requester: { display_name: 'Pat Client' },
    });
    // The public projection carries no internal field.
    expect(response.body).not.toHaveProperty('assignee_id');
    expect(response.body).not.toHaveProperty('sla');
    expect(response.body).not.toHaveProperty('contract_id');
    const row = await withSuperuser((client) =>
      client.query(`select source, created_by from acct.tickets where number = $1`, [String(Number(key.slice(2)))]),
    );
    expect(row.rows[0].source).toBe('portal');
    const audit = await withSuperuser((client) =>
      client.query(`select actor_kind from acct.audit_events where event_type = 'ticket.created'`),
    );
    expect(audit.rows[0].actor_kind).toBe('portal_user');
  });

  it('lists own requests only, and another requester of the same account cannot read it', async () => {
    const mine = await api().get('/v1/portal/tickets').set(bearer(portalToken)).expect(200);
    expect(mine.body.items.map((item: { key: string }) => item.key)).toEqual([key]);
    const other = await api().get('/v1/portal/tickets').set(bearer(otherPortalToken)).expect(200);
    expect(other.body.items).toEqual([]);
    await api().get(`/v1/portal/tickets/${key}`).set(bearer(otherPortalToken)).expect(404);
  });

  it('shows the consultant reply and the state change but never the work note', async () => {
    await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(adminToken))
      .send({ version: 1, to: 'in_progress' })
      .expect(201);
    await api()
      .post(`/v1/tickets/${key}/comments`)
      .set(bearer(adminToken))
      .send({ body: 'We are on it, expect a fix within the hour' })
      .expect(201);
    await api()
      .post(`/v1/tickets/${key}/work-notes`)
      .set(bearer(adminToken))
      .send({ body: 'Root cause is the expired cert, do not tell the client yet' })
      .expect(201);
    const timeline = await api().get(`/v1/portal/tickets/${key}/timeline`).set(bearer(portalToken)).expect(200);
    const kinds = timeline.body.map((item: { kind: string }) => item.kind);
    expect(kinds).toEqual(['state_change', 'comment']);
    expect(JSON.stringify(timeline.body)).not.toContain('expired cert');
    expect(timeline.body[0]).toMatchObject({ from_state: 'new', to_state: 'in_progress' });
    const ticket = await api().get(`/v1/portal/tickets/${key}`).set(bearer(portalToken)).expect(200);
    expect(ticket.body.state_label).toBe('In progress');
  });

  it('lets the portal user comment, and the comment is a portal-sourced public comment', async () => {
    const comment = await api()
      .post(`/v1/portal/tickets/${key}/comments`)
      .set(bearer(portalToken))
      .send({ body: 'Thanks, still failing for me' })
      .expect(201);
    expect(comment.body).toMatchObject({ source: 'portal', author_kind: 'portal_user', is_first_response: false });
  });

  it('offers only cancel from In progress and refuses an internal transition', async () => {
    const allowed = await api().get(`/v1/portal/tickets/${key}/transitions`).set(bearer(portalToken)).expect(200);
    expect(allowed.body.transitions.map((transition: { to: string }) => transition.to)).toEqual(['cancelled']);
    const ticket = await api().get(`/v1/portal/tickets/${key}`).set(bearer(portalToken)).expect(200);
    const refused = await api()
      .post(`/v1/portal/tickets/${key}/transitions`)
      .set(bearer(portalToken))
      .send({ version: ticket.body.version, to: 'resolved' })
      .expect(409);
    expect(refused.body.code).toBe('invalid_transition');
  });

  it('confirms closure after the consultant resolves', async () => {
    const internal = await api().get(`/v1/tickets/${key}`).set(bearer(adminToken)).expect(200);
    await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(adminToken))
      .send({
        version: internal.body.version,
        to: 'resolved',
        resolution: {
          code: 'fixed',
          notes: 'Renewed the certificate',
          solution_candidate: true,
          time_exemption_reason: 'Logged elsewhere',
        },
      })
      .expect(201);
    const resolved = await api().get(`/v1/portal/tickets/${key}`).set(bearer(portalToken)).expect(200);
    expect(resolved.body.state).toBe('resolved');
    const closed = await api()
      .post(`/v1/portal/tickets/${key}/transitions`)
      .set(bearer(portalToken))
      .send({ version: resolved.body.version, to: 'closed' })
      .expect(201);
    expect(closed.body.state).toBe('closed');
    const audit = await withSuperuser((client) =>
      client.query(
        `select actor_kind, new_value from acct.audit_events where event_type = 'ticket.transition' order by created_at desc limit 1`,
      ),
    );
    expect(audit.rows[0]).toEqual({ actor_kind: 'portal_user', new_value: 'closed' });
  });

  it('the portal database role cannot read work notes at all', async () => {
    const db = urls();
    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString: db.portal });
    await client.connect();
    try {
      await client.query("select set_config('xms.account_id', $1, false)", [accountId]);
      await expect(client.query('select * from acct.work_notes')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('select * from acct.sla_clocks')).rejects.toMatchObject({ code: '42501' });
      await expect(
        client.query(
          "insert into acct.comments (account_id, ticket_id, author_kind, author_id, body, source) values ($1, gen_random_uuid(), 'portal_user', 'x', 'y', 'portal')",
          [accountId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
  });
});
