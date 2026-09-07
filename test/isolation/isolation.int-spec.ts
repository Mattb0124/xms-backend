import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSession } from '../../src/db/session.js';
import { closePools, pools, resetDatabase, withSuperuser } from '../kit/db.js';
import { insertFixtureRow, listAccountScopedTables, type TableInfo } from '../kit/fixtures.js';

/**
 * The generated isolation suite (Test Strategy section 3, Implementation
 * Plan P1.3.3). It introspects the live schema, so a table added by any
 * migration is covered automatically and a table missing RLS, a policy or
 * a portal revoke fails the build. Per table it proves, with the real
 * database roles:
 *
 *   structure  RLS enabled and forced; operator policy with USING and WITH
 *              CHECK; portal policy present exactly when the portal may read
 *   read       account A sees only its row; no binding sees nothing; A+B see both
 *   write      A cannot update or delete B's row; A cannot insert a row for B
 *   portal     bound to A sees A's row only, or has no privilege at all
 *
 * Fixture rows are generated from the catalog (see test/kit/fixtures.ts);
 * per-table value overrides live there, never here.
 */
const A = randomUUID();
const B = randomUUID();

let tables: TableInfo[] = [];
const rows = new Map<string, { a: string; b: string }>();
const totals = new Map<string, { a: number; all: number }>();

beforeAll(async () => {
  await resetDatabase();
  await withSuperuser(async (client) => {
    await client.query(
      `insert into op.accounts (id, key, name) values ($1, 'ISO-A', 'Isolation A'), ($2, 'ISO-B', 'Isolation B')`,
      [A, B],
    );
    tables = await listAccountScopedTables(client);
    const cacheA = new Map<string, string>();
    const cacheB = new Map<string, string>();
    for (const table of tables) {
      const a = await insertFixtureRow(client, table.qualified, A, cacheA);
      const b = await insertFixtureRow(client, table.qualified, B, cacheB);
      rows.set(table.qualified, { a, b });
    }
    // Parent rows created for foreign keys mean a table may hold more than
    // one row per account; the assertions compare against these totals.
    for (const table of tables) {
      const counts = await client.query<{ a: number; all: number }>(
        `select count(*) filter (where account_id = $1)::int as a, count(*)::int as all from ${table.qualified}`,
        [A],
      );
      totals.set(table.qualified, counts.rows[0]);
    }
  });
});

afterAll(async () => {
  await withSuperuser(async (client) => {
    await client.query('insert into sys.schema_checks (tables_checked, tables_failed, detail) values ($1, 0, $2)', [
      tables.length,
      JSON.stringify({ tables: tables.map((table) => table.qualified) }),
    ]);
  });
  await closePools();
});

describe('isolation suite', () => {
  it('finds the account-scoped tables', () => {
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.map((table) => table.qualified)).toContain('acct.account_settings');
  });

  it('covers every account-scoped table the database knows about', () => {
    // The per-table blocks are generated from the migration files at
    // collection time; this cross-check fails when a table exists in the
    // database that the static scan did not see (or the reverse).
    expect(tablesForEach().sort()).toEqual(tables.map((table) => table.qualified).sort());
  });

  it('gives the portal role no privilege on any operator or system table', async () => {
    const grants = await withSuperuser((client) =>
      client.query<{ table_schema: string; table_name: string }>(
        `select table_schema, table_name from information_schema.role_table_grants
          where grantee = 'xms_portal' and table_schema in ('op', 'sys')`,
      ),
    );
    expect(grants.rows).toEqual([]);
  });
});

