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
import { SnapshotJob } from '../src/modules/reporting/reporting.module.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * Dashboards, exports, audit search, security and usage tiles, the WSR
 * pack and the snapshot job over the real database (P2.19.1, P2.19.3,
 * P2.19.4, P2.11.4, P2.11.5, P2.20.1 cut; XA-03; DR-06).
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let consultantToken: string;
let portalToken: string;
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
  for (const [key, name] of [
    ['BRK', 'Brookfield'],
    ['OTH', 'Other'],
  ]) {
    const account = await api().post('/v1/admin/accounts').set(bearer(adminToken)).send({ key, name }).expect(201);
    await api().post(`/v1/admin/accounts/${account.body.id}/activate`).set(bearer(adminToken)).expect(201);
    await api()
      .post(`/v1/accounts/${account.body.id}/contracts`)
      .set(bearer(adminToken))
      .send({ name: 'Retainer', model: 'retainer', period_hours: 40 })
      .expect(201);
    if (key === 'BRK') accountId = account.body.id;
    else otherAccountId = account.body.id;
  }
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
  consultantToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });
  const portalRoles = await api().get('/v1/admin/roles?catalog=portal').set(bearer(adminToken)).expect(200);
  const requester = portalRoles.body.find((role: { name: string }) => role.name === 'Requester');
  await api()
    .post(`/v1/admin/accounts/${accountId}/portal-users`)
    .set(bearer(adminToken))
    .send({ email: 'pat@client.test', role_ids: [requester.id] })
    .expect(201);
  portalToken = await devToken({ sub: 'dev_pat', email: 'pat@client.test', org: 'acct-brk', sid: 'sess_pat' });

  // Seed: three tickets on BRK (one resolved with time, one breached), one on OTH.
  const a = await api()
    .post('/v1/tickets')
    .set(bearer(consultantToken))
    .send({
      account_id: accountId,
      type: 'incident',
      short_description: 'Cube refresh fails',
      impact: 'high',
      urgency: 'high',
    })
    .expect(201);
  await api()
    .post(`/v1/tickets/${a.body.key}/transitions`)
    .set(bearer(consultantToken))
    .send({ version: 1, to: 'in_progress' })
    .expect(201);
  await api()
    .post(`/v1/tickets/${a.body.key}/time`)
    .set(bearer(consultantToken))
    .send({ performed_on: new Date().toISOString().slice(0, 10), minutes: 90, activity_type: 'analysis' })
    .expect(201);
  await api()
    .post(`/v1/tickets/${a.body.key}/transitions`)
    .set(bearer(consultantToken))
    .send({ version: 2, to: 'resolved', resolution: { code: 'fixed', notes: 'Renewed', solution_candidate: true } })
    .expect(201);
  const b = await api()
    .post('/v1/tickets')
    .set(bearer(consultantToken))
    .send({
      account_id: accountId,
      type: 'service_request',
      short_description: 'New user access',
      impact: 'low',
      urgency: 'low',
    })
    .expect(201);
  await withSuperuser(async (client) => {
    await client.query('begin');
    await client.query("select set_config('xms.audited', 'true', true)");
    await client.query(`update acct.tickets set sla_resolution_breached = true where id = $1`, [b.body.id]);
    await client.query('commit');
  });
  await api()
    .post('/v1/tickets')
    .set(bearer(consultantToken))
    .send({
      account_id: accountId,
      type: 'incident',
      short_description: 'Report slow',
      impact: 'medium',
      urgency: 'medium',
    })
    .expect(201);
  await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({ account_id: otherAccountId, type: 'incident', short_description: 'Other account issue' })
    .expect(201);
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('dashboards', () => {
  it('operations rolls up every granted account and needs the portfolio permission', async () => {
    await api().get('/v1/dashboards/operations').set(bearer(consultantToken)).expect(403);
    const response = await api().get('/v1/dashboards/operations').set(bearer(adminToken)).expect(200);
    expect(response.body.measures).toMatchObject({
      open_tickets: 3,
      breached_now: 1,
      volume_created: 4,
      volume_resolved: 1,
      consumption_minutes: 90,
      time_logged_minutes: 90,
    });
    expect(response.body.measures.sla_resolution_attainment).toEqual({ numerator: 1, denominator: 1, value: 100 });
    expect(
      response.body.per_account.map((row: { key: string; measures: { open_tickets: number } }) => [
        row.key,
        row.measures.open_tickets,
      ]),
    ).toEqual([
      ['BRK', 2],
      ['OTH', 1],
    ]);
    expect(response.body.notable[0]).toMatchObject({ breached: true, key: expect.stringMatching(/^CS/) });
    expect(Object.keys(response.body.notable[0]).sort()).toEqual([
      'age_days',
      'breached',
      'key',
      'priority',
      'state',
      'title',
    ]);
  });

  it('account dashboard is bounded by grants and "as client" reduces to the whitelist', async () => {
    const own = await api().get(`/v1/dashboards/accounts/${accountId}`).set(bearer(consultantToken)).expect(200);
    expect(own.body.measures.open_tickets).toBe(2);
    await api().get(`/v1/dashboards/accounts/${otherAccountId}`).set(bearer(consultantToken)).expect(404);
    const client = await api()
      .get(`/v1/dashboards/accounts/${accountId}?as_client=true`)
      .set(bearer(consultantToken))
      .expect(200);
    expect(Object.keys(client.body.measures).sort()).toEqual([
      'backlog_by_age',
      'mttr_minutes',
      'open_tickets',
      'sla_resolution_attainment',
      'sla_response_attainment',
      'volume_created',
      'volume_resolved',
    ]);
    expect(client.body).not.toHaveProperty('notable');
    const portal = await api().get('/v1/portal/dashboard').set(bearer(portalToken)).expect(200);
    expect(portal.body.measures.open_tickets).toBe(2);
    expect(portal.body.measures).not.toHaveProperty('consumption_minutes');
    expect(portal.body.measures).not.toHaveProperty('unassigned_now');
  });

  it('security and usage dashboards need their permissions and answer with tiles', async () => {
    await api().get('/v1/dashboards/security').set(bearer(consultantToken)).expect(403);
    const security = await api().get('/v1/dashboards/security').set(bearer(adminToken)).expect(200);
    expect(
      security.body.by_type.some((row: { event_type: string }) => row.event_type === 'authz.permission.denied'),
    ).toBe(true);
    const { UsageEventsService } = await import('../src/modules/telemetry/telemetry.module.js');
    await app.get(UsageEventsService).flush();
    const usage = await api().get('/v1/dashboards/usage').set(bearer(adminToken)).expect(200);
    expect(usage.body).toHaveProperty('api_errors');
  });

  it('the security dashboard counts every signal from the table that records it', async () => {
    const ticketId = await withSuperuser((client) =>
      client
        .query<{ id: string }>('select id from acct.tickets where account_id = $1 limit 1', [accountId])
        .then((result) => result.rows[0].id),
    );
    const apiClient = await api()
      .post('/v1/admin/api-clients')
      .set(bearer(adminToken))
      .send({ name: 'Finance', scopes: ['exports:read'], account_ids: [accountId] })
      .expect(201);
    await withSuperuser(async (client) => {
      for (const actor of ['client-a', 'client-a', 'client-b']) {
        await client.query(
          `insert into sys.security_events (event_type, outcome, account_id, actor_kind, actor_id, principal_kind)
           values ('abuse.rate_limited', 'denied', $1, 'api_client', $2, 'api_client')`,
          [accountId, actor],
        );
      }
      await client.query(
        `insert into sys.security_events (event_type, outcome, actor_kind, actor_id)
         values ('abuse.webhook.bad_signature', 'denied', 'anonymous', 'anonymous')`,
      );
      await client.query(
        `insert into acct.webhook_subscriptions
           (account_id, api_client_id, endpoint_url, event_types, secret_ciphertext, secret_kid, status, paused_reason)
         values ($1, $2, 'https://client.test/hook', array['ticket.created'], 'ciphertext', 'k1', 'paused', 'continuous_failure')`,
        [accountId, apiClient.body.id],
      );
      await client.query(
        `insert into acct.connector_instances
           (account_id, type, name, base_url, auth_kind, credential_secret_name, kill_switch, trip_reason)
         values ($1, 'servicenow', 'Paused CSM', 'https://snow.test', 'basic', 'xms/secret', 'tripped', 'error ratio')`,
        [accountId],
      );
      await client.query(
        `insert into acct.attachments
           (account_id, ticket_id, file_name, content_type, size_bytes, s3_key, scan_state, origin, visibility, uploaded_by)
         values ($1, $2, 'payload.exe', 'application/octet-stream', 10, 'quarantine/1', 'quarantined', 'email', 'internal', 'system')`,
        [accountId, ticketId],
      );
      await client.query(
        `insert into sys.dead_letters (queue, account_id, payload, error, attempts)
         values ('outbox', $1, '{}'::jsonb, 'the endpoint refused the payload', 3)`,
        [accountId],
      );
    });

    const dashboard = await api().get('/v1/dashboards/security?days=7').set(bearer(adminToken)).expect(200);
    expect(dashboard.body.abuse_by_kind).toEqual(
      expect.arrayContaining([
        { event_type: 'abuse.rate_limited', n: 3 },
        { event_type: 'abuse.webhook.bad_signature', n: 1 },
      ]),
    );
    expect(dashboard.body.rate_limited_clients[0]).toMatchObject({
      actor_id: 'client-a',
      principal_kind: 'api_client',
      n: 2,
    });
    expect(dashboard.body.paused_integrations).toEqual(
      expect.arrayContaining([
        { kind: 'webhook', reason: 'continuous_failure', n: 1 },
        { kind: 'connector', reason: 'error ratio', n: 1 },
      ]),
    );
    expect(dashboard.body.quarantined_attachments).toEqual([{ origin: 'email', n: 1 }]);
    expect(dashboard.body.open_dead_letters[0]).toMatchObject({ queue: 'outbox', n: 1 });
    expect(new Date(dashboard.body.open_dead_letters[0].oldest).getTime()).toBeLessThanOrEqual(Date.now());
    // Denied requests come from the same stream and keep their outcome.
    expect(
      dashboard.body.by_type.some(
        (row: { event_type: string; outcome: string }) =>
          row.event_type.startsWith('authz.') && row.outcome === 'denied',
      ),
    ).toBe(true);
  });
});

