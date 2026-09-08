import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { RecordingTransport } from '../src/common/mail/mail-transport.js';
import { MAIL_TRANSPORT } from '../src/common/storage/storage.module.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { resetEnvForTests } from '../src/config/env.js';
import { hashToken } from '../src/domain/portal/csat.js';
import { CsatService } from '../src/modules/portal/csat.module.js';
import type { OutboxRow } from '../src/worker/outbox-dispatcher.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * CSAT on ticket close (CP-07 cut): the close event earns the requester
 * one survey unless suppressed, the portal user sees and answers their
 * own survey once, the email link answers with the one-time token and
 * nothing else, a low score reaches the account's contract managers, the
 * reminder and expiry tick moves the rest, and the operator reads the
 * scores per account.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let worker: INestApplication;
let mail: RecordingTransport;
let adminToken: string;
let portalToken: string;
let otherPortalToken: string;
let accountId: string;
let csat: CsatService;
let ticketId: string;
let fastTicketId: string;

/** Closes a ticket straight in the database (the close discipline is the ticket service's; the survey only needs the facts). */
async function closeDirectly(id: string, minutesOpen: number): Promise<void> {
  await withSuperuser(async (client) => {
    await client.query('set session_replication_role = replica');
    await client.query(
      `update acct.tickets set state = 'closed', created_at = now() - ($2 || ' minutes')::interval, resolved_at = now(), closed_at = now(), resolution_code = 'fixed' where id = $1`,
      [id, String(minutesOpen)],
    );
    await client.query('set session_replication_role = default');
  });
}

function closeEvent(id: string): OutboxRow {
  return {
    id: '1',
    account_id: accountId,
    aggregate: 'ticket',
    aggregate_id: id,
    event_type: 'ticket.transitioned',
    payload: { from: 'resolved', to: 'closed' },
    correlation_id: `test:${id}`,
    origin: 'user',
    created_at: new Date().toISOString(),
    attempts: 0,
  };
}

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
    MAIL_DOMAIN: 'xms.test',
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
  mail = new RecordingTransport();
  const workerRef = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(mail)
    .compile();
  worker = workerRef.createNestApplication({ bufferLogs: true });
  await worker.init();
  csat = worker.get(CsatService);

  adminToken = await devToken({ sub: 'dev_admin', email: ADMIN_EMAIL, sid: 'sess_admin' });
  await api().post('/v1/bootstrap').set(bearer(adminToken)).expect(201);
  const account = await api()
    .post('/v1/admin/accounts')
    .set(bearer(adminToken))
    .send({ key: 'BRK', name: 'Brookfield' })
    .expect(201);
  accountId = account.body.id;
  await api().post(`/v1/admin/accounts/${accountId}/activate`).set(bearer(adminToken)).expect(201);
  const settings = await api().get(`/v1/admin/accounts/${accountId}/settings`).set(bearer(adminToken)).expect(200);
  await api()
    .put(`/v1/admin/accounts/${accountId}/settings`)
    .set(bearer(adminToken))
    .send({ version: settings.body.version, csat_enabled: true })
    .expect(200);
  await api()
    .post(`/v1/accounts/${accountId}/contracts`)
    .set(bearer(adminToken))
    .send({ name: 'Retainer', model: 'retainer' })
    .expect(201);
  const roles = await api().get('/v1/admin/roles?catalog=portal').set(bearer(adminToken)).expect(200);
  const requester = roles.body.find((role: { name: string }) => role.name === 'Requester');
  for (const [email, first] of [
    ['pat@client.test', 'Pat'],
    ['sam@client.test', 'Sam'],
  ])
    await api()
      .post(`/v1/admin/accounts/${accountId}/portal-users`)
      .set(bearer(adminToken))
      .send({ email, first_name: first, last_name: 'Client', role_ids: [requester.id] })
      .expect(201);
  portalToken = await devToken({ sub: 'dev_pat', email: 'pat@client.test', org: 'acct-brk', sid: 'sess_pat' });
  otherPortalToken = await devToken({ sub: 'dev_sam', email: 'sam@client.test', org: 'acct-brk', sid: 'sess_sam' });
  await withSuperuser((client) =>
    client.query(
      `insert into acct.sender_identities (account_id, address, display_name, is_default) values ($1, 'brk@xms.test', 'BRK support', true)`,
      [accountId],
    ),
  );
  // Two tickets by Pat: one closed after hours of work, one closed within minutes.
  for (const [description, minutesOpen] of [
    ['Cube refresh fails', 180],
    ['Closed too fast', 5],
  ] as const) {
    const ticket = await api()
      .post('/v1/portal/tickets')
      .set(bearer(portalToken))
      .send({ type: 'incident', short_description: description, description: 'Details' })
      .expect(201);
    await closeDirectly(ticket.body.id, minutesOpen);
    if (minutesOpen === 180) ticketId = ticket.body.id;
    else fastTicketId = ticket.body.id;
  }
});

