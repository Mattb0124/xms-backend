import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expandPermissions, type Permission } from '../../contracts/permissions.js';
import { DbPools } from '../../db/pool.js';

/**
 * Reads the operator tables the guard needs (Accounts & Administration
 * technical 3.1). Operator tables carry no RLS, so these run on the app pool
 * outside an account binding. Two indexed queries per request, no
 * cross-request cache, so revocation is immediate (technical section 5).
 */
export interface UserRow {
  readonly id: string;
  readonly kind: 'internal' | 'portal' | 'service';
  readonly account_id: string | null;
  readonly email: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly status: 'invited' | 'active' | 'deactivated';
}

export interface ResolvedAccess {
  readonly user: UserRow;
  readonly accountIds: string[];
  readonly permissions: Set<Permission>;
}

export interface ApiClientRow {
  readonly id: string;
  readonly name: string;
  readonly service_user_id: string;
  readonly secret_hash: string;
  readonly scopes: string[];
  readonly expires_at: string | null;
  readonly status: 'active' | 'revoked';
}

export const API_KEY_PREFIX = 'xms_live_';

export function apiKeyLookupHash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

@Injectable()
export class PrincipalRepository {
  constructor(private readonly pools: DbPools) {}

  async findUserByClerkId(clerkUserId: string): Promise<UserRow | undefined> {
    const result = await this.pools
      .get('app')
      .query<UserRow>(
        'select id, kind, account_id, email, first_name, last_name, status from op.users where clerk_user_id = $1',
        [clerkUserId],
      );
    return result.rows[0];
  }

  async findUserByEmail(email: string): Promise<UserRow | undefined> {
    const result = await this.pools
      .get('app')
      .query<UserRow>(
        'select id, kind, account_id, email, first_name, last_name, status from op.users where email = $1',
        [email],
      );
    return result.rows[0];
  }

  async findUserById(id: string): Promise<UserRow | undefined> {
    const result = await this.pools
      .get('app')
      .query<UserRow>('select id, kind, account_id, email, first_name, last_name, status from op.users where id = $1', [
        id,
      ]);
    return result.rows[0];
  }

  /** Binds a Clerk subject to a pre-invited user on first sign-in (matched by email). */
  async attachClerkId(userId: string, clerkUserId: string): Promise<void> {
    await this.pools.get('app').query(
      `update op.users set clerk_user_id = $2, status = case when status = 'invited' then 'active' else status end,
                last_sign_in_at = now() where id = $1 and clerk_user_id is null`,
      [userId, clerkUserId],
    );
  }

  async touchSignIn(userId: string): Promise<void> {
    await this.pools.get('app').query('update op.users set last_sign_in_at = now() where id = $1', [userId]);
  }

  /** Grants and the transitive permission closure for a user. */
  async resolveAccess(user: UserRow): Promise<ResolvedAccess> {
    const pool = this.pools.get('app');
    const accountIds =
      user.kind === 'portal'
        ? user.account_id
          ? [user.account_id]
          : []
        : (
            await pool.query<{ account_id: string }>(
              `select g.account_id from op.account_grants g
                 join op.accounts a on a.id = g.account_id
                where g.user_id = $1 and a.status in ('onboarding', 'active')`,
              [user.id],
            )
          ).rows.map((row) => row.account_id);
    const granted = await pool.query<{
      permissions: string[];
      account_id: string | null;
    }>(
      `select r.permissions, ra.account_id from op.role_assignments ra
         join op.roles r on r.id = ra.role_id
        where ra.user_id = $1 and r.status = 'active' and r.catalog = $2`,
      [user.id, user.kind === 'portal' ? 'portal' : 'operator'],
    );
    // Administrators (admin:accounts) are granted every live account
    // implicitly: account administration is by definition portfolio-wide.
    const globalPermissions = expandPermissions(
      granted.rows.flatMap((row) => (row.account_id === null ? row.permissions : [])),
    );
    const isAdministrator = globalPermissions.has('admin:accounts');
    const boundAccountIds = isAdministrator
      ? (
          await pool.query<{ id: string }>(
            `select id from op.accounts where status in ('onboarding', 'active', 'suspended', 'offboarding')`,
          )
        ).rows.map((row) => row.id)
      : accountIds;
    // Account-scoped role assignments contribute only when the account is
    // granted; Phase 1 treats them as global within the granted set (the
    // record-level scoping lands with the admin screens).
    const keys = granted.rows.flatMap((row) =>
      row.account_id === null || accountIds.includes(row.account_id) ? row.permissions : [],
    );
    return { user, accountIds: boundAccountIds, permissions: expandPermissions(keys) };
  }

  async findApiClient(key: string): Promise<(ApiClientRow & { accountIds: string[] }) | undefined> {
    if (!key.startsWith(API_KEY_PREFIX)) return undefined;
    const pool = this.pools.get('app');
    const result = await pool.query<ApiClientRow>(
      `select id, name, service_user_id, secret_hash, scopes, expires_at, status
         from op.api_clients where lookup_hash = $1`,
      [apiKeyLookupHash(key)],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const confirmed = await bcrypt.compare(key, row.secret_hash);
    if (!confirmed) return undefined;
    const grants = await pool.query<{ account_id: string }>(
      'select account_id from op.api_client_grants where api_client_id = $1',
      [row.id],
    );
    return { ...row, accountIds: grants.rows.map((grant) => grant.account_id) };
  }

  async touchApiClient(id: string): Promise<void> {
    await this.pools.get('app').query('update op.api_clients set last_used_at = now() where id = $1', [id]);
  }
}
