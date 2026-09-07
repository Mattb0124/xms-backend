import pg from 'pg';
import { inject } from 'vitest';
import { DbPools } from '../../src/db/pool.js';
import type { TestDbUrls } from './global-setup.js';

/**
 * Access to the integration database from a test file. `pools()` gives the
 * role pools the application uses; `superuser()` a client for fixtures and
 * assertions that must bypass RLS; `resetDatabase()` empties every table
 * except the migration log so a file starts clean.
 */
let cachedPools: DbPools | undefined;
let cachedUrls: TestDbUrls | undefined;

export function urls(): TestDbUrls {
  if (!cachedUrls) cachedUrls = inject('db');
  return cachedUrls;
}

export function pools(): DbPools {
  if (!cachedPools) {
    const u = urls();
    cachedPools = new DbPools({ app: u.app, portal: u.portal, worker: u.worker }, 4);
  }
  return cachedPools;
}

export async function withSuperuser<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urls().superuser });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function resetDatabase(): Promise<void> {
  await withSuperuser(async (client) => {
    const tables = await client.query<{ schema: string; name: string }>(
      `select n.nspname as schema, c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and n.nspname in ('op', 'acct', 'sys', 'rpt')
          and not exists (select 1 from pg_inherits where inhrelid = c.oid)
          and (n.nspname || '.' || c.relname) not in ('rpt.portal_visible_measures', 'op.report_templates', 'op.connector_types')`,
    );
    if (tables.rows.length === 0) return;
    const list = tables.rows.map((row) => `"${row.schema}"."${row.name}"`).join(', ');
    // Append-only triggers are BEFORE UPDATE OR DELETE; TRUNCATE is neither.
    await client.query(`truncate ${list} restart identity cascade`);
    // System rows seeded by migrations are part of the schema, not test data.
    await client.query(
      `insert into op.accounts (id, key, name, status, default_time_zone)
       values ('00000000-0000-4000-8000-000000000001', 'GLOBAL', 'Global knowledge', 'system', 'UTC') on conflict (key) do nothing`,
    );
  });
}

export async function closePools(): Promise<void> {
  await cachedPools?.end();
  cachedPools = undefined;
}
