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
 * The knowledge base over the real database (P2.14.1 to P2.14.4, ADR-05):
 * an article is account-scoped by visibility; the reviewer must differ from
 * the author; a published version is frozen; the resolution is a record;
 * the portal searches published articles and reads client notes only;
 * generalization is blocked by the identifier checklist; another account
 * sees nothing until the article is shared or global.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let consultantToken: string;
let otherConsultantToken: string;
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
    ['OTH', 'Other Corp'],
  ]) {
    const account = await api().post('/v1/admin/accounts').set(bearer(adminToken)).send({ key, name }).expect(201);
    await api().post(`/v1/admin/accounts/${account.body.id}/activate`).set(bearer(adminToken)).expect(201);
    await api()
      .post(`/v1/accounts/${account.body.id}/contracts`)
      .set(bearer(adminToken))
      .send({ name: 'Retainer', model: 'retainer' })
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
  await api()
    .post('/v1/admin/users')
    .set(bearer(adminToken))
    .send({
      email: 'omar@example.test',
      first_name: 'Omar',
      last_name: 'Diaz',
      role_ids: [consultant.id],
      account_ids: [otherAccountId],
    })
    .expect(201);
  consultantToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });
  otherConsultantToken = await devToken({ sub: 'dev_omar', email: 'omar@example.test', sid: 'sess_omar' });
  const portalRoles = await api().get('/v1/admin/roles?catalog=portal').set(bearer(adminToken)).expect(200);
  const requester = portalRoles.body.find((role: { name: string }) => role.name === 'Requester');
  await api()
    .post(`/v1/admin/accounts/${accountId}/portal-users`)
    .set(bearer(adminToken))
    .send({ email: 'pat@client.test', first_name: 'Pat', last_name: 'Client', role_ids: [requester.id] })
    .expect(201);
  portalToken = await devToken({ sub: 'dev_pat', email: 'pat@client.test', org: 'acct-brk', sid: 'sess_pat' });
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('article lifecycle', () => {
  let key: string;
  let articleId: string;

  it('creates a draft with version 1 and lists it for the owning account only', async () => {
    const response = await api()
      .post('/v1/articles')
      .set(bearer(consultantToken))
      .send({
        account_id: accountId,
        title: 'Consolidation report fails to open',
        categories: ['reporting'],
        problem_statement: 'The consolidation report returns error 500',
        steps: 'Renew the certificate on the report server and restart the service.',
        client_notes: 'Ask your administrator to renew the certificate.',
      })
      .expect(201);
    key = response.body.display_key;
    articleId = response.body.id;
    expect(key).toMatch(/^KB\d{6}$/);
    expect(response.body).toMatchObject({ status: 'draft', is_global: false, owner_name: 'Cara Lee' });
    expect(response.body.draft.version_no).toBe(1);
    expect(response.body.published).toBeNull();
    const mine = await api().get('/v1/articles').set(bearer(consultantToken)).expect(200);
    expect(mine.body.map((row: { display_key: string }) => row.display_key)).toEqual([key]);
    const theirs = await api().get('/v1/articles').set(bearer(otherConsultantToken)).expect(200);
    expect(theirs.body).toEqual([]);
    await api().get(`/v1/articles/${key}`).set(bearer(otherConsultantToken)).expect(404);
  });

  it('refuses the author as reviewer and publishes with a different reviewer, freezing the version', async () => {
    const draft = await api().get(`/v1/articles/${key}`).set(bearer(consultantToken)).expect(200);
    await api()
      .post(`/v1/articles/${key}/submit`)
      .set(bearer(consultantToken))
      .send({ version: draft.body.version })
      .expect(201);
    const self = await api()
      .post(`/v1/articles/${key}/publish`)
      .set(bearer(consultantToken))
      .send({ version: draft.body.version + 1 })
      .expect(403);
    expect(self.body.permission).toBe('kb:publish');
    const published = await api()
      .post(`/v1/articles/${key}/publish`)
      .set(bearer(adminToken))
      .send({ version: draft.body.version + 1 })
      .expect(201);
    expect(published.body).toMatchObject({ status: 'published', reviewer_name: expect.any(String) });
    expect(published.body.published.version_no).toBe(1);
    expect(published.body.published.published_at).not.toBeNull();
    await expect(
      withSuperuser((client) =>
        client.query(`update acct.article_versions set steps = 'x' where id = $1`, [published.body.published.id]),
      ),
    ).rejects.toMatchObject({ code: '23001' });
    const outbox = await withSuperuser((client) =>
      client.query(`select event_type from sys.outbox where aggregate_id = $1`, [articleId]),
    );
    expect(outbox.rows.map((row) => row.event_type)).toEqual(['article.published']);
  });

  it('finds the published article by full text and by key', async () => {
    const byText = await api()
      .get('/v1/search/solutions?q=consolidation report')
      .set(bearer(consultantToken))
      .expect(200);
    expect(byText.body.map((hit: { display_key: string }) => hit.display_key)).toEqual([key]);
    const byKey = await api()
      .get(`/v1/search/solutions?q=${key.slice(2)}`)
      .set(bearer(consultantToken))
      .expect(200);
    expect(byKey.body).toHaveLength(1);
    const nothing = await api()
      .get('/v1/search/solutions?q=consolidation')
      .set(bearer(otherConsultantToken))
      .expect(200);
    expect(nothing.body).toEqual([]);
  });

  it('edits after publish start a new draft version while the published one stays live', async () => {
    const before = await api().get(`/v1/articles/${key}`).set(bearer(consultantToken)).expect(200);
    const edited = await api()
      .put(`/v1/articles/${key}/draft`)
      .set(bearer(consultantToken))
      .send({
        version: before.body.version,
        steps: 'Renew the certificate, then restart the report service and clear the cache.',
      })
      .expect(200);
    expect(edited.body.status).toBe('published');
    expect(edited.body.draft.version_no).toBe(2);
    expect(edited.body.draft.problem_statement).toBe('The consolidation report returns error 500');
    expect(edited.body.published.version_no).toBe(1);
  });

  it('shares the article with another account and hides it again on reconcile', async () => {
    const current = await api().get(`/v1/articles/${key}`).set(bearer(adminToken)).expect(200);
    await api()
      .put(`/v1/articles/${key}/visibility`)
      .set(bearer(adminToken))
      .send({ account_ids: [otherAccountId] })
      .expect(200);
    void current;
    const shared = await api().get(`/v1/articles/${key}`).set(bearer(otherConsultantToken)).expect(200);
    expect(shared.body.display_key).toBe(key);
    const found = await api().get('/v1/search/solutions?q=consolidation').set(bearer(otherConsultantToken)).expect(200);
    expect(found.body).toHaveLength(1);
    await api().put(`/v1/articles/${key}/visibility`).set(bearer(adminToken)).send({ account_ids: [] }).expect(200);
    await api().get(`/v1/articles/${key}`).set(bearer(otherConsultantToken)).expect(404);
  });
});

