import pg from 'pg';

/**
 * One connection pool per database role (Data Model section 2). The API uses
 * `app` for internal principals and `portal` for portal principals; the
 * worker uses `worker`. Nothing outside src/db opens a connection.
 */
export type DbRole = 'app' | 'portal' | 'worker';

export interface DbPoolUrls {
  readonly app?: string;
  readonly portal?: string;
  readonly worker?: string;
}

// Parse timestamptz as ISO strings rather than Date objects so values round
// trip through JSON without timezone surprises; the API formats dates itself.
pg.types.setTypeParser(1184, (value) => new Date(value).toISOString());
pg.types.setTypeParser(1114, (value) => new Date(`${value}Z`).toISOString());
// DATE columns come back as their ISO day ('YYYY-MM-DD'), never a local-time Date.
pg.types.setTypeParser(1082, (value) => value);
// bigint and numeric come back as strings by default; keep that (money and
// counters are formatted by the service layer).

export class DbPools {
  private readonly pools = new Map<DbRole, pg.Pool>();

  constructor(
    private readonly urls: DbPoolUrls,
    private readonly max = 10,
  ) {}

  has(role: DbRole): boolean {
    return Boolean(this.urls[role]);
  }

  get(role: DbRole): pg.Pool {
    const existing = this.pools.get(role);
    if (existing) return existing;
    const connectionString = this.urls[role];
    if (!connectionString) {
      throw new Error(`No database URL configured for role ${role}`);
    }
    const pool = new pg.Pool({
      connectionString,
      max: this.max,
      // A connection that skipped the session binding has the variables unset;
      // the policies then evaluate to false. We also reset on release so a
      // pooled connection never carries a previous request's binding.
      allowExitOnIdle: true,
    });
    pool.on('connect', (client) => {
      // Statement timeout keeps a runaway query from holding a connection.
      client.query('set statement_timeout = 30000').catch(() => undefined);
    });
    this.pools.set(role, pool);
    return pool;
  }

  async ping(role: DbRole): Promise<void> {
    await this.get(role).query('select 1');
  }

  async end(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.end()));
    this.pools.clear();
  }
}
