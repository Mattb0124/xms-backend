import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * Catalog-driven fixture rows for the isolation suite. Given a table and an
 * account, inserts one valid row (creating referenced parent rows in the
 * same account first) using only what the catalog says: NOT NULL columns
 * without defaults, foreign keys, and CHECK vocabularies. Tables whose
 * constraints need specific values declare them in OVERRIDES; that is the
 * one place a human adds knowledge, and it is reviewed with the migration.
 */
export interface PolicyInfo {
  readonly name: string;
  readonly roles: string[];
  readonly command: string;
  readonly using: string | null;
  readonly withCheck: string | null;
}

export interface TableInfo {
  readonly schema: string;
  readonly name: string;
  readonly qualified: string;
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
  readonly policies: PolicyInfo[];
  readonly portalPrivileges: string[];
  readonly portalCanSelect: boolean;
  readonly generatedColumns: string[];
}

type OverrideValue = unknown | ((client: pg.Client, accountId: string, cache: Map<string, string>) => Promise<unknown>);

let nextFixtureDay = 0;
let billingCalls = 0;

/** A fresh calendar month per fixture row: calls come in pairs (start, end) in either order. */
function fixtureMonth(start: boolean): string {
  const month = Math.floor(billingCalls++ / 2);
  const year = 2000 + Math.floor(month / 12);
  return start
    ? new Date(Date.UTC(year, month % 12, 1)).toISOString().slice(0, 10)
    : new Date(Date.UTC(year, (month % 12) + 1, 0)).toISOString().slice(0, 10);
}

const OVERRIDES: Record<string, Record<string, OverrideValue>> = {
  'acct.calendar_hours': { weekday: 1, start_minute: 540, end_minute: 1020 },
  // One rate card version per (account, contract, effective date): each fixture row takes its own date.
  'acct.rate_cards': {
    effective_from: (): Promise<unknown> =>
      Promise.resolve(new Date(Date.UTC(2020, 0, 1) + nextFixtureDay++ * 86_400_000).toISOString().slice(0, 10)),
  },
  'acct.threshold_alert_events': { percent: 50, consumed_minutes_at_fire: 0, available_minutes: 0 },
  // A ticket-close survey names its ticket; the quarterly kind names a period instead.
  'acct.csat_surveys': {
    kind: 'ticket_close',
    // One survey per ticket and contact: every fixture row takes a fresh ticket.
    ticket_id: (client: pg.Client, accountId: string) => insertFixtureRow(client, 'acct.tickets', accountId, new Map()),
  },
  // A roster person referenced by capacity rows needs a role code and a unique email.
  'op.people': {
    role: 'consultant',
    email: (): Promise<unknown> => Promise.resolve(`fixture-${randomUUID()}@example.test`),
  },
  // One capacity actual per (person, account, month): each fixture row takes its own month.
  'rpt.capacity_actuals': {
    period_month: (): Promise<unknown> =>
      Promise.resolve(
        new Date(Date.UTC(1990 + Math.floor(nextFixtureDay / 12), nextFixtureDay++ % 12, 1)).toISOString().slice(0, 10),
      ),
  },
  // Billing periods never overlap per account: each fixture row takes its own month.
  // Both columns of one row share a month whichever is asked first: two calls per row, one month per pair.
  'acct.billing_periods': {
    starts_on: (): Promise<unknown> => Promise.resolve(fixtureMonth(true)),
    ends_on: (): Promise<unknown> => Promise.resolve(fixtureMonth(false)),
  },
  // Exactly one of ticket_id or bucket_id must be set.
  'acct.time_entries': {
    ticket_id: (client: pg.Client, accountId: string, cache: Map<string, string>) =>
      parentId(client, 'acct.tickets', accountId, cache),
  },
  // The portal reads whitelisted measures only.
  'rpt.daily_snapshots': { measure: 'open_tickets' },
  // The portal reads published articles and versions only.
  'acct.solution_articles': { status: 'published' },
  'acct.article_versions': { published_at: (): Promise<unknown> => Promise.resolve(new Date().toISOString()) },
  // The portal policy on the audit stream admits state transitions only.
  'acct.audit_events': { event_type: 'ticket.transition', field: 'state' },
  // Withheld rows are the only ones an account without the AI switch may hold.
  'acct.ai_suggestions': { status_initial: 'withheld', withheld_reason: 'switch_off' },
  'acct.ai_feedback': { rating: 3 },
  // The connector type is an operator catalog row, not an account row.
  'acct.connector_instances': { type: 'servicenow' },
  // A link needs two distinct tickets; the second is created outside the cache.
  'acct.ticket_links': {
    to_ticket_id: (client: pg.Client, accountId: string) =>
      insertFixtureRow(client, 'acct.tickets', accountId, new Map()),
  },
};