describe('exports', () => {
  it('exports the queue to CSV and Excel with a data.export.produced event and neutralised formulas', async () => {
    await api()
      .post('/v1/tickets')
      .set(bearer(consultantToken))
      .send({ account_id: accountId, type: 'incident', short_description: '=HYPERLINK("http://evil")' })
      .expect(201);
    const csv = await api().get('/v1/exports/tickets?format=csv').set(bearer(consultantToken)).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['x-row-count']).toBe('4');
    expect(csv.text.split('\r\n')[0]).toBe(
      'key,account,type,state,priority,short_description,assignee,created_at,updated_at,resolved_at,response_breached,resolution_breached',
    );
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv.text).not.toContain('Other account issue');
    const filtered = await api()
      .get(
        `/v1/exports/tickets?format=csv&conditions=${encode({ conditions: [{ field: 'priority', op: 'eq', value: 'p1' }] })}`,
      )
      .set(bearer(consultantToken))
      .expect(200);
    expect(filtered.headers['x-row-count']).toBe('1');
    const xlsx = await api()
      .get('/v1/exports/tickets?format=xlsx')
      .set(bearer(consultantToken))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const events = await withSuperuser((client) =>
      client.query(
        `select attrs from sys.security_events where event_type = 'data.export.produced' order by occurred_at`,
      ),
    );
    expect(events.rows.map((row) => row.attrs.format)).toEqual(['csv', 'csv', 'xlsx']);
    expect(events.rows[0].attrs.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('audit search', () => {
  it('finds every event of one request across the three streams and exports them', async () => {
    const created = await api()
      .post('/v1/tickets')
      .set(bearer(consultantToken))
      .send({ account_id: accountId, type: 'incident', short_description: 'Traced request' })
      .expect(201);
    const requestId = created.headers['x-request-id'];
    const { UsageEventsService } = await import('../src/modules/telemetry/telemetry.module.js');
    await app.get(UsageEventsService).flush();
    const search = await api()
      .post('/v1/audit/search')
      .set(bearer(adminToken))
      .send({ conditions: [{ field: 'request_id', op: 'eq', value: requestId }] })
      .expect(201);
    const streams = new Set(search.body.items.map((row: { stream: string }) => row.stream));
    expect(streams).toEqual(new Set(['audit', 'usage']));
    expect(
      search.body.items.some(
        (row: { event_type: string; attrs: { new_value: { key: string } } }) =>
          row.event_type === 'ticket.created' && row.attrs.new_value.key === created.body.key,
      ),
    ).toBe(true);
    const denied = await api()
      .post('/v1/audit/search')
      .set(bearer(adminToken))
      .send({
        conditions: [
          { field: 'stream', op: 'eq', value: 'security' },
          { field: 'event_type', op: 'contains', value: 'denied' },
        ],
      })
      .expect(201);
    expect(denied.body.items.length).toBeGreaterThan(0);
    await api().post('/v1/audit/search').set(bearer(consultantToken)).send({ conditions: [] }).expect(403);
    const bad = await api()
      .post('/v1/audit/search')
      .set(bearer(adminToken))
      .send({ conditions: [{ field: 'attrs', op: 'eq', value: 'x' }] })
      .expect(400);
    expect(bad.body.code).toBe('invalid_conditions');
    const csv = await api()
      .post('/v1/audit/export')
      .set(bearer(adminToken))
      .send({ conditions: [{ field: 'request_id', op: 'eq', value: requestId }] })
      .expect(201);
    expect(csv.text.split('\r\n')[0]).toContain('stream,occurred_at,event_type');
    // Paging: a tiny page yields a cursor that continues without overlap.
    const first = await api()
      .post('/v1/audit/search')
      .set(bearer(adminToken))
      .send({ conditions: [], limit: 2 })
      .expect(201);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.next_cursor).toBeTruthy();
    const second = await api()
      .post('/v1/audit/search')
      .set(bearer(adminToken))
      .send({ conditions: [], limit: 2, cursor: first.body.next_cursor })
      .expect(201);
    expect(second.body.items.map((row: { id: string }) => row.id)).not.toContain(first.body.items[0].id);
  });

  it('answers from the operator audit stream and stops at the searcher’s account grants', async () => {
    // An auditor holds audit:read on one account only; the bootstrap
    // administrator binds every live account, so the two see a different
    // slice of the same streams.
    const role = await api()
      .post('/v1/admin/roles')
      .set(bearer(adminToken))
      .send({ catalog: 'operator', name: 'Auditor', permissions: ['audit:read'] })
      .expect(201);
    await api()
      .post('/v1/admin/users')
      .set(bearer(adminToken))
      .send({
        email: 'ada@example.test',
        first_name: 'Ada',
        last_name: 'Reed',
        role_ids: [role.body.id],
        account_ids: [accountId],
      })
      .expect(201);
    const auditorToken = await devToken({ sub: 'dev_ada', email: 'ada@example.test', sid: 'sess_ada' });
    const search = (token: string, body: Record<string, unknown>) =>
      api().post('/v1/audit/search').set(bearer(token)).send(body).expect(201);

    // Administering a user is audited without an account, so the search
    // has to reach op.audit_events as well as the account stream.
    const operator = await search(auditorToken, {
      conditions: [
        { field: 'stream', op: 'eq', value: 'audit' },
        { field: 'entity_kind', op: 'eq', value: 'user' },
      ],
      limit: 50,
    });
    expect(operator.body.items.length).toBeGreaterThan(0);
    expect(operator.body.items.every((row: { account_id: string | null }) => row.account_id === null)).toBe(true);
    expect(operator.body.items.every((row: { attrs: { scope?: string } }) => row.attrs.scope === 'operator')).toBe(
      true,
    );

    // The other account's rows are invisible to a grant that does not name it.
    const foreign = { field: 'account_id', op: 'eq', value: otherAccountId };
    const refused = await search(auditorToken, { conditions: [foreign], limit: 50 });
    expect(refused.body.items).toEqual([]);
    const seen = await search(adminToken, { conditions: [foreign], limit: 50 });
    expect(seen.body.items.length).toBeGreaterThan(0);

    // Its own account reads normally, and an unfiltered page never leaks
    // the other one either.
    const own = await search(auditorToken, {
      conditions: [{ field: 'account_id', op: 'eq', value: accountId }],
      limit: 50,
    });
    expect(own.body.items.length).toBeGreaterThan(0);
    const everything = await search(auditorToken, { conditions: [], limit: 500 });
    expect(everything.body.items.some((row: { account_id: string | null }) => row.account_id === otherAccountId)).toBe(
      false,
    );
    expect(everything.body.items.some((row: { account_id: string | null }) => row.account_id === accountId)).toBe(true);
  });
});

describe('report packs and snapshots', () => {
  it('generates a five-slide WSR on demand, stores it and records the run', async () => {
    await api().post(`/v1/accounts/${accountId}/reports/wsr`).set(bearer(consultantToken)).expect(403);
    const generated = await api().post(`/v1/accounts/${accountId}/reports/wsr`).set(bearer(adminToken)).expect(201);
    expect(generated.body.download).toContain('/v1/storage/download?');
    const file = await request(app.getHttpServer())
      .get(generated.body.download.replace(/^https?:\/\/[^/]+/, ''))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((file.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    expect((file.body as Buffer).length).toBeGreaterThan(10_000);
    const runs = await api().get(`/v1/accounts/${accountId}/reports`).set(bearer(consultantToken)).expect(200);
    expect(runs.body[0]).toMatchObject({ pack_type: 'wsr', status: 'ready_for_review' });
    const pack = await api()
      .get(`/v1/reports/packs/${generated.body.pack_id}`)
      .set(bearer(consultantToken))
      .expect(200);
    expect(pack.body.narrative_versions[0].text).toContain('Brookfield: week of');
    expect(pack.body.notable.every((row: Record<string, unknown>) => !('notes' in row))).toBe(true);
    await api().get(`/v1/reports/packs/${generated.body.pack_id}`).set(bearer(portalToken)).expect(403);
  });

  it('the snapshot job writes one row per measure per account per day, idempotently', async () => {
    const job = app.get(SnapshotJob);
    const first = await job.run();
    expect(first).toMatch(/^snapshots \d+$/);
    expect(Number(first.replace('snapshots ', ''))).toBeGreaterThan(20);
    expect(await job.run()).toBe('snapshots 0');
    const rows = await withSuperuser((client) =>
      client.query(
        `select measure, grain, value from rpt.daily_snapshots where account_id = $1 and measure = 'open_tickets' order by grain::text`,
        [accountId],
      ),
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    await expect(withSuperuser((client) => client.query(`delete from rpt.daily_snapshots`))).rejects.toMatchObject({
      code: '23001',
    });
  });
});
