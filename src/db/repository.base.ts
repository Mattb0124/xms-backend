import { NotFoundException } from '@nestjs/common';
import type pg from 'pg';

/**
 * Base for every repository. A repository never opens a connection; it is
 * handed the transaction client by the service through `withSession` and
 * owns the SQL for its tables (AIX standard: route database access through
 * the data layer). Helpers here keep the isolation rules uniform:
 *
 * - `one` raises 404 when a by-id read returns nothing. Under RLS that is
 *   indistinguishable from "not in your accounts", which is intended: a
 *   foreign id is never confirmed with a 403 (Security section 4).
 * - `updateVersioned` implements optimistic concurrency with `version`.
 */
export type Tx = Pick<pg.PoolClient, 'query'>;

export class StaleVersionError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} ${id} was modified by someone else`);
  }
}

export abstract class RepositoryBase {
  protected async many<T extends pg.QueryResultRow>(tx: Tx, text: string, values: unknown[] = []): Promise<T[]> {
    const result = await tx.query<T>(text, values);
    return result.rows;
  }

  protected async maybeOne<T extends pg.QueryResultRow>(
    tx: Tx,
    text: string,
    values: unknown[] = [],
  ): Promise<T | undefined> {
    const result = await tx.query<T>(text, values);
    return result.rows[0];
  }

  protected async one<T extends pg.QueryResultRow>(
    tx: Tx,
    entity: string,
    text: string,
    values: unknown[] = [],
  ): Promise<T> {
    const row = await this.maybeOne<T>(tx, text, values);
    if (!row) throw new NotFoundException({ code: 'not_found', entity });
    return row;
  }

  protected async count(tx: Tx, text: string, values: unknown[] = []): Promise<number> {
    const result = await tx.query(text, values);
    return result.rowCount ?? 0;
  }

  /**
   * Update with `WHERE id = $id AND version = $expected`, incrementing the
   * version. Zero rows means either stale or invisible; the caller decides
   * which by re-reading, which is what the typed 409 needs anyway.
   */
  protected async updateVersioned<T extends pg.QueryResultRow>(
    tx: Tx,
    entity: string,
    table: string,
    id: string,
    expectedVersion: number,
    assignments: Record<string, unknown>,
  ): Promise<T> {
    const keys = Object.keys(assignments);
    if (keys.length === 0) {
      return this.one<T>(tx, entity, `select * from ${table} where id = $1`, [id]);
    }
    const sets = keys.map((key, index) => `${quoteIdent(key)} = $${index + 3}`).join(', ');
    const result = await tx.query<T>(
      `update ${table} set ${sets}, version = version + 1 where id = $1 and version = $2 returning *`,
      [id, expectedVersion, ...keys.map((key) => assignments[key])],
    );
    if (result.rows[0]) return result.rows[0];
    const exists = await this.maybeOne(tx, `select 1 from ${table} where id = $1`, [id]);
    if (!exists) throw new NotFoundException({ code: 'not_found', entity });
    throw new StaleVersionError(entity, id);
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

export function quoteIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Unsafe identifier ${name}`);
  return `"${name}"`;
}