describe('resolution record', () => {
  it('links a published article on resolve and refuses an unpublished one', async () => {
    const articles = await api().get('/v1/articles').set(bearer(consultantToken)).expect(200);
    const published = articles.body.find((row: { status: string }) => row.status === 'published');
    const draft = await api()
      .post('/v1/articles')
      .set(bearer(consultantToken))
      .send({ account_id: accountId, title: 'Unpublished draft', problem_statement: 'x', steps: 'y' })
      .expect(201);
    const ticket = await api()
      .post('/v1/tickets')
      .set(bearer(consultantToken))
      .send({ account_id: accountId, type: 'incident', short_description: 'Consolidation report error 500 again' })
      .expect(201);
    await api()
      .post(`/v1/tickets/${ticket.body.key}/transitions`)
      .set(bearer(consultantToken))
      .send({ version: 1, to: 'in_progress' })
      .expect(201);
    const rail = await api().get(`/v1/tickets/${ticket.body.key}/solutions`).set(bearer(consultantToken)).expect(200);
    expect(rail.body.articles.map((hit: { display_key: string }) => hit.display_key)).toEqual([published.display_key]);
    expect(rail.body.linked).toEqual([]);
    const refused = await api()
      .post(`/v1/tickets/${ticket.body.key}/transitions`)
      .set(bearer(consultantToken))
      .send({
        version: 2,
        to: 'resolved',
        resolution: { code: 'fixed', notes: 'Renewed', solution_article_id: draft.body.id, time_exemption_reason: 'x' },
      })
      .expect(409);
    expect(refused.body.code).toBe('article_not_published');
    const resolved = await api()
      .post(`/v1/tickets/${ticket.body.key}/transitions`)
      .set(bearer(consultantToken))
      .send({
        version: 2,
        to: 'resolved',
        resolution: {
          code: 'fixed',
          notes: 'Renewed the certificate',
          solution_article_id: published.id,
          time_exemption_reason: 'Logged elsewhere',
        },
      })
      .expect(201);
    expect(resolved.body.resolution.solution_article_id).toBe(published.id);
    const links = await api().get(`/v1/tickets/${ticket.body.key}/solutions`).set(bearer(consultantToken)).expect(200);
    expect(links.body.linked).toHaveLength(1);
    expect(links.body.linked[0]).toMatchObject({ outcome: 'resolved_by', display_key: published.display_key });
    await expect(withSuperuser((client) => client.query(`delete from acct.ticket_solutions`))).rejects.toMatchObject({
      code: '23001',
    });
    // The next similar ticket sees this one as a similar resolved ticket with its article.
    const next = await api()
      .post('/v1/tickets')
      .set(bearer(consultantToken))
      .send({ account_id: accountId, type: 'incident', short_description: 'Consolidation report error' })
      .expect(201);
    const nextRail = await api().get(`/v1/tickets/${next.body.key}/solutions`).set(bearer(consultantToken)).expect(200);
    expect(
      nextRail.body.similar_tickets.map((row: { key: string; article_key: string }) => [row.key, row.article_key]),
    ).toEqual([[ticket.body.key, published.display_key]]);
  });

  it('creates an article candidate from a ticket with the created_from link', async () => {
    const ticket = await api()
      .post('/v1/tickets')
      .set(bearer(consultantToken))
      .send({
        account_id: accountId,
        type: 'incident',
        short_description: 'Journal import stuck',
        description: 'The import hangs at 40 percent',
      })
      .expect(201);
    await api()
      .post(`/v1/tickets/${ticket.body.key}/work-notes`)
      .set(bearer(consultantToken))
      .send({ body: 'Killed the orphaned session and reran the import.' })
      .expect(201);
    const candidate = await api()
      .post(`/v1/tickets/${ticket.body.key}/article-candidate`)
      .set(bearer(consultantToken))
      .send({ include_work_notes: true })
      .expect(201);
    expect(candidate.body).toMatchObject({
      status: 'draft',
      title: 'Journal import stuck',
      source_ticket_id: ticket.body.id,
    });
    expect(candidate.body.draft.problem_statement).toBe('The import hangs at 40 percent');
    expect(candidate.body.draft.steps).toContain('orphaned session');
    const links = await api().get(`/v1/tickets/${ticket.body.key}/solutions`).set(bearer(consultantToken)).expect(200);
    expect(links.body.linked[0].outcome).toBe('created_from');
  });
});

