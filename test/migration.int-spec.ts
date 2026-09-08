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
import { sourceHash } from '../src/modules/migration/migration.service.js';
import { startStandIn, type StandIn } from '../src/tools/servicenow-stand-in.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * The migration rehearsal loop against the stand-in (P2.22.1 done-when,
 * DM-01, DM-03): a dry run maps everything and loads nothing; the real run
 * loads cases with their source dates, journal comments and one imported
 * audit event each, with no outbox rows, no SLA clocks and no
 * notifications; a second run skips every unchanged row; one changed
 * journal yields exactly one update; the reconciliation matches; sign-off
 * needs a second person and no open delta.
 */
const ADMIN_EMAIL = 'admin@example.test';
const TABLE = 'sn_customerservice_case';

let app: INestApplication;
let adminToken: string;
let secondAdminToken: string;
let accountId: string;
let standIn: StandIn;
let instanceId = '';
let batchId = '';
let caseA: Record<string, unknown>;

const FIELD_MAP = [
  { external: 'short_description', xms: 'short_description', direction: 'both' },
  { external: 'description', xms: 'description', direction: 'both' },
  { external: 'contact.email', xms: 'requester_email', direction: 'in' },
  { external: 'contact', xms: 'requester_name', direction: 'in' },
  { external: 'number', xms: 'client_reference', direction: 'in' },
  {
    external: 'impact',
    xms: 'impact',
    direction: 'in',
    transform: { kind: 'lookup', values: { '1': 'high', '2': 'medium', '3': 'low' }, fallback: 'medium' },
  },
  {
    external: 'urgency',
    xms: 'urgency',
    direction: 'in',
    transform: { kind: 'lookup', values: { '1': 'high', '2': 'medium', '3': 'low' }, fallback: 'medium' },
  },
];
const STATE_MAP = {
  incident: {
    inbound: {
      '1': 'new',
      '10': 'in_progress',
      '18': 'awaiting_client',
      '6': 'resolved',
      '3': 'closed',
      '7': 'cancelled',
    },
    outbound: {
      new: '1',
      assigned: '1',
      in_progress: '10',
      awaiting_client: '18',
      awaiting_third_party: '18',
      resolved: '6',
      closed: '3',
      cancelled: '7',
    },
    fallback: { '1': 'new', '18': 'awaiting_client' },
  },
};

