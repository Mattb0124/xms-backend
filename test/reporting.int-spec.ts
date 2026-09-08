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
import { extractPdfText, pdfPageCount } from '../src/domain/reporting/pdf.js';
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

/** Follows a presigned link back at the API's own signed download route and returns the bytes. */
async function download(link: string): Promise<Buffer> {
  const response = await request(app.getHttpServer())
    .get(link.replace(/^https?:\/\/[^/]+/, ''))
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    })
    .expect(200);
  return response.body as Buffer;
}
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
    let subscriptionId = '';
    let instanceId = '';
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
      subscriptionId = (
        await client.query<{ id: string }>(
          `insert into acct.webhook_subscriptions
             (account_id, api_client_id, endpoint_url, event_types, secret_ciphertext, secret_kid, status, paused_reason)
           values ($1, $2, 'https://client.test/hook', array['ticket.created'], 'ciphertext', 'k1', 'paused', 'continuous_failure')
           returning id`,
          [accountId, apiClient.body.id],
        )
      ).rows[0].id;
      instanceId = (
        await client.query<{ id: string }>(
          `insert into acct.connector_instances
             (account_id, type, name, base_url, auth_kind, credential_secret_name, kill_switch, trip_reason)
           values ($1, 'servicenow', 'Paused CSM', 'https://snow.test', 'basic', 'xms/secret', 'tripped', 'error ratio')
           returning id`,
          [accountId],
        )
      ).rows[0].id;
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
      // A connector queue names the instance in its payload, which is what
      // lets the dashboard row link to the instance rather than the queue.
      await client.query(
        `insert into sys.dead_letters (queue, account_id, payload, error, attempts)
         values ('outbound', $1, jsonb_build_object('instance_id', $2::text, 'outbound_id', gen_random_uuid()::text), 'the instance refused the update', 5)`,
        [accountId, instanceId],
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
    // Each paused row names the record it stands for, so the screen can
    // link to it rather than describing it.
    expect(dashboard.body.paused_integrations).toEqual(
      expect.arrayContaining([
        {
          kind: 'connector_instance',
          id: instanceId,
          account_id: accountId,
          account_key: 'BRK',
          name: 'Paused CSM',
          reason: 'error ratio',
        },
        {
          kind: 'webhook_subscription',
          id: subscriptionId,
          account_id: accountId,
          account_key: 'BRK',
          name: 'https://client.test/hook',
          reason: 'continuous_failure',
        },
      ]),
    );
    // The counts the tile reads are still there, beside the list.
    expect(dashboard.body.paused_integrations_by_reason).toEqual(
      expect.arrayContaining([
        { kind: 'webhook_subscription', reason: 'continuous_failure', n: 1 },
        { kind: 'connector_instance', reason: 'error ratio', n: 1 },
      ]),
    );
    expect(dashboard.body.quarantined_attachments).toEqual([{ origin: 'email', n: 1 }]);
    // A platform queue names its account and no instance; a connector
    // queue names both, from the instance id its payload carries.
    const letters = dashboard.body.open_dead_letters as {
      queue: string;
      n: number;
      oldest: string;
      account_id: string | null;
      instance_id: string | null;
      instance_name: string | null;
    }[];
    expect(letters).toEqual(
      expect.arrayContaining([
        {
          queue: 'outbox',
          n: 1,
          oldest: expect.any(String),
          account_id: accountId,
          instance_id: null,
          instance_name: null,
        },
        {
          queue: 'outbound',
          n: 1,
          oldest: expect.any(String),
          account_id: accountId,
          instance_id: instanceId,
          instance_name: 'Paused CSM',
        },
      ]),
    );
    expect(new Date(letters[0].oldest).getTime()).toBeLessThanOrEqual(Date.now());
    expect(dashboard.body.open_dead_letters_by_queue).toEqual(
      expect.arrayContaining([
        { queue: 'outbox', n: 1, oldest: expect.any(String) },
        { queue: 'outbound', n: 1, oldest: expect.any(String) },
      ]),
    );
    // Denied requests come from the same stream and keep their outcome.
    expect(
      dashboard.body.by_type.some(
        (row: { event_type: string; outcome: string }) =>
          row.event_type.startsWith('authz.') && row.outcome === 'denied',
      ),
    ).toBe(true);
  });

  it('the usage dashboard reads the window one account at a time', async () => {
    await withSuperuser(async (client) => {
      for (const actor of ['finance-client', 'finance-client', 'billing-client']) {
        await client.query(
          `insert into rpt.usage_events (event_type, account_id, actor_kind, actor_id, principal_kind, attrs)
           values ('api.request', $1, 'api_client', $2, 'api_client', '{"route": "GET /v1/tickets", "status": 200}'::jsonb)`,
          [accountId, actor],
        );
      }
      for (const actor of ['user-a', 'user-b', 'user-b']) {
        await client.query(
          `insert into rpt.usage_events (event_type, account_id, actor_kind, actor_id, principal_kind, attrs)
           values ('screen.view', $1, 'user', $2, 'internal', '{"screen": "queue"}'::jsonb)`,
          [accountId, actor],
        );
      }
    });
    const { UsageEventsService } = await import('../src/modules/telemetry/telemetry.module.js');
    await app.get(UsageEventsService).flush();

    const usage = await api().get('/v1/dashboards/usage?days=7').set(bearer(adminToken)).expect(200);
    const perAccount: Record<string, Record<string, number>> = Object.fromEntries(
      usage.body.per_account.map((row: { key: string }) => [row.key, row]),
    );
    expect(Object.keys(perAccount).sort()).toEqual(['BRK', 'OTH']);
    // Three tickets were opened on Brookfield and one resolved, none closed;
    // the ninety minutes are the only time logged anywhere.
    expect(perAccount.BRK).toMatchObject({
      name: 'Brookfield',
      tickets_created: 3,
      tickets_closed: 0,
      minutes_logged: 90,
      api_calls: 3,
      active_users: 2,
    });
    // The portal user signed in once to read its dashboard, and that
    // sign-in belongs to its account.
    expect(perAccount.BRK.portal_signins).toBeGreaterThanOrEqual(1);
    expect(perAccount.OTH).toMatchObject({
      name: 'Other',
      tickets_created: 1,
      tickets_closed: 0,
      minutes_logged: 0,
      portal_signins: 0,
      api_calls: 0,
      active_users: 0,
    });
    // A consultant reads usage on nothing: the route stands on analytics:read.
    await api().get('/v1/dashboards/usage').set(bearer(consultantToken)).expect(403);
  });

  it('the integrity panel names the chain, the archive, the streams and the retention policy', async () => {
    const { ArchiveService, DigestService, dayOf } = await import('../src/modules/integrity/integrity.module.js');
    const digests = app.get(DigestService);
    const archives = app.get(ArchiveService);
    // A closed day: the chain attests days that have stopped receiving
    // events, so the day under test is yesterday and its rows are seeded.
    const day = dayOf(new Date(Date.now() - 86_400_000));
    await withSuperuser(async (client) => {
      for (const outcome of ['success', 'denied']) {
        await client.query(
          `insert into sys.security_events (occurred_at, event_type, outcome, actor_kind, actor_id)
           values (now() - interval '1 day', 'auth.signin.failed', $1, 'anonymous', 'anonymous')`,
          [outcome],
        );
      }
    });
    const written = await digests.write('security', day, 'test');
    expect(written.row_count).toBeGreaterThanOrEqual(2);
    await digests.verify('security', day, 'test');
    const archived = await archives.export('security', day, 'test');

    const panel = await api().get('/v1/dashboards/security/integrity').set(bearer(adminToken)).expect(200);
    const chain = panel.body.chain.streams.find((row: { stream: string }) => row.stream === 'security');
    expect(chain).toMatchObject({
      last_day: day,
      row_count: written.row_count,
      digest: written.digest,
      last_verification_matched: true,
    });
    expect(chain.last_verified_at).toBeTruthy();
    expect(panel.body.chain.last_mismatch_at).toBeNull();

    const archive = panel.body.archive.streams.find((row: { stream: string }) => row.stream === 'security');
    expect(archive).toMatchObject({ last_day: day, days: 1, rows: archived.row_count });
    expect(archive.bytes).toBeGreaterThan(0);

    // The streams are counted through rpt.events_v under the same grant
    // clause the audit search applies, so the panel counts what this reader
    // could open in the search.
    const streams = Object.fromEntries(
      panel.body.streams.map((row: { stream: string }) => [row.stream, row]),
    ) as Record<string, { n: number; oldest: string; newest: string }>;
    expect(Object.keys(streams).sort()).toEqual(['audit', 'security', 'usage']);
    expect(streams.security.n).toBeGreaterThan(0);
    expect(new Date(streams.security.oldest).getTime()).toBeLessThanOrEqual(
      new Date(streams.security.newest).getTime(),
    );

    // The retention line is the specification's policy, said to be a policy.
    expect(panel.body.retention).toEqual({
      security_months: 24,
      usage_months: 13,
      audit: 'life of the account plus contractual retention',
      source: 'Audit & Analytics section 6',
      detach_job_built: false,
    });
    await api().get('/v1/dashboards/security/integrity').set(bearer(consultantToken)).expect(403);
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

  it('the null tests express the Portfolio-wide filter and its complement', async () => {
    const search = (body: Record<string, unknown>) =>
      api().post('/v1/audit/search').set(bearer(adminToken)).send(body).expect(201);

    // Portfolio-wide: the rows that belong to no client. In the audit
    // stream those are exactly the operator rows, which is what the screen
    // labels Portfolio.
    const portfolio = await search({
      conditions: [
        { field: 'stream', op: 'eq', value: 'audit' },
        { field: 'account_id', op: 'is_null' },
      ],
      limit: 200,
    });
    expect(portfolio.body.items.length).toBeGreaterThan(0);
    expect(portfolio.body.items.every((row: { account_id: string | null }) => row.account_id === null)).toBe(true);
    expect(portfolio.body.items.every((row: { attrs: { scope?: string } }) => row.attrs.scope === 'operator')).toBe(
      true,
    );

    // Its complement excludes them and names an account on every row.
    const clients = await search({
      conditions: [
        { field: 'stream', op: 'eq', value: 'audit' },
        { field: 'account_id', op: 'is_not_null' },
      ],
      limit: 200,
    });
    expect(clients.body.items.length).toBeGreaterThan(0);
    expect(clients.body.items.every((row: { account_id: string | null }) => row.account_id !== null)).toBe(true);
    expect(clients.body.items.some((row: { attrs: { scope?: string } }) => row.attrs.scope === 'operator')).toBe(false);
    const portfolioIds = new Set(portfolio.body.items.map((row: { id: string }) => row.id));
    expect(clients.body.items.some((row: { id: string }) => portfolioIds.has(row.id))).toBe(false);

    // A null test on a column every branch of the view writes is refused,
    // and so is one that carries a value.
    const notNullable = await api()
      .post('/v1/audit/search')
      .set(bearer(adminToken))
      .send({ conditions: [{ field: 'stream', op: 'is_null' }] })
      .expect(400);
    expect(notNullable.body).toMatchObject({
      code: 'invalid_conditions',
      problems: ['condition 0: is_null needs a nullable field'],
    });
    const withValue = await api()
      .post('/v1/audit/search')
      .set(bearer(adminToken))
      .send({ conditions: [{ field: 'account_id', op: 'is_null', value: accountId }] })
      .expect(400);
    expect(withValue.body.problems).toEqual(['condition 0: is_null takes no value']);
  });
});

