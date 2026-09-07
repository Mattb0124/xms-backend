import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, pools, resetDatabase, withSuperuser } from '../../test/kit/db.js';
import { markAudited, withSession } from './session.js';

/**
 * P1.3.2 done-when: a query without the wrapper returns zero rows and a
 * query with two granted accounts returns exactly their rows. P1.3.6
 * done-when: an update on a protected table without an audit event in the
 * same transaction is rejected, and an update or delete on audit_events
 * raises.
 */
const A = randomUUID();
const B = randomUUID();
const C = randomUUID();

beforeAll(async () => {
  await resetDatabase();
  await withSuperuser(async (client) => {
    await client.query(
      `insert into op.accounts (id, key, name) values ($1, 'SES-A', 'A'), ($2, 'SES-B', 'B'), ($3, 'SES-C', 'C')`,
      [A, B, C],
    );
    await client.query(`insert into acct.account_settings (account_id) values ($1), ($2), ($3)`, [A, B, C]);
  });
});

afterAll(closePools);

describe('session binding', () => {
  it('returns no rows to a connection that never bound an account set', async () => {
    const bare = await pools().get('app').query('select count(*)::int as n from acct.account_settings');
    expect(bare.rows[0].n).toBe(0);
  });

  it('returns exactly the rows of the granted accounts', async () => {
    const seen = await withSession(pools(), 'app', { binding: { kind: 'operator', accountIds: [A, C] } }, (tx) =>
      tx.query<{ account_id: string }>('select account_id from acct.account_settings order by account_id'),
    );
    expect(seen.rows.map((row) => row.account_id).sort()).toEqual([A, C].sort());
  });

  it('does not leak the binding to the next user of the pooled connection', async () => {
    await withSession(pools(), 'app', { binding: { kind: 'operator', accountIds: [A] } }, async (tx) => {
      const seen = await tx.query('select count(*)::int as n from acct.account_settings');
      expect(seen.rows[0].n).toBe(1);
    });
    const after = await pools().get('app').query('select count(*)::int as n from acct.account_settings');
    expect(after.rows[0].n).toBe(0);
  });

  it('rejects a binding that is not made of uuids', async () => {
    await expect(
      withSession(pools(), 'app', { binding: { kind: 'operator', accountIds: ["x'); drop table"] } }, async () => 1),
    ).rejects.toThrow(/uuids only/);
  });

  it('rolls back when the unit of work throws', async () => {
    await expect(
      withSession(pools(), 'app', { binding: { kind: 'operator', accountIds: [A] } }, async (tx) => {
        await markAudited(tx);
        await tx.query('update acct.account_settings set portal_enabled = true where account_id = $1', [A]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const row = await withSuperuser((client) =>
      client.query('select portal_enabled from acct.account_settings where account_id = $1', [A]),
    );
    expect(row.rows[0].portal_enabled).toBe(false);
  });
});

describe('audit guard', () => {
  it('rejects an update on a protected table whose transaction wrote no audit event', async () => {
    await expect(
      withSession(pools(), 'app', { binding: { kind: 'operator', accountIds: [A] } }, (tx) =>
        tx.query('update acct.account_settings set portal_enabled = true where account_id = $1', [A]),
      ),
    ).rejects.toMatchObject({ code: '23000' });
  });

  it('accepts the same update when an audit event is written in the transaction', async () => {
    await withSession(pools(), 'app', { binding: { kind: 'operator', accountIds: [A] } }, async (tx) => {
      await tx.query('update acct.account_settings set portal_enabled = true where account_id = $1', [A]);
      await tx.query(
        `insert into acct.audit_events (account_id, entity_kind, entity_id, event_type, field, old_value, new_value, actor_kind, actor_id)
         values ($1, 'account_settings', $2, 'admin.account.settings_changed', 'portal_enabled', 'false', 'true', 'user', 'test')`,
        [A, A],
      );
    });
    const row = await withSuperuser((client) =>
      client.query('select portal_enabled from acct.account_settings where account_id = $1', [A]),
    );
    expect(row.rows[0].portal_enabled).toBe(true);
  });

  it('never allows an audit event to be updated or deleted, even by the owner', async () => {
    await expect(
      withSuperuser((client) => client.query(`update acct.audit_events set field = 'x' where account_id = $1`, [A])),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      withSuperuser((client) => client.query(`delete from acct.audit_events where account_id = $1`, [A])),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('never allows a security event to be updated or deleted', async () => {
    await withSuperuser((client) =>
      client.query(
        `insert into sys.security_events (event_type, actor_kind, actor_id, outcome) values ('auth.signin.success', 'user', 'u1', 'success')`,
      ),
    );
    await expect(
      withSuperuser((client) => client.query(`delete from sys.security_events where actor_id = 'u1'`)),
    ).rejects.toMatchObject({ code: '23001' });
  });
});