beforeAll(async () => {
  await resetDatabase();
  standIn = await startStandIn({ username: 'xms.integration', password: 'stand-in', profile: 'csm' });
  const db = urls();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL_APP: db.app,
    DATABASE_URL_PORTAL: db.portal,
    DATABASE_URL_WORKER: db.worker,
    AUTH_DEV_SECRET: DEV_SECRET,
    BOOTSTRAP_ADMIN_EMAILS: `${ADMIN_EMAIL},second@example.test`,
    STORAGE_KIND: 'local',
    STORAGE_LOCAL_ROOT: mkdtempSync(join(tmpdir(), 'xms-store-')),
    MAIL_TRANSPORT: 'file',
    // The ServiceNow stand-in runs on 127.0.0.1; production never delivers to a private address.
    WEBHOOK_ALLOW_PRIVATE: 'true',
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
  secondAdminToken = await devToken({ sub: 'dev_second', email: 'second@example.test', sid: 'sess_second' });
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
  // Second administrator (invited by the first), so the four-eyes rule can be exercised.
  const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
  const administrator = roles.body.find((row: { name: string }) => row.name === 'Administrator');
  await api()
    .post('/v1/admin/users')
    .set(bearer(adminToken))
    .send({
      email: 'second@example.test',
      first_name: 'Sam',
      last_name: 'Second',
      role_ids: [administrator.id],
      account_ids: [],
    })
    .expect(201);
  // The instance with active maps, in off mode: the import does not need polling.
  const instance = await api()
    .post(`/v1/accounts/${accountId}/connectors/servicenow`)
    .set(bearer(adminToken))
    .send({
      name: 'Brookfield CSM',
      base_url: standIn.url,
      auth_kind: 'basic',
      credential: { username: 'xms.integration', password: 'stand-in' },
    })
    .expect(201);
  instanceId = instance.body.id;
  const field = await api()
    .post(`/v1/connectors/${instanceId}/field-maps`)
    .set(bearer(adminToken))
    .send({ entries: FIELD_MAP })
    .expect(201);
  await api()
    .post(`/v1/connectors/${instanceId}/field-maps/${field.body.id}/validate`)
    .set(bearer(adminToken))
    .expect(201);
  await api()
    .post(`/v1/connectors/${instanceId}/field-maps/${field.body.id}/activate`)
    .set(bearer(adminToken))
    .expect(201);
  const state = await api()
    .post(`/v1/connectors/${instanceId}/state-maps`)
    .set(bearer(adminToken))
    .send({ entries: STATE_MAP })
    .expect(201);
  await api()
    .post(`/v1/connectors/${instanceId}/state-maps/${state.body.id}/validate`)
    .set(bearer(adminToken))
    .expect(201);
  await api()
    .post(`/v1/connectors/${instanceId}/state-maps/${state.body.id}/activate`)
    .set(bearer(adminToken))
    .expect(201);
  // History: three cases opened in 2025, one closed, one in progress, one with a journal.
  const seed = (body: Record<string, unknown>, at: Date) =>
    standIn.seed(
      TABLE,
      {
        contact: { value: 'u1', display_value: 'Pat Client' },
        'contact.email': 'pat.client@brookfield.test',
        impact: '2',
        urgency: '2',
        ...body,
      },
      at,
    );
  caseA = seed(
    { short_description: 'Old consolidation issue', description: 'From last year', state: '3' },
    new Date('2025-03-10T09:00:00Z'),
  );
  standIn.addJournal(
    String(caseA.sys_id),
    'comments',
    'Is this fixed yet?',
    'client.user',
    new Date('2025-03-11T10:00:00Z'),
  );
  standIn.addJournal(
    String(caseA.sys_id),
    'work_notes',
    'Internal only',
    'hackett.user',
    new Date('2025-03-11T11:00:00Z'),
  );
  seed(
    { short_description: 'Still open report question', state: '10', impact: '1', urgency: '1' },
    new Date('2025-06-01T09:00:00Z'),
  );
  seed({ short_description: 'Missing contact', 'contact.email': '', state: '1' }, new Date('2025-07-01T09:00:00Z'));
  seed({ short_description: 'Outside the range', state: '1' }, new Date('2026-08-01T09:00:00Z'));
});

afterAll(async () => {
  await app?.close();
  await standIn?.close();
  await closePools();
});