afterAll(async () => {
  await worker?.close();
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('CSAT on ticket close (CP-07)', () => {
  it('the close event earns one survey for the requester, suppresses the fast one, and never repeats', async () => {
    await csat.onOutbox(closeEvent(ticketId));
    await csat.onOutbox(closeEvent(ticketId));
    await csat.onOutbox(closeEvent(fastTicketId));
    await csat.onOutbox({ ...closeEvent(ticketId), payload: { from: 'in_progress', to: 'resolved' } });
    const rows = await withSuperuser((client) =>
      client.query(
        `select ticket_id, status, suppression_reason, remind_at is not null as reminds from acct.csat_surveys order by created_at`,
      ),
    );
    expect(rows.rows).toEqual([
      { ticket_id: ticketId, status: 'sent', suppression_reason: null, reminds: true },
      { ticket_id: fastTicketId, status: 'suppressed', suppression_reason: 'too_fast', reminds: false },
    ]);
    const audit = await withSuperuser((client) =>
      client.query(`select count(*)::int as n from acct.audit_events where event_type = 'csat.survey.sent'`),
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('the portal user sees their own pending survey and answers it once; another user cannot', async () => {
    const mine = await api().get('/v1/portal/surveys').set(bearer(portalToken)).expect(200);
    expect(mine.body.pending).toHaveLength(1);
    expect(mine.body.pending[0]).toMatchObject({ ticket_id: ticketId, status: 'sent', score: null });
    expect(mine.body.pending[0].ticket_key).toMatch(/^CS\d{7}$/);
    const surveyId = mine.body.pending[0].id;
    const others = await api().get('/v1/portal/surveys').set(bearer(otherPortalToken)).expect(200);
    expect(others.body.pending).toEqual([]);
    await api()
      .post(`/v1/portal/surveys/${surveyId}/answer`)
      .set(bearer(otherPortalToken))
      .send({ score: 5 })
      .expect(404);
    await api().post(`/v1/portal/surveys/${surveyId}/answer`).set(bearer(adminToken)).send({ score: 5 }).expect(403);
    const answered = await api()
      .post(`/v1/portal/surveys/${surveyId}/answer`)
      .set(bearer(portalToken))
      .send({ score: 2, comment: 'Took a while to hear back.' })
      .expect(200);
    expect(answered.body).toMatchObject({ survey_id: surveyId, score: 2 });
    const again = await api()
      .post(`/v1/portal/surveys/${surveyId}/answer`)
      .set(bearer(portalToken))
      .send({ score: 5 })
      .expect(409);
    expect(again.body.code).toBe('already_answered');
    const after = await api().get('/v1/portal/surveys').set(bearer(portalToken)).expect(200);
    expect(after.body.pending).toEqual([]);
    expect(after.body.answered[0]).toMatchObject({ id: surveyId, status: 'answered', score: 2 });
    // A low score reaches the account's contract managers and the outbox.
    const notes = await withSuperuser((client) =>
      client.query(`select title from acct.notifications where type = 'csat.low_score'`),
    );
    expect(notes.rows.length).toBeGreaterThan(0);
    expect(notes.rows[0].title).toContain('Low satisfaction score (2 of 5)');
    const outbox = await withSuperuser((client) =>
      client.query(`select payload from sys.outbox where event_type = 'csat.low_score' and aggregate_id = $1`, [
        surveyId,
      ]),
    );
    expect(outbox.rows[0].payload).toMatchObject({ score: 2, has_comment: true });
  });

  it('mails the link with the token in the fragment, where no server and no log sees it', async () => {
    // The token is the sole credential for the public answer route. In the
    // query string it lands in browser history, proxy and load balancer
    // logs, and is forwarded verbatim with the mail (finding 9).
    // Quoted-printable spells "=" as "=3D" and breaks long lines with "=\r\n".
    const bodies = mail.sent.map((message) =>
      message.raw
        .toString('utf8')
        .replace(/=\r?\n/g, '')
        .replace(/=3D/gi, '='),
    );
    expect(bodies.length).toBeGreaterThan(0);
    const links = bodies.filter((body) => /\/portal\/surveys\/[0-9a-f-]+#token=[A-Za-z0-9_-]+/.test(body));
    expect(links.length, `no fragment link in ${bodies.length} messages`).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toMatch(/\/portal\/surveys\/[0-9a-f-]+\?token=/);
  });

  it('the email link answers with the one-time token only, and the operator reads the scores', async () => {
    // A third closed ticket, surveyed the next day to clear the daily cap.
    const ticket = await api()
      .post('/v1/portal/tickets')
      .set(bearer(portalToken))
      .send({ type: 'incident', short_description: 'Third request', description: 'Details' })
      .expect(201);
    await closeDirectly(ticket.body.id, 180);
    await csat.onOutbox(closeEvent(ticket.body.id));
    const capped = await withSuperuser((client) =>
      client.query(`select id, status, suppression_reason from acct.csat_surveys where ticket_id = $1`, [
        ticket.body.id,
      ]),
    );
    expect(capped.rows[0]).toMatchObject({ status: 'suppressed', suppression_reason: 'daily_cap' });
    // Make room: move the earlier surveys to yesterday and survey again with a fresh row.
    await withSuperuser(async (client) => {
      await client.query(`update acct.csat_surveys set sent_at = now() - interval '1 day' where ticket_id <> $1`, [
        ticket.body.id,
      ]);
      await client.query('delete from acct.csat_surveys where ticket_id = $1', [ticket.body.id]);
    });
    await csat.onOutbox(closeEvent(ticket.body.id));
    const survey = (
      await withSuperuser((client) =>
        client.query(`select id, token_hash, status from acct.csat_surveys where ticket_id = $1`, [ticket.body.id]),
      )
    ).rows[0];
    expect(survey.status).toBe('sent');
    // Plant a known token so the link can be exercised.
    const token = 'known-token-for-the-test-only-0123456789';
    await withSuperuser((client) =>
      client.query('update acct.csat_surveys set token_hash = $2 where id = $1', [survey.id, hashToken(token)]),
    );
    const wrong = await api()
      .post(`/v1/csat/${survey.id}/answer`)
      .send({ token: 'not-the-token-at-all-0123456789', score: 5 })
      .expect(404);
    expect(wrong.body.code).toBe('not_found');
    const linked = await api()
      .post(`/v1/csat/${survey.id}/answer`)
      .send({ token, score: 5, comment: 'Quick and clear.' })
      .expect(200);
    expect(linked.body.score).toBe(5);
    await api().post(`/v1/csat/${survey.id}/answer`).send({ token, score: 4 }).expect(409);

    const view = await api().get(`/v1/accounts/${accountId}/csat`).set(bearer(adminToken)).expect(200);
    expect(view.body.summary).toMatchObject({ responses: 2, average: 3.5, low: 1 });
    expect(view.body.summary.distribution).toEqual({ '1': 0, '2': 1, '3': 0, '4': 0, '5': 1 });
    expect(view.body.surveys).toEqual({ sent: 2, answered: 2, suppressed: 1 });
    expect(
      view.body.responses.map((row: { score: number; contact_email: string }) => `${row.score}:${row.contact_email}`),
    ).toEqual(['5:pat@client.test', '2:pat@client.test']);
    await api().get(`/v1/accounts/${accountId}/csat`).set(bearer(portalToken)).expect(403);
  });

  it('the tick reminds once after three days and expires after ten', async () => {
    // The fast ticket already holds a suppressed survey for Pat; use a fresh ticket instead.
    const ticket = await api()
      .post('/v1/portal/tickets')
      .set(bearer(portalToken))
      .send({ type: 'incident', short_description: 'Reminder subject', description: 'Details' })
      .expect(201);
    const inserted = await withSuperuser((client) =>
      client.query(
        `insert into acct.csat_surveys (account_id, kind, ticket_id, contact_id, token_hash, status, sent_at, remind_at, expires_at)
         select account_id, 'ticket_close', $1, contact_id, 'x', 'sent', now() - interval '4 days', now() - interval '1 day', now() + interval '6 days'
           from acct.csat_surveys where ticket_id = $2 limit 1 returning id`,
        [ticket.body.id, ticketId],
      ),
    );
    const surveyId = inserted.rows[0].id;
    expect(await csat.tick()).toBe('reminded 1, expired 0');
    expect(await csat.tick()).toBe('reminded 0, expired 0');
    await withSuperuser((client) =>
      client.query(`update acct.csat_surveys set expires_at = now() - interval '1 minute' where id = $1`, [surveyId]),
    );
    expect(await csat.tick()).toBe('reminded 0, expired 1');
    const row = await withSuperuser((client) =>
      client.query('select status from acct.csat_surveys where id = $1', [surveyId]),
    );
    expect(row.rows[0].status).toBe('expired');
    const late = await api()
      .post(`/v1/portal/surveys/${surveyId}/answer`)
      .set(bearer(portalToken))
      .send({ score: 3 })
      .expect(409);
    expect(late.body.code).toBe('survey_closed');
  });
});

/**
 * The quarterly relationship survey (CP-07 remainder, functional 5.7): on
 * or after the first business day following a quarter end, one survey per
 * period and recipient for the account's portal admins and the contacts
 * flagged executive sponsor; five keyed questions plus a comment, two
 * reminders over three weeks, then expiry.
 */
describe('the quarterly relationship survey', () => {
  // 2027-12-31 is a Friday, so the first business day of the new quarter is
  // Monday 2028-01-03 and the Saturday before it is too early.
  const tooEarly = new Date('2028-01-01T09:00:00Z');
  const opensOn = new Date('2028-01-03T09:00:00Z');
  let adminPortalToken: string;
  let sponsorContactId: string;

  it('goes to the account admins and the flagged sponsors, once per period and recipient', async () => {
    const roles = await api().get('/v1/admin/roles?catalog=portal').set(bearer(adminToken)).expect(200);
    const accountAdmin = roles.body.find((role: { name: string }) => role.name === 'Account Admin');
    await api()
      .post(`/v1/admin/accounts/${accountId}/portal-users`)
      .set(bearer(adminToken))
      .send({ email: 'ava@client.test', first_name: 'Ava', last_name: 'Admin', role_ids: [accountAdmin.id] })
      .expect(201);
    adminPortalToken = await devToken({ sub: 'dev_ava', email: 'ava@client.test', org: 'acct-brk', sid: 'sess_ava' });

    // An executive sponsor need not hold a portal account: Chris is an
    // email-only contact of the account, and the flag is what puts them on
    // the quarterly list.
    await withSuperuser((client) =>
      client.query(`insert into acct.contacts (account_id, email, display_name) values ($1, $2, $3)`, [
        accountId,
        'chris@client.test',
        'Chris Ngata',
      ]),
    );
    const contacts = await api().get(`/v1/admin/accounts/${accountId}/contacts`).set(bearer(adminToken)).expect(200);
    const chris = contacts.body.find((row: { email: string }) => row.email === 'chris@client.test');
    expect(chris.flags).toEqual([]);
    sponsorContactId = chris.id;
    const flagged = await api()
      .patch(`/v1/admin/accounts/${accountId}/contacts/${chris.id}/flags`)
      .set(bearer(adminToken))
      .send({ version: chris.version, flags: ['executive_sponsor'] })
      .expect(200);
    expect(flagged.body.flags).toEqual(['executive_sponsor']);
    // The vocabulary is closed, and the route is the operator's alone.
    await api()
      .patch(`/v1/admin/accounts/${accountId}/contacts/${chris.id}/flags`)
      .set(bearer(adminToken))
      .send({ version: flagged.body.version, flags: ['vip'] })
      .expect(400);
    await api()
      .patch(`/v1/admin/accounts/${accountId}/contacts/${chris.id}/flags`)
      .set(bearer(portalToken))
      .send({ version: flagged.body.version, flags: [] })
      .expect(403);

    // The Saturday after the quarter end is before the first business day.
    expect(await csat.quarterlyTick(tooEarly)).toBe('created 0, skipped 0');
    expect(await csat.quarterlyTick(opensOn)).toBe('created 2, skipped 0');
    // The Tuesday after: the period and recipient already hold one.
    expect(await csat.quarterlyTick(new Date('2028-01-04T09:00:00Z'))).toBe('created 0, skipped 2');

    const rows = await withSuperuser((client) =>
      client.query(
        `select s.period, s.status, c.email::text as email from acct.csat_surveys s
           join acct.contacts c on c.id = s.contact_id
          where s.kind = 'quarterly' order by c.email`,
      ),
    );
    expect(rows.rows).toEqual([
      { period: '2027-Q4', status: 'sent', email: 'ava@client.test' },
      { period: '2027-Q4', status: 'sent', email: 'chris@client.test' },
    ]);
    // Pat and Sam are requesters with no sponsor flag, so no survey reached them.
    expect(rows.rows.some((row: { email: string }) => row.email.startsWith('pat') || row.email.startsWith('sam'))).toBe(
      false,
    );
  });

  it('shows both kinds in the portal list, each with its own questions', async () => {
    const mine = await api().get('/v1/portal/surveys').set(bearer(adminPortalToken)).expect(200);
    expect(mine.body.pending).toHaveLength(1);
    const survey = mine.body.pending[0];
    expect(survey).toMatchObject({ kind: 'quarterly', period: '2027-Q4', ticket_key: null });
    expect(survey.questions.map((question: { key: string }) => question.key)).toEqual([
      'responsiveness',
      'quality',
      'communication',
      'value',
      'recommend',
    ]);
    // Pat's list still carries the ticket-close survey with its one question.
    const pat = await api().get('/v1/portal/surveys').set(bearer(portalToken)).expect(200);
    const closed = pat.body.answered[0];
    expect(closed.kind).toBe('ticket_close');
    expect(closed.questions.map((question: { key: string }) => question.key)).toEqual(['score']);
  });

  it('accepts the five keyed scores and a comment, and refuses the wrong shape for the kind', async () => {
    const mine = await api().get('/v1/portal/surveys').set(bearer(adminPortalToken)).expect(200);
    const surveyId = mine.body.pending[0].id;
    // A single score answers a ticket-close survey, not this one.
    const wrongShape = await api()
      .post(`/v1/portal/surveys/${surveyId}/answer`)
      .set(bearer(adminPortalToken))
      .send({ score: 4 })
      .expect(400);
    expect(wrongShape.body.code).toBe('scores_required');
    const answered = await api()
      .post(`/v1/portal/surveys/${surveyId}/answer`)
      .set(bearer(adminPortalToken))
      .send({
        scores: { responsiveness: 5, quality: 4, communication: 4, value: 3, recommend: 4 },
        comment: 'Steady quarter, watch the invoicing.',
      })
      .expect(200);
    expect(answered.body).toMatchObject({ kind: 'quarterly', period: '2027-Q4', score: 4 });
    expect(answered.body.answers).toEqual({
      responsiveness: 5,
      quality: 4,
      communication: 4,
      value: 3,
      recommend: 4,
    });
    await api()
      .post(`/v1/portal/surveys/${surveyId}/answer`)
      .set(bearer(adminPortalToken))
      .send({ scores: { responsiveness: 5, quality: 5, communication: 5, value: 5, recommend: 5 } })
      .expect(409);
    // A score outside the five-point scale is refused before the service.
    const sponsorSurvey = await withSuperuser((client) =>
      client.query(`select id from acct.csat_surveys where kind = 'quarterly' and contact_id = $1`, [sponsorContactId]),
    );
    await api()
      .post(`/v1/csat/${sponsorSurvey.rows[0].id}/answer`)
      .send({
        token: 'x'.repeat(30),
        scores: { responsiveness: 9, quality: 1, communication: 1, value: 1, recommend: 1 },
      })
      .expect(400);
  });

  it('reminds twice over three weeks and then expires', async () => {
    // The cadence is walked by ageing the sponsor's unanswered survey a week
    // at a time, which is what the calendar does in production.
    const age = (days: number, id?: string) =>
      withSuperuser(async (client) => {
        const rows = await client.query(
          `update acct.csat_surveys set sent_at = now() - ($2 || ' days')::interval,
                  remind_at = now() - interval '1 hour', expires_at = now() + interval '7 days'
             where kind = 'quarterly' and contact_id = $1 and ($3::uuid is null or id = $3) returning id`,
          [sponsorContactId, String(days), id ?? null],
        );
        return rows.rows[0].id as string;
      });

    const surveyId = await age(8);
    expect(await csat.tick()).toBe('reminded 1, expired 0');
    const afterFirst = await withSuperuser((client) =>
      client.query('select status, remind_at from acct.csat_surveys where id = $1', [surveyId]),
    );
    // The second reminder is stamped on the row, a week after the first, so
    // the survey is not touched again until it falls due.
    expect(afterFirst.rows[0].status).toBe('reminded');
    expect(afterFirst.rows[0].remind_at).not.toBeNull();
    expect(await csat.tick()).toBe('reminded 0, expired 0');

    // A week later the second reminder is due.
    await age(15, surveyId);
    expect(await csat.tick()).toBe('reminded 1, expired 0');
    const afterSecond = await withSuperuser((client) =>
      client.query('select remind_at from acct.csat_surveys where id = $1', [surveyId]),
    );
    // Two reminders is the whole cadence; nothing is due after them.
    expect(afterSecond.rows[0].remind_at).toBeNull();
    expect(await csat.tick()).toBe('reminded 0, expired 0');
    await withSuperuser((client) =>
      client.query(`update acct.csat_surveys set expires_at = now() - interval '1 minute' where id = $1`, [surveyId]),
    );
    expect(await csat.tick()).toBe('reminded 0, expired 1');
  });

  it('summarises the quarter for the operator: averages per question and the trend', async () => {
    // A second, older quarter so the trend has two points.
    await withSuperuser(async (client) => {
      const survey = await client.query(
        `insert into acct.csat_surveys (account_id, kind, period, contact_id, token_hash, status, answered_at)
         values ($1, 'quarterly', '2027-Q3', $2, 'x', 'answered', now()) returning id`,
        [accountId, sponsorContactId],
      );
      await client.query(
        `insert into acct.csat_responses (account_id, survey_id, answers, comment)
         values ($1, $2, '{"responsiveness":3,"quality":3,"communication":3,"value":3,"recommend":3}'::jsonb, null)`,
        [accountId, survey.rows[0].id],
      );
    });
    const view = await api().get(`/v1/accounts/${accountId}/csat`).set(bearer(adminToken)).expect(200);
    expect(view.body.quarterly).toMatchObject({
      latest_period: '2027-Q4',
      responses: 1,
      averages: { responsiveness: 5, quality: 4, communication: 4, value: 3, recommend: 4 },
      average: 4,
    });
    expect(view.body.quarterly.trend).toEqual([
      { period: '2027-Q3', responses: 1, average: 3 },
      { period: '2027-Q4', responses: 1, average: 4 },
    ]);
    expect(view.body.quarterly.questions).toHaveLength(5);
    // The ticket-close summary is untouched by the relationship survey: the
    // two answer different questions and are never averaged together.
    expect(view.body.summary).toMatchObject({ responses: 2, average: 3.5 });
  });
});