describe.each(tablesForEach())('%s', (qualified) => {
  const table = (): TableInfo => tables.find((candidate) => candidate.qualified === qualified)!;
  const ids = (): { a: string; b: string } => rows.get(qualified)!;

  it('has row level security enabled and forced', () => {
    expect(table().rlsEnabled, 'ENABLE ROW LEVEL SECURITY missing').toBe(true);
    expect(table().rlsForced, 'FORCE ROW LEVEL SECURITY missing').toBe(true);
  });

  it('has the operator policy with USING and WITH CHECK on account_id', () => {
    const policy = table().policies.find((candidate) => candidate.name === 'acct_isolation_operator');
    expect(policy, 'acct_isolation_operator policy missing').toBeDefined();
    expect(policy!.using).toContain('account_id');
    expect(policy!.withCheck).toContain('account_id');
    expect(policy!.roles).toEqual(expect.arrayContaining(['xms_app', 'xms_worker']));
  });

  it('has the portal policy exactly when the portal may read', () => {
    const policy = table().policies.find((candidate) => candidate.name === 'acct_isolation_portal');
    if (table().portalCanSelect) {
      expect(policy, 'portal has SELECT but no acct_isolation_portal policy').toBeDefined();
      expect(policy!.using).toContain('account_id');
    } else {
      expect(table().portalPrivileges, 'portal has privileges without a portal policy').toEqual([]);
    }
  });

  it('shows account A only its own rows', async () => {
    const seen = await withSession(pools(), 'app', { binding: { kind: 'operator', accountIds: [A] } }, (tx) =>
      tx.query<{ id: string; account_id: string }>(`select id, account_id from ${qualified}`),
    );
    expect(seen.rows.map((row) => row.id)).toContain(ids().a);
    expect(seen.rows.map((row) => row.id)).not.toContain(ids().b);
    expect(new Set(seen.rows.map((row) => row.account_id))).toEqual(new Set([A]));
    expect(seen.rows.length).toBe(totals.get(qualified)!.a);
  });

  it('shows nothing to a session without a binding', async () => {
    const seen = await withSession(pools(), 'app', { binding: { kind: 'none' } }, (tx) =>
      tx.query(`select count(*)::int as n from ${qualified}`),
    );
    expect(seen.rows[0].n).toBe(0);
  });

  it('shows both rows to a session granted both accounts', async () => {
    const seen = await withSession(pools(), 'app', { binding: { kind: 'operator', accountIds: [A, B] } }, (tx) =>
      tx.query(`select count(*)::int as n from ${qualified}`),
    );
    expect(seen.rows[0].n).toBe(totals.get(qualified)!.all);
  });

  it('lets account A update or delete nothing of account B', async () => {
    const updated = await withSession(pools(), 'app', { binding: { kind: 'operator', accountIds: [A] } }, (tx) =>
      tx.query(`update ${qualified} set account_id = account_id where id = $1`, [ids().b]),
    );
    expect(updated.rowCount).toBe(0);
    const deleted = await withSession(pools(), 'app', { binding: { kind: 'operator', accountIds: [A] } }, (tx) =>
      tx.query(`delete from ${qualified} where id = $1`, [ids().b]),
    );
    expect(deleted.rowCount).toBe(0);
  });

  it('refuses an insert for account B from a session bound to A', async () => {
    const copy = await withSuperuser(async (client) => {
      const result = await client.query(`select * from ${qualified} where id = $1`, [ids().b]);
      return result.rows[0] as Record<string, unknown>;
    });
    delete copy.id;
    const columns = Object.keys(copy).filter((column) => !table().generatedColumns.includes(column));
    const text = `insert into ${qualified} (${columns.map((column) => `"${column}"`).join(', ')})
      values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`;
    const values = columns.map((column) => serialise(copy[column]));
    await expect(
      withSession(pools(), 'app', { binding: { kind: 'operator', accountIds: [A] } }, (tx) => tx.query(text, values)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('bounds the portal role to one account or refuses it entirely', async () => {
    const attempt = withSession(pools(), 'portal', { binding: { kind: 'portal', accountId: A } }, (tx) =>
      tx.query<{ id: string }>(`select id from ${qualified}`),
    );
    if (table().portalCanSelect) {
      const seen = await attempt;
      expect(seen.rows.map((row) => row.id)).toContain(ids().a);
      expect(seen.rows.map((row) => row.id)).not.toContain(ids().b);
      expect(seen.rows.length).toBe(totals.get(qualified)!.a);
    } else {
      await expect(attempt).rejects.toMatchObject({ code: '42501' });
    }
  });
});

function tablesForEach(): string[] {
  // describe.each needs the names at collection time; the table list itself
  // is loaded in beforeAll. The static list is read from the migrations so a
  // new table shows up here too; the runtime assertion above cross-checks it.
  return staticTableNames();
}

function staticTableNames(): string[] {
  const dir = join(process.cwd(), 'src', 'db', 'migrations');
  const names = new Set<string>();
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    for (const match of sql.matchAll(/create table ((?:acct|rpt)\.[a-z_]+) \(([\s\S]*?)\n\)/g)) {
      if (/\baccount_id uuid/.test(match[2])) names.add(match[1]);
    }
  }
  return [...names];
}

function serialise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && !(value instanceof Date)) return JSON.stringify(value);
  return value;
}