function api() {
  return request(app.getHttpServer());
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('source hash', () => {
  it('ignores key order and whitespace', () => {
    const a = sourceHash({ record: { b: ' x ', a: 1 }, journal: [{ v: 'y' }] });
    const b = sourceHash({ record: { a: 1, b: 'x' }, journal: [{ v: 'y' }] });
    const c = sourceHash({ record: { a: 2, b: 'x' }, journal: [{ v: 'y' }] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('a dry run', () => {
  it('extracts the range, maps every row and loads nothing', async () => {
    const created = await api()
      .post('/v1/migration/batches')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        instance_id: instanceId,
        opened_from: '2025-01-01',
        opened_to: '2025-12-31',
        dry_run: true,
      })
      .expect(201);
    batchId = created.body.id;
    expect(created.body).toMatchObject({ status: 'draft', dry_run: true, object_kind: 'case' });
    const run = await api().post(`/v1/migration/batches/${batchId}/run`).set(bearer(adminToken)).expect(201);
    expect(run.body.status).toBe('reconciled');
    expect(run.body.counts).toMatchObject({ extracted: 3, loaded: 0, updated: 0, skipped: 0, unmatched: 1, errors: 0 });
    const records = await api().get(`/v1/migration/batches/${batchId}/records`).set(bearer(adminToken)).expect(200);
    expect(records.body.map((row: { status: string }) => row.status).sort()).toEqual([
      'pending',
      'pending',
      'unmatched',
    ]);
    expect(records.body.find((row: { status: string }) => row.status === 'unmatched').message).toContain(
      'requester_email',
    );
    const tickets = await withSuperuser((client) => client.query(`select count(*)::int as n from acct.tickets`));
    expect(tickets.rows[0].n).toBe(0);
    expect(run.body.report.lines.every((line: { status: string }) => line.status === 'matched')).toBe(true);
    const detail = await api()
      .get(`/v1/migration/batches/${batchId}/records/${records.body[0].id}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(detail.body.payload.record.sys_id).toBe(records.body[0].source_id);
  });
});

describe('the real run (DM-01)', () => {
  it('loads cases with their source dates, journal comments and an imported audit event; no outbox, clocks or notifications', async () => {
    const created = await api()
      .post('/v1/migration/batches')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        instance_id: instanceId,
        opened_from: '2025-01-01',
        opened_to: '2025-12-31',
        dry_run: false,
      })
      .expect(201);
    batchId = created.body.id;
    const run = await api().post(`/v1/migration/batches/${batchId}/run`).set(bearer(adminToken)).expect(201);
    expect(run.body.status).toBe('reconciled');
    expect(run.body.counts).toMatchObject({ extracted: 3, loaded: 2, updated: 0, skipped: 0, unmatched: 1, errors: 0 });
    const tickets = await withSuperuser((client) =>
      client.query(
        `select t.short_description, t.state, t.source, t.created_at, t.external_refs, t.impact from acct.tickets t order by t.created_at`,
      ),
    );
    expect(tickets.rows).toHaveLength(2);
    expect(tickets.rows[0]).toMatchObject({
      short_description: 'Old consolidation issue',
      state: 'closed',
      source: 'import',
      impact: 'medium',
    });
    expect(new Date(tickets.rows[0].created_at).toISOString()).toBe('2025-03-10T09:00:00.000Z');
    expect(tickets.rows[0].external_refs).toMatchObject({
      servicenow: caseA.number,
      source: `servicenow:${instanceId}`,
    });
    expect(tickets.rows[1]).toMatchObject({
      short_description: 'Still open report question',
      state: 'in_progress',
      impact: 'high',
    });
    const comments = await withSuperuser((client) =>
      client.query(`select body, source, author_name, created_at from acct.comments`),
    );
    expect(comments.rows).toHaveLength(1);
    expect(comments.rows[0]).toMatchObject({
      body: 'Is this fixed yet?',
      source: 'import',
      author_name: 'client.user',
    });
    expect(new Date(comments.rows[0].created_at).toISOString()).toBe('2025-03-11T10:00:00.000Z');
    const notes = await withSuperuser((client) => client.query(`select count(*)::int as n from acct.work_notes`));
    expect(notes.rows[0].n).toBe(0);
    const side = await withSuperuser((client) =>
      client.query(`select (select count(*)::int from sys.outbox) as outbox, (select count(*)::int from acct.sla_clocks) as clocks, (select count(*)::int from acct.notifications) as notifications,
                           (select count(*)::int from acct.audit_events where event_type = 'imported') as imported`),
    );
    expect(side.rows[0]).toEqual({ outbox: 0, clocks: 0, notifications: 0, imported: 2 });
    expect(run.body.report.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'count_by_state',
          subject: 'closed',
          source_figure: 1,
          target_figure: 1,
          status: 'matched',
        }),
        expect.objectContaining({
          kind: 'count_by_state',
          subject: 'in_progress',
          source_figure: 1,
          target_figure: 1,
          status: 'matched',
        }),
        expect.objectContaining({
          kind: 'count_by_object',
          subject: 'comments',
          source_figure: 1,
          target_figure: 1,
          status: 'matched',
        }),
      ]),
    );
  });

  it('a second run skips every unchanged row; one changed journal yields exactly one update', async () => {
    const again = await api()
      .post('/v1/migration/batches')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        instance_id: instanceId,
        opened_from: '2025-01-01',
        opened_to: '2025-12-31',
        dry_run: false,
      })
      .expect(201);
    const run = await api().post(`/v1/migration/batches/${again.body.id}/run`).set(bearer(adminToken)).expect(201);
    expect(run.body.counts).toMatchObject({ extracted: 3, loaded: 0, updated: 0, skipped: 2, unmatched: 1 });
    standIn.addJournal(
      String(caseA.sys_id),
      'comments',
      'Second question',
      'client.user',
      new Date('2025-03-12T10:00:00Z'),
    );
    const third = await api()
      .post('/v1/migration/batches')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        instance_id: instanceId,
        opened_from: '2025-01-01',
        opened_to: '2025-12-31',
        dry_run: false,
      })
      .expect(201);
    const rerun = await api().post(`/v1/migration/batches/${third.body.id}/run`).set(bearer(adminToken)).expect(201);
    expect(rerun.body.counts).toMatchObject({ loaded: 0, updated: 1, skipped: 1, unmatched: 1 });
    const comments = await withSuperuser((client) =>
      client.query(`select body from acct.comments order by created_at`),
    );
    expect(comments.rows.map((row) => row.body)).toEqual(['Is this fixed yet?', 'Second question']);
    const tickets = await withSuperuser((client) => client.query(`select count(*)::int as n from acct.tickets`));
    expect(tickets.rows[0].n).toBe(2);
    batchId = third.body.id;
  });
});

describe('reconciliation sign-off (DM-03)', () => {
  it('needs a second person, explanations for open deltas, and freezes the report', async () => {
    const reports = await api()
      .get(`/v1/migration/reconciliation?account_id=${accountId}&scope=batch`)
      .set(bearer(adminToken))
      .expect(200);
    const report = reports.body.find((row: { batch_id: string }) => row.batch_id === batchId);
    expect(report.status).toBe('open');
    // The runner sees the four-eyes answer up front; the batch carries the runner's name.
    expect(report).toMatchObject({ can_sign: false, sign_blocker: 'signer_ran_batch' });
    const batchView = await api().get(`/v1/migration/batches/${batchId}`).set(bearer(adminToken)).expect(200);
    expect(typeof batchView.body.run_by_name).toBe('string');
    expect(batchView.body.report).toMatchObject({ id: report.id, can_sign: false });
    const self = await api()
      .post(`/v1/migration/reconciliation/${report.id}/sign-off`)
      .set(bearer(adminToken))
      .send({ version: report.version })
      .expect(403);
    expect(self.body.code).toBe('signer_ran_batch');
    // Force an open delta, explain it, then sign as the second administrator.
    await withSuperuser((client) =>
      client.query(
        `update acct.reconciliation_reports set lines = lines || '[{"kind":"count_by_object","subject":"attachments","source_figure":2,"target_figure":0,"delta":-2,"status":"delta_open"}]'::jsonb where id = $1`,
        [report.id],
      ),
    );
    const fresh = (
      await api()
        .get(`/v1/migration/reconciliation?account_id=${accountId}&scope=batch`)
        .set(bearer(secondAdminToken))
        .expect(200)
    ).body.find((row: { id: string }) => row.id === report.id);
    const refused = await api()
      .post(`/v1/migration/reconciliation/${report.id}/sign-off`)
      .set(bearer(secondAdminToken))
      .send({ version: fresh.version })
      .expect(409);
    expect(refused.body.code).toBe('delta_open');
    const lineIndex = fresh.lines.findIndex((line: { subject: string }) => line.subject === 'attachments');
    const explained = await api()
      .post(`/v1/migration/reconciliation/${report.id}/lines/${lineIndex}/explain`)
      .set(bearer(secondAdminToken))
      .send({ explanation: 'attachments are out of scope for the rehearsal', version: fresh.version })
      .expect(201);
    expect(explained.body.lines[lineIndex].status).toBe('delta_explained');
    const signed = await api()
      .post(`/v1/migration/reconciliation/${report.id}/sign-off`)
      .set(bearer(secondAdminToken))
      .send({ version: explained.body.version })
      .expect(201);
    expect(signed.body).toMatchObject({ status: 'signed_off', signed_by: expect.any(String) });
    const batch = await api().get(`/v1/migration/batches/${batchId}`).set(bearer(adminToken)).expect(200);
    expect(batch.body.status).toBe('signed_off');
    const audit = await withSuperuser((client) =>
      client.query(
        `select event_type from acct.audit_events where event_type in ('migration.report.explained', 'migration.report.signed') order by created_at`,
      ),
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(['migration.report.explained', 'migration.report.signed']);
  });

  it('is gated on admin:migration', async () => {
    const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
    const consultant = roles.body.find((row: { name: string }) => row.name === 'Consultant');
    await api()
      .post('/v1/admin/users')
      .set(bearer(adminToken))
      .send({
        email: 'consultant@example.test',
        first_name: 'Chris',
        last_name: 'Consultant',
        role_ids: [consultant.id],
        account_ids: [accountId],
      })
      .expect(201);
    const token = await devToken({ sub: 'dev_consultant', email: 'consultant@example.test' });
    await api().get('/v1/migration/batches').set(bearer(token)).expect(403);
  });
});