export async function listAccountScopedTables(client: pg.Client): Promise<TableInfo[]> {
  const tables = await client.query<{
    schema: string;
    name: string;
    rls_enabled: boolean;
    rls_forced: boolean;
  }>(
    `select n.nspname as schema, c.relname as name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and n.nspname in ('acct', 'rpt')
        and not exists (select 1 from pg_inherits where inhrelid = c.oid)
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'account_id' and not a.attisdropped)
      order by 1, 2`,
  );
  const result: TableInfo[] = [];
  for (const row of tables.rows) {
    const policies = await client.query<{
      policyname: string;
      roles: string[];
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(`select policyname, roles, cmd, qual, with_check from pg_policies where schemaname = $1 and tablename = $2`, [
      row.schema,
      row.name,
    ]);
    const privileges = await client.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'xms_portal' and table_schema = $1 and table_name = $2
       union
       select distinct privilege_type from information_schema.role_column_grants
        where grantee = 'xms_portal' and table_schema = $1 and table_name = $2`,
      [row.schema, row.name],
    );
    const generated = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = $1 and table_name = $2 and (is_generated = 'ALWAYS' or is_identity = 'YES')`,
      [row.schema, row.name],
    );
    const portalPrivileges = privileges.rows.map((privilege) => privilege.privilege_type);
    result.push({
      schema: row.schema,
      name: row.name,
      qualified: `${row.schema}.${row.name}`,
      rlsEnabled: row.rls_enabled,
      rlsForced: row.rls_forced,
      policies: policies.rows.map((policy) => ({
        name: policy.policyname,
        roles: parsePgArray(policy.roles),
        command: policy.cmd,
        using: policy.qual,
        withCheck: policy.with_check,
      })),
      portalPrivileges,
      portalCanSelect: portalPrivileges.includes('SELECT'),
      generatedColumns: generated.rows.map((column) => column.column_name),
    });
  }
  return result;
}

// pg returns name[] columns as their text form ({a,b}) because no type
// parser is registered for that array type.
function parsePgArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value !== 'string') return [];
  return value
    .replace(/^{|}$/g, '')
    .split(',')
    .filter(Boolean)
    .map((item) => item.replace(/^"|"$/g, ''));
}

interface ColumnInfo {
  name: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  hasDefault: boolean;
  generated: boolean;
}

interface ForeignKey {
  column: string;
  refTable: string;
}

export async function insertFixtureRow(
  client: pg.Client,
  qualified: string,
  accountId: string,
  cache: Map<string, string> = new Map(),
): Promise<string> {
  const [schema, name] = qualified.split('.');
  const columns = await loadColumns(client, schema, name);
  const foreignKeys = await loadForeignKeys(client, schema, name);
  const checks = await loadCheckVocabularies(client, schema, name);
  const overrides = OVERRIDES[qualified] ?? {};

  const values: Record<string, unknown> = {};
  for (const column of columns) {
    if (column.generated || column.name === 'id') continue;
    if (column.name === 'account_id') {
      values[column.name] = accountId;
      continue;
    }
    if (column.name in overrides) {
      const override = overrides[column.name];
      values[column.name] = typeof override === 'function' ? await override(client, accountId, cache) : override;
      continue;
    }
    const fk = foreignKeys.find((candidate) => candidate.column === column.name);
    if (fk) {
      if (!column.nullable) values[column.name] = await parentId(client, fk.refTable, accountId, cache);
      continue;
    }
    if (column.nullable || column.hasDefault) continue;
    values[column.name] = valueFor(column, checks.get(column.name));
  }
  const keys = Object.keys(values);
  const inserted = await client.query<{ id: string }>(
    `insert into ${qualified} (${keys.map((key) => `"${key}"`).join(', ')})
     values (${keys.map((_, index) => `$${index + 1}`).join(', ')}) returning id`,
    keys.map((key) => values[key]),
  );
  const id = inserted.rows[0].id;
  cache.set(`${qualified}:${accountId}`, id);
  return id;
}