describe('audit saved queries', () => {
  /** An auditor holding audit:read and nothing more, to read someone else's saved queries with. */
  async function auditor(): Promise<string> {
    const role = await api()
      .post('/v1/admin/roles')
      .set(bearer(adminToken))
      .send({ catalog: 'operator', name: 'Query Auditor', permissions: ['audit:read'] })
      .expect(201);
    await api()
      .post('/v1/admin/users')
      .set(bearer(adminToken))
      .send({
        email: 'quinn@example.test',
        first_name: 'Quinn',
        last_name: 'Marsh',
        role_ids: [role.body.id],
        account_ids: [accountId],
      })
      .expect(201);
    return devToken({ sub: 'dev_quinn', email: 'quinn@example.test', sid: 'sess_quinn' });
  }

  it('saves a condition set, lists it and runs it into the same rows as the inline search', async () => {
    const conditions = [
      { field: 'stream', op: 'eq', value: 'audit' },
      { field: 'account_id', op: 'eq', value: accountId },
    ];
    const saved = await api()
      .post('/v1/audit/saved-queries')
      .set(bearer(adminToken))
      .send({ name: 'Brookfield changes', description: 'Everything audited on Brookfield', conditions })
      .expect(201);
    expect(saved.body).toMatchObject({
      name: 'Brookfield changes',
      shared: false,
      description: 'Everything audited on Brookfield',
    });
    expect(saved.body.conditions).toEqual(conditions);

    const list = await api().get('/v1/audit/saved-queries').set(bearer(adminToken)).expect(200);
    expect(list.body.map((row: { name: string }) => row.name)).toContain('Brookfield changes');

    // The run route and the inline search are one code path, so the rows match.
    const run = await api()
      .post(`/v1/audit/saved-queries/${saved.body.id}/run`)
      .set(bearer(adminToken))
      .send({ limit: 25 })
      .expect(201);
    const inline = await api()
      .post('/v1/audit/search')
      .set(bearer(adminToken))
      .send({ conditions, limit: 25 })
      .expect(201);
    expect(run.body.items.map((row: { id: string }) => row.id)).toEqual(
      inline.body.items.map((row: { id: string }) => row.id),
    );
    expect(run.body.items.length).toBeGreaterThan(0);
    expect(run.body.saved_query.name).toBe('Brookfield changes');

    // The save is audited without an account, like every operator record.
    const audited = await withSuperuser((client) =>
      client.query(`select event_type, entity_id from op.audit_events where entity_kind = 'audit_saved_query'`),
    );
    expect(audited.rows.some((row) => row.event_type === 'created' && row.entity_id === saved.body.id)).toBe(true);
  });

  it('refuses at save a condition the search would refuse at run time', async () => {
    const bad = await api()
      .post('/v1/audit/saved-queries')
      .set(bearer(adminToken))
      .send({ name: 'Impossible', conditions: [{ field: 'stream', op: 'is_null' }] })
      .expect(400);
    expect(bad.body).toMatchObject({
      code: 'invalid_conditions',
      problems: ['condition 0: is_null needs a nullable field'],
    });
    const unknownField = await api()
      .post('/v1/audit/saved-queries')
      .set(bearer(adminToken))
      .send({ name: 'Impossible', conditions: [{ field: 'attrs', op: 'eq', value: 'x' }] })
      .expect(400);
    expect(unknownField.body.code).toBe('invalid_conditions');
    expect(
      (await api().get('/v1/audit/saved-queries').set(bearer(adminToken)).expect(200)).body.some(
        (row: { name: string }) => row.name === 'Impossible',
      ),
    ).toBe(false);

    // The same judge on the way in through an edit.
    const saved = await api()
      .post('/v1/audit/saved-queries')
      .set(bearer(adminToken))
      .send({ name: 'Editable', conditions: [{ field: 'stream', op: 'eq', value: 'security' }] })
      .expect(201);
    await api()
      .patch(`/v1/audit/saved-queries/${saved.body.id}`)
      .set(bearer(adminToken))
      .send({ conditions: [{ field: 'occurred_at', op: 'is_null' }] })
      .expect(400);
    const unchanged = await api().get(`/v1/audit/saved-queries/${saved.body.id}`).set(bearer(adminToken)).expect(200);
    expect(unchanged.body.conditions).toEqual([{ field: 'stream', op: 'eq', value: 'security' }]);
    await api().delete(`/v1/audit/saved-queries/${saved.body.id}`).set(bearer(adminToken)).expect(200);
    await api().get(`/v1/audit/saved-queries/${saved.body.id}`).set(bearer(adminToken)).expect(404);
  });

  it('keeps a private query to its owner and needs audit:export to share one', async () => {
    const quinnToken = await auditor();
    const privateQuery = await api()
      .post('/v1/audit/saved-queries')
      .set(bearer(adminToken))
      .send({ name: 'My own denials', conditions: [{ field: 'outcome', op: 'eq', value: 'denied' }] })
      .expect(201);
    const sharedQuery = await api()
      .post('/v1/audit/saved-queries')
      .set(bearer(adminToken))
      .send({
        name: 'Every sign-in failure',
        shared: true,
        conditions: [{ field: 'stream', op: 'eq', value: 'security' }],
      })
      .expect(201);
    expect(sharedQuery.body.shared).toBe(true);

    const theirs = await api().get('/v1/audit/saved-queries').set(bearer(quinnToken)).expect(200);
    const names = theirs.body.map((row: { name: string }) => row.name);
    expect(names).toContain('Every sign-in failure');
    expect(names).not.toContain('My own denials');
    // A private query of someone else is invisible rather than forbidden.
    await api().get(`/v1/audit/saved-queries/${privateQuery.body.id}`).set(bearer(quinnToken)).expect(404);
    await api()
      .post(`/v1/audit/saved-queries/${privateQuery.body.id}/run`)
      .set(bearer(quinnToken))
      .send({})
      .expect(404);
    // The shared one runs, under the reader's own grants.
    const ran = await api()
      .post(`/v1/audit/saved-queries/${sharedQuery.body.id}/run`)
      .set(bearer(quinnToken))
      .send({ limit: 10 })
      .expect(201);
    expect(ran.body.items.every((row: { account_id: string | null }) => row.account_id !== otherAccountId)).toBe(true);
    // Editing and deleting are the owner's alone.
    await api()
      .patch(`/v1/audit/saved-queries/${sharedQuery.body.id}`)
      .set(bearer(quinnToken))
      .send({ name: 'Renamed by a reader' })
      .expect(404);
    await api().delete(`/v1/audit/saved-queries/${sharedQuery.body.id}`).set(bearer(quinnToken)).expect(404);
    // Sharing puts audit rows in front of other people, so it takes audit:export.
    const refused = await api()
      .post('/v1/audit/saved-queries')
      .set(bearer(quinnToken))
      .send({ name: 'Mine, shared', shared: true, conditions: [] })
      .expect(403);
    expect(refused.body).toMatchObject({ code: 'forbidden', permission: 'audit:export' });
    await api()
      .post('/v1/audit/saved-queries')
      .set(bearer(quinnToken))
      .send({ name: 'Mine, private', conditions: [] })
      .expect(201);
    // A consultant reads no saved queries: the routes stand on audit:read.
    await api().get('/v1/audit/saved-queries').set(bearer(consultantToken)).expect(403);
  });
});

describe('report packs and snapshots', () => {
  it('generates a five-slide WSR on demand, stores both renditions and records the run', async () => {
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
    // Both renditions are stored under the run, and the download route answers either.
    expect(pack.body).toMatchObject({ format: 'pptx' });
    expect(pack.body.pptx_key).toMatch(/.pptx$/);
    expect(pack.body.pdf_key).toMatch(/.pdf$/);
    const asPdf = await api()
      .get(`/v1/reports/packs/${generated.body.pack_id}?format=pdf`)
      .set(bearer(consultantToken))
      .expect(200);
    expect(asPdf.body.format).toBe('pdf');
    expect(asPdf.body.download).not.toBe(pack.body.download);
    const rendered = await download(asPdf.body.download);
    expect(rendered.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdfPageCount(rendered)).toBe(5);
    const text = extractPdfText(rendered);
    for (const title of ['Weekly status report', 'Headline', 'Service levels', 'Consumption'])
      expect(text).toContain(title);
    expect(text).toContain('Brookfield');
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
