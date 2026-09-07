import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectRouteTable } from '../src/common/auth/route-table.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { resetEnvForTests } from '../src/config/env.js';
import { DbPools } from '../src/db/pool.js';
import { JobRunner } from '../src/worker/jobs.js';
import { SlaJobs } from '../src/worker/sla-jobs.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * Worker jobs over the real database (P2.10.2 done-when): an idle ticket
 * past due latches within one sweep, a second sweep produces no second
 * event, two concurrent sweeps latch exactly once, the at-risk job fires
 * once, and the job lease keeps two runners from running the same job.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let worker: INestApplication;
let adminToken: string;
let accountId: string;
let sla: SlaJobs;

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
  const { WorkerModule } = await import('../src/worker/worker.module.js');
  const apiRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = apiRef.createNestApplication({ bufferLogs: true });
  app.use(requestContextMiddleware);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  const workerRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  worker = workerRef.createNestApplication({ bufferLogs: true });
  await worker.init();
  sla = worker.get(SlaJobs);

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
});

afterAll(async () => {
  await worker?.close();
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function createTicket(shortDescription: string): Promise<{ id: string; key: string }> {
  const response = await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({
      account_id: accountId,
      type: 'incident',
      short_description: shortDescription,
      impact: 'high',
      urgency: 'high',
    })
    .expect(201);
  return { id: response.body.id, key: response.body.key };
}

describe('breach sweeper', () => {
  it('does not mount any HTTP route in the worker beyond health', () => {
    const { collectRouteTable } =
      require('../src/common/auth/route-table.js') as typeof import('../src/common/auth/route-table.js');
    const routes = collectRouteTable(worker).map((entry) => entry.path);
    expect(routes).toEqual(['/healthz', '/readyz']);
  });

  it('latches an overdue clock exactly once with one audit event, one outbox row and one notification', async () => {
    const ticket = await createTicket('Overdue incident');
    await api()
      .patch(`/v1/tickets/${ticket.key}`)
      .set(bearer(adminToken))
      .send({
        version: 1,
        assignee_id: (await api().get('/v1/admin/me').set(bearer(adminToken))).body.principal.userId,
      })
      .expect(200);
    await withSuperuser((client) =>
      client.query(
        `update acct.sla_clocks set due_at = now() - interval '10 minutes' where ticket_id = $1 and kind = 'response'`,
        [ticket.id],
      ),
    );
    expect(await sla.sweep()).toBe('latched 1');
    expect(await sla.sweep()).toBe('latched 0');
    const clock = await withSuperuser((client) =>
      client.query(`select breached_at from acct.sla_clocks where ticket_id = $1 and kind = 'response'`, [ticket.id]),
    );
    expect(clock.rows[0].breached_at).not.toBeNull();
    const ticketRow = await api().get(`/v1/tickets/${ticket.key}`).set(bearer(adminToken)).expect(200);
    expect(ticketRow.body.sla.response.breached).toBe(true);
    expect(ticketRow.body.sla.response.remainingMinutes).toBeLessThan(0);
    const audit = await withSuperuser((client) =>
      client.query(`select actor_kind from acct.audit_events where ticket_id = $1 and event_type = 'sla.breached'`, [
        ticket.id,
      ]),
    );
    expect(audit.rows).toEqual([{ actor_kind: 'system' }]);
    const outbox = await withSuperuser((client) =>
      client.query(`select origin from sys.outbox where aggregate_id = $1 and event_type = 'sla.breached'`, [
        ticket.id,
      ]),
    );
    expect(outbox.rows).toEqual([{ origin: 'system' }]);
    const notifications = await withSuperuser((client) =>
      client.query(`select type, count from acct.notifications where target_id = $1 and type = 'sla.breached'`, [
        ticket.id,
      ]),
    );
    expect(notifications.rows).toEqual([{ type: 'sla.breached', count: 1 }]);
    const list = await api().get('/v1/tickets?open=true').set(bearer(adminToken)).expect(200);
    expect(list.body.stats.breached).toBe(1);
  });

  it('never latches a paused clock and latches exactly once under two concurrent sweeps', async () => {
    const paused = await createTicket('Paused incident');
    await api()
      .post(`/v1/tickets/${paused.key}/transitions`)
      .set(bearer(adminToken))
      .send({ version: 1, to: 'in_progress' })
      .expect(201);
    await api()
      .post(`/v1/tickets/${paused.key}/transitions`)
      .set(bearer(adminToken))
      .send({ version: 2, to: 'awaiting_client', pause_reason: 'awaiting_client' })
      .expect(201);
    const live = await createTicket('Racing incident');
    await withSuperuser((client) =>
      client.query(`update acct.sla_clocks set due_at = now() - interval '1 hour' where ticket_id = any ($1::uuid[])`, [
        [paused.id, live.id],
      ]),
    );
    const results = await Promise.all([sla.sweep(), sla.sweep()]);
    const latched = results.map((result) => Number(result.replace('latched ', ''))).reduce((a, b) => a + b, 0);
    // The live ticket has two clocks (response and resolution); the paused one none.
    expect(latched).toBe(2);
    const pausedClocks = await withSuperuser((client) =>
      client.query(`select breached_at from acct.sla_clocks where ticket_id = $1`, [paused.id]),
    );
    expect(pausedClocks.rows.every((row) => row.breached_at === null)).toBe(true);
    const events = await withSuperuser((client) =>
      client.query(
        `select count(*)::int as n from acct.audit_events where ticket_id = $1 and event_type = 'sla.breached'`,
        [live.id],
      ),
    );
    expect(events.rows[0].n).toBe(2);
  });
});

describe('at-risk job', () => {
  it('notifies once when less than a quarter of the window remains', async () => {
    const ticket = await createTicket('At risk incident');
    await withSuperuser((client) =>
      client.query(
        `update acct.sla_clocks set due_at = now() + interval '5 minutes' where ticket_id = $1 and kind = 'response'`,
        [ticket.id],
      ),
    );
    expect(await sla.notifyAtRisk()).toBe('notified 1');
    expect(await sla.notifyAtRisk()).toBe('notified 0');
    const notifications = await withSuperuser((client) =>
      client.query(`select type from acct.notifications where target_id = $1`, [ticket.id]),
    );
    expect(notifications.rows).toEqual([{ type: 'sla.at_risk' }]);
  });
});

describe('job leases', () => {
  it('lets only one runner execute a job at a time', async () => {
    const pools = worker.get(DbPools);
    const first = new JobRunner(pools);
    const second = new JobRunner(pools);
    let runs = 0;
    const job = {
      name: 'test.lease',
      intervalMs: 60_000,
      run: async () => {
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'ran';
      },
    };
    const results = await Promise.all([first.runOnce(job), second.runOnce(job)]);
    expect(results.sort()).toEqual(['ran', 'skipped']);
    expect(runs).toBe(1);
    // The lease is released after the run, so the next tick may run again.
    expect(await first.runOnce(job)).toBe('ran');
    const lease = await withSuperuser((client) =>
      client.query(`select last_outcome from sys.job_leases where name = 'test.lease'`),
    );
    expect(lease.rows[0].last_outcome).toBe('ran');
  });
});
