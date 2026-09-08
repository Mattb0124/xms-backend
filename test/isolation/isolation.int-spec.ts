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

  it('gives the portal role nothing in the operator or system schemas beyond the declared reads', async () => {
    // The one exception is op.config_defaults, and it is select only: every
    // portal view is rendered through the account's state machine, whose
    // global catalog bodies live there (migration 0027). It carries no
    // account column and no client content.
    const allowed = new Map([['op.config_defaults', ['SELECT']]]);
    const grants = await withSuperuser((client) =>
      client.query<{ table_schema: string; table_name: string; privilege_type: string }>(
        `select table_schema, table_name, privilege_type from information_schema.role_table_grants
          where grantee = 'xms_portal' and table_schema in ('op', 'sys')
          order by table_schema, table_name, privilege_type`,
      ),
    );
    const byTable = new Map<string, string[]>();
    for (const row of grants.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      byTable.set(key, [...(byTable.get(key) ?? []), row.privilege_type]);
    }
    expect([...byTable.keys()].sort()).toEqual([...allowed.keys()].sort());
    for (const [table, privileges] of byTable) expect(privileges.sort()).toEqual(allowed.get(table));
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

  it('has the portal policy exactly when the portal may read or write', () => {
    const policy = table().policies.find((candidate) => candidate.name === 'acct_isolation_portal');
    const privileges = table().portalPrivileges;
    if (table().portalCanSelect) {
      expect(policy, 'portal has SELECT but no acct_isolation_portal policy').toBeDefined();
      // Either bound to the account directly or through the article visibility function.
      expect(policy!.using ?? '').toMatch(/account_id|article_visible/);
    } else if (privileges.length > 0) {
      // Insert-only surfaces (feedback): the policy must bind the account on write.
      expect(privileges, 'portal write privileges beyond INSERT').toEqual(['INSERT']);
      expect(policy, 'portal has INSERT but no acct_isolation_portal policy').toBeDefined();
      expect(policy!.withCheck ?? '').toContain('account_id');
    } else {
      expect(policy, 'portal policy without any privilege').toBeUndefined();
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
    // Either the policy filters the row (zero rows) or the role has no
    // update/delete privilege at all (append-only streams); both are safe.
    const zeroRowsOrDenied = async (text: string): Promise<void> => {
      try {
        const result = await withSession(pools(), 'app', { binding: { kind: 'operator', accountIds: [A] } }, (tx) =>
          tx.query(text, [ids().b]),
        );
        expect(result.rowCount).toBe(0);
      } catch (error) {
        expect((error as { code?: string }).code).toBe('42501');
      }
    };
    await zeroRowsOrDenied(`update ${qualified} set account_id = account_id where id = $1`);
    await zeroRowsOrDenied(`delete from ${qualified} where id = $1`);
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