describe('generalization', () => {
  it('is blocked by the identifier checklist and succeeds once the text is clean, landing under GLOBAL', async () => {
    const articles = await api().get('/v1/articles').set(bearer(consultantToken)).expect(200);
    const published = articles.body.find((row: { status: string }) => row.status === 'published');
    const dirty = await api()
      .post(`/v1/articles/${published.display_key}/generalize`)
      .set(bearer(adminToken))
      .send({ steps: 'Ask Brookfield to renew the certificate.' })
      .expect(201);
    expect(dirty.body.findings).toEqual([{ section: 'steps', kind: 'account_name', value: 'Brookfield' }]);
    const clean = await api()
      .post(`/v1/articles/${published.display_key}/generalize`)
      .set(bearer(adminToken))
      .send({})
      .expect(201);
    expect(clean.body).toMatchObject({ is_global: true, status: 'draft', generalized_from_id: published.id });
    const globalId = clean.body.id;
    // Publish the global copy (admin may review own draft); every account then reads it.
    const submitted = await api().get(`/v1/articles/${clean.body.display_key}`).set(bearer(adminToken)).expect(200);
    await api()
      .post(`/v1/articles/${clean.body.display_key}/publish`)
      .set(bearer(adminToken))
      .send({ version: submitted.body.version })
      .expect(201);
    const seen = await api()
      .get(`/v1/articles/${clean.body.display_key}`)
      .set(bearer(otherConsultantToken))
      .expect(200);
    expect(seen.body.id).toBe(globalId);
    const search = await api()
      .get('/v1/search/solutions?q=consolidation')
      .set(bearer(otherConsultantToken))
      .expect(200);
    expect(search.body.map((hit: { is_global: boolean }) => hit.is_global)).toEqual([true]);
  });
});

describe('portal knowledge', () => {
  it('searches published articles and reads client notes only, records solved-it feedback', async () => {
    const hits = await api().get('/v1/portal/knowledge?q=consolidation').set(bearer(portalToken)).expect(200);
    expect(hits.body.length).toBeGreaterThanOrEqual(1);
    expect(hits.body[0]).not.toHaveProperty('steps');
    const article = await api().get(`/v1/portal/knowledge/${hits.body[0].key}`).set(bearer(portalToken)).expect(200);
    expect(Object.keys(article.body).sort()).toEqual([
      'categories',
      'client_notes',
      'id',
      'key',
      'kind',
      'published_at',
      'self_service',
      'title',
    ]);
    await api()
      .post(`/v1/portal/knowledge/${hits.body[0].key}/feedback`)
      .set(bearer(portalToken))
      .send({ verdict: 'solved_it' })
      .expect(201);
    const feedback = await withSuperuser((client) =>
      client.query(`select verdict, principal_kind, context from acct.article_feedback`),
    );
    expect(feedback.rows).toEqual([{ verdict: 'solved_it', principal_kind: 'portal', context: 'portal_kb' }]);
    const drafts = await api().get('/v1/portal/knowledge?q=journal import').set(bearer(portalToken)).expect(200);
    expect(drafts.body).toEqual([]);
  });

  it('the portal database role never reads a version body beyond client notes', async () => {
    const db = urls();
    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString: db.portal });
    await client.connect();
    try {
      await client.query("select set_config('xms.account_id', $1, false)", [accountId]);
      await expect(client.query('select steps from acct.article_versions')).rejects.toMatchObject({ code: '42501' });
      const notes = await client.query('select client_notes from acct.article_versions where published_at is not null');
      expect(notes.rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      await client.end();
    }
  });
});
