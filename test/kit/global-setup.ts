import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from '../../src/db/migrate.js';

/**
 * Starts one PostgreSQL for the whole integration run, creates the four
 * login roles, applies every migration, and hands the role URLs to the tests
 * through `inject('db')`. Set TEST_DATABASE_URL (a superuser URL) to reuse
 * the docker compose database instead of a throwaway container.
 */
export interface TestDbUrls {
  readonly superuser: string;
  readonly app: string;
  readonly portal: string;
  readonly worker: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    db: TestDbUrls;
  }
}

const ROLE_PASSWORD = 'xms';
const ROLES = ['xms_app', 'xms_portal', 'xms_worker', 'xms_migrator'] as const;

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  let superuser = process.env.TEST_DATABASE_URL;
  let stop: () => Promise<void> = async () => undefined;
  if (!superuser) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer(
      'pgvector/pgvector:0.8.0-pg16',
    )
      .withDatabase('xms_test')
      .start();
    superuser = container.getConnectionUri();
    stop = async () => {
      await container.stop();
    };
  }

  const client = new pg.Client({ connectionString: superuser });
  await client.connect();
  try {
    for (const role of ROLES) {
      const exists = await client.query(
        'select 1 from pg_roles where rolname = $1',
        [role],
      );
      if (exists.rowCount === 0) {
        await client.query(
          `create role ${role} login password '${ROLE_PASSWORD}'`,
        );
      } else {
        await client.query(
          `alter role ${role} login password '${ROLE_PASSWORD}'`,
        );
      }
    }
  } finally {
    await client.end();
  }

  await migrate(superuser);

  const url = new URL(superuser);
  const forRole = (role: string): string => {
    const copy = new URL(url.toString());
    copy.username = role;
    copy.password = ROLE_PASSWORD;
    return copy.toString();
  };
  project.provide('db', {
    superuser,
    app: forRole('xms_app'),
    portal: forRole('xms_portal'),
    worker: forRole('xms_worker'),
  });
  return stop;
}
