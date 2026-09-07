import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetEnvForTests } from '../src/config/env.js';
import { seedDev, type SeedSummary } from '../src/tools/seed.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';

/**
 * The development seed (P1.8.3 done-when): produces the demo set in one
 * pass within the time budget, every ticket state is represented, the
 * team, portal users, articles and the AI switch are in place, and a second
 * run adds nothing.
 */
let app: INestApplicationContext;
let first: SeedSummary;
const PER_ACCOUNT = 30;

beforeAll(async () => {
  await resetDatabase();
  const db = urls();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL_APP: db.app,
    DATABASE_URL_PORTAL: db.portal,
    DATABASE_URL_WORKER: db.worker,
    AUTH_DEV_SECRET: 'test-development-secret-0123456789',
    BOOTSTRAP_ADMIN_EMAILS: 'admin@example.test',
    STORAGE_KIND: 'local',
    STORAGE_LOCAL_ROOT: mkdtempSync(join(tmpdir(), 'xms-store-')),
    MAIL_TRANSPORT: 'file',
  });
  resetEnvForTests();
  const { AppModule } = await import('../src/app.module.js');
  app = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await app.init();
  first = await seedDev(app, { ticketsPerAccount: PER_ACCOUNT, log: () => undefined });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closePools();
});

describe('seed:dev', () => {
  it('creates the accounts, the team, portal users, articles and the tickets within budget', async () => {
    expect(first).toMatchObject({ accounts: 2, ticketsCreated: PER_ACCOUNT * 2, articlesCreated: 6 });
    expect(first.users).toBeGreaterThanOrEqual(1 + 6 + 1 + 6);
    expect(first.elapsedMs).toBeLessThan(120_000);
    const states = await withSuperuser((client) =>
      client.query<{ state: string; n: number }>(`select state, count(*)::int as n from acct.tickets group by 1`),
    );
    const byState = Object.fromEntries(states.rows.map((row) => [row.state, row.n]));
    for (const state of ['new', 'assigned', 'in_progress', 'awaiting_client', 'resolved', 'closed']) {
      expect(byState[state] ?? 0, `${state}: ${JSON.stringify(byState)}`).toBeGreaterThan(0);
    }
    const counts = await withSuperuser((client) =>
      client.query<{
        comments: number;
        notes: number;
        entries: number;
        published: number;
        clocks: number;
        aged: number;
      }>(
        `select (select count(*)::int from acct.comments) as comments,
                (select count(*)::int from acct.work_notes) as notes,
                (select count(*)::int from acct.time_entries) as entries,
                (select count(*)::int from acct.solution_articles where status = 'published') as published,
                (select count(*)::int from acct.sla_clocks) as clocks,
                (select count(*)::int from acct.tickets where created_at < now() - interval '7 days') as aged`,
      ),
    );
    expect(counts.rows[0].comments).toBeGreaterThan(0);
    expect(counts.rows[0].notes).toBeGreaterThan(0);
    expect(counts.rows[0].entries).toBeGreaterThan(0);
    expect(counts.rows[0].published).toBe(4);
    expect(counts.rows[0].clocks).toBeGreaterThan(0);
    expect(counts.rows[0].aged).toBeGreaterThan(0);
    const people = await withSuperuser((client) =>
      client.query<{ kind: string; n: number }>(`select kind, count(*)::int as n from op.users group by 1`),
    );
    expect(Object.fromEntries(people.rows.map((row) => [row.kind, row.n]))).toMatchObject({
      internal: 7,
      portal: 6,
      service: 1,
    });
    const groups = await withSuperuser((client) =>
      client.query<{ n: number }>(`select count(*)::int as n from op.group_members`),
    );
    expect(groups.rows[0].n).toBe(5);
    const ai = await withSuperuser((client) =>
      client.query<{ key: string; enabled: boolean }>(
        `select a.key, s.enabled from acct.ai_settings s join op.accounts a on a.id = s.account_id`,
      ),
    );
    expect(ai.rows).toEqual([{ key: 'BRK', enabled: true }]);
  });

  it('is idempotent: a second run creates nothing', async () => {
    const before = await withSuperuser((client) =>
      client.query<{ n: number }>(`select count(*)::int as n from acct.tickets`),
    );
    const second = await seedDev(app, { ticketsPerAccount: PER_ACCOUNT, log: () => undefined });
    expect(second).toMatchObject({ ticketsCreated: 0, articlesCreated: 0, users: 0 });
    const after = await withSuperuser((client) =>
      client.query<{ n: number }>(`select count(*)::int as n from acct.tickets`),
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
