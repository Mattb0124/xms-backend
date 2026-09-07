import type pg from 'pg';
import type { DbPools, DbRole } from './pool.js';

/**
 * The account binding of one unit of work (Data Model section 3, Security
 * section 4). It is derived from the Principal by the guard and never from
 * a request body or header.
 */
export type AccountBinding =
  | { readonly kind: 'operator'; readonly accountIds: readonly string[] }
  | { readonly kind: 'portal'; readonly accountId: string }
  | { readonly kind: 'none' };

export interface SessionContext {
  readonly binding: AccountBinding;
  /** Request id propagated into audit and security events. */
  readonly requestId?: string;
  /** Domain correlation id (outbox, connectors). */
  readonly correlationId?: string;
}

export type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * Runs `fn` inside one transaction on the pool of the given role with the
 * account binding applied through SET LOCAL, which dies with the
 * transaction. This is the only place that sets `xms.account_ids` or
 * `xms.account_id`; repositories receive the client and never a pool.
 */
export async function withSession<T>(
  pools: DbPools,
  role: DbRole,
  context: SessionContext,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pools.get(role).connect();
  let done = false;
  try {
    await client.query('begin');
    await bind(client, context.binding);
    const result = await fn(client);
    await client.query('commit');
    done = true;
    return result;
  } catch (error) {
    if (!done) {
      await client.query('rollback').catch(() => undefined);
    }
    throw error;
  } finally {
    // Belt and braces: SET LOCAL already ended with the transaction; clearing
    // the session-level values guarantees a pooled connection never carries a
    // binding forward.
    await client
      .query("select set_config('xms.account_ids', '', false), set_config('xms.account_id', '', false)")
      .catch(() => undefined);
    client.release();
  }
}

async function bind(client: pg.PoolClient, binding: AccountBinding): Promise<void> {
  switch (binding.kind) {
    case 'operator': {
      const ids = binding.accountIds.map(assertUuid);
      // set_config with is_local = true is the parameterised form of SET LOCAL.
      await client.query("select set_config('xms.account_ids', $1, true)", [`{${ids.join(',')}}`]);
      return;
    }
    case 'portal': {
      await client.query("select set_config('xms.account_id', $1, true)", [assertUuid(binding.accountId)]);
      return;
    }
    case 'none':
      return;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string): string {
  if (!UUID.test(value)) {
    throw new Error('Account binding must contain uuids only');
  }
  return value;
}

/** Marks the transaction as audited; the audit writer calls this implicitly through the trigger. */
export async function markAudited(tx: Queryable): Promise<void> {
  await tx.query("select set_config('xms.audited', 'true', true)");
}