async function parentId(
  client: pg.Client,
  refTable: string,
  accountId: string,
  cache: Map<string, string>,
): Promise<string> {
  if (refTable === 'op.accounts') return accountId;
  const key = `${refTable}:${accountId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const id = await insertFixtureRow(client, refTable, accountId, cache);
  cache.set(key, id);
  return id;
}

async function loadColumns(client: pg.Client, schema: string, name: string): Promise<ColumnInfo[]> {
  const result = await client.query<{
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
    is_generated: string;
    is_identity: string;
  }>(
    `select column_name, data_type, udt_name, is_nullable, column_default, is_generated, is_identity
       from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position`,
    [schema, name],
  );
  return result.rows.map((row) => ({
    name: row.column_name,
    dataType: row.data_type,
    udtName: row.udt_name,
    nullable: row.is_nullable === 'YES',
    hasDefault: row.column_default !== null,
    generated: row.is_generated === 'ALWAYS' || row.is_identity === 'YES',
  }));
}

async function loadForeignKeys(client: pg.Client, schema: string, name: string): Promise<ForeignKey[]> {
  const result = await client.query<{
    column: string;
    ref_schema: string;
    ref_table: string;
  }>(
    `select a.attname as column, rn.nspname as ref_schema, rc.relname as ref_table
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_class rc on rc.oid = con.confrelid
       join pg_namespace rn on rn.oid = rc.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum = any (con.conkey)
      where con.contype = 'f' and n.nspname = $1 and c.relname = $2`,
    [schema, name],
  );
  return result.rows.map((row) => ({
    column: row.column,
    refTable: `${row.ref_schema}.${row.ref_table}`,
  }));
}

async function loadCheckVocabularies(client: pg.Client, schema: string, name: string): Promise<Map<string, string>> {
  const result = await client.query<{ definition: string }>(
    `select pg_get_constraintdef(con.oid) as definition
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       join pg_namespace n on n.oid = c.relnamespace
      where con.contype = 'c' and n.nspname = $1 and c.relname = $2`,
    [schema, name],
  );
  const vocab = new Map<string, string>();
  for (const row of result.rows) {
    // CHECK ((status = ANY (ARRAY['a'::text, 'b'::text]))) -> status: a
    const match = row.definition.match(/\(\(?(\w+)\)?(?:::text)? = ANY \(\(?ARRAY\['([^']+)'/);
    if (match) vocab.set(match[1], match[2]);
  }
  return vocab;
}

function valueFor(column: ColumnInfo, vocabulary: string | undefined): unknown {
  if (vocabulary) return vocabulary;
  const suffix = randomUUID().slice(0, 8);
  switch (column.udtName) {
    case 'uuid':
      return randomUUID();
    case 'text':
    case 'varchar':
    case 'bpchar':
      return column.name.includes('email') ? `fixture-${suffix}@example.test` : `fixture ${suffix}`;
    case 'citext':
      return `fixture-${suffix}@example.test`;
    case 'int2':
    case 'int4':
    case 'int8':
    case 'numeric':
    case 'float8':
      return 1;
    case 'bool':
      return true;
    case 'timestamptz':
    case 'timestamp':
      return new Date().toISOString();
    case 'date':
      return new Date().toISOString().slice(0, 10);
    case 'jsonb':
    case 'json':
      return '{}';
    default:
      if (column.dataType === 'ARRAY') return '{}';
      throw new Error(
        `No fixture value for ${column.name} (${column.udtName}); add an override in test/kit/fixtures.ts`,
      );
  }
}
