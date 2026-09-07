import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * SQL-first migration runner (Data Model section 6).
 *
 * Files in ./migrations are numbered `NNNN_name.sql` and applied in order,
 * each inside one transaction, with the `xms_migrator` role. Applied files
 * are recorded with a checksum in `public.xms_migrations`; a changed file
 * that was already applied fails the run, because history is never edited
 * (expand, migrate, contract). The runner is invoked by the pipeline before
 * the worker and API roll, by the local `pnpm db:migrate` script, and by the
 * test harness against a fresh container.
 */
export interface MigrationFile {
  readonly id: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, 'migrations');

export function listMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), 'utf8');
      return {
        id: file.slice(0, 4),
        name: file.replace(/\.sql$/, ''),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

export interface MigrateResult {
  readonly applied: string[];
  readonly skipped: string[];
}

export async function migrate(
  connectionString: string,
  options: { dir?: string; log?: (line: string) => void } = {},
): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query(`
      create table if not exists public.xms_migrations (
        id text primary key,
        name text not null,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`);
    // One runner at a time; a second pipeline job waits instead of racing.
    await client.query('select pg_advisory_lock(7245901)');
    const done = new Map<string, string>();
    for (const row of (
      await client.query('select id, checksum from public.xms_migrations')
    ).rows) {
      done.set(row.id as string, row.checksum as string);
    }
    for (const migration of listMigrations(options.dir)) {
      const existing = done.get(migration.id);
      if (existing) {
        if (existing !== migration.checksum) {
          throw new Error(
            `Migration ${migration.name} was already applied with a different checksum; history is never edited, add a new migration instead`,
          );
        }
        skipped.push(migration.name);
        continue;
      }
      log(`applying ${migration.name}`);
      await client.query('begin');
      try {
        await client.query(migration.sql);
        await client.query(
          'insert into public.xms_migrations (id, name, checksum) values ($1, $2, $3)',
          [migration.id, migration.name, migration.checksum],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw new Error(
          `Migration ${migration.name} failed: ${(error as Error).message}`,
        );
      }
      applied.push(migration.name);
    }
    await client.query('select pg_advisory_unlock(7245901)');
  } finally {
    await client.end();
  }
  return { applied, skipped };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const url = process.env.DATABASE_URL_MIGRATOR;
  if (!url) {
    console.error('DATABASE_URL_MIGRATOR is required');
    process.exit(2);
  }
  migrate(url, { log: (line) => console.log(line) })
    .then((result) => {
      console.log(
        `applied ${result.applied.length}, already applied ${result.skipped.length}`,
      );
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
