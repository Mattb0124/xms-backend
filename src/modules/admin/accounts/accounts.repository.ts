import { Injectable } from '@nestjs/common';
import { RepositoryBase, type Tx } from '../../../db/repository.base.js';

export interface AccountRow {
  id: string;
  key: string;
  name: string;
  legal_name: string | null;
  status: 'onboarding' | 'active' | 'suspended' | 'offboarding' | 'offboarded';
  isolation_tier: 'shared' | 'dedicated';
  residency_region: string;
  default_time_zone: string;
  default_calendar_id: string | null;
  branding: Record<string, unknown>;
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface AccountSettingsRow {
  id: string;
  account_id: string;
  portal_enabled: boolean;
  consumption_visible: boolean;
  csat_enabled: boolean;
  sync_mode: 'off' | 'ingest_only' | 'bidirectional';
  ai_enabled: boolean;
  ai_opt_ins: Record<string, string>;
  ai_region_ok: boolean;
  email_branding: Record<string, unknown>;
  outbound_identity: string | null;
  inbound_aliases: string[];
  retention_days: number;
  attachment_max_bytes: string;
  usage_analytics_portal: boolean;
  store_search_terms: boolean;
  /** Container-case thresholds (TM-27); null switches a threshold off. */
  container_time_entries: number | null;
  container_elapsed_days: number | null;
  container_effort_minutes: number | null;
  /** Working days after resolve during which the ticket may reopen; 0 never. */
  reopen_window_business_days: number;
  version: number;
}

/**
 * What the general account PATCH may change. `owner_user_id` is deliberately
 * absent (TM-23): ownership moves only through the owner route, which checks
 * the candidate and writes its own audit and security events. Riding the
 * generic diff made handing over an account indistinguishable from editing a
 * time zone.
 */
export const ACCOUNT_EDITABLE = [
  'name',
  'legal_name',
  'isolation_tier',
  'residency_region',
  'default_time_zone',
  'branding',
] as const;

export const SETTINGS_EDITABLE = [
  'portal_enabled',
  'consumption_visible',
  'csat_enabled',
  'sync_mode',
  'ai_enabled',
  'ai_opt_ins',
  'email_branding',
  'outbound_identity',
  'inbound_aliases',
  'retention_days',
  'attachment_max_bytes',
  'usage_analytics_portal',
  'store_search_terms',
  'container_time_entries',
  'container_elapsed_days',
  'container_effort_minutes',
  'reopen_window_business_days',
] as const;

/** A prospective account owner, with what decides whether they may hold it. */
export interface OwnerCandidateRow {
  id: string;
  kind: 'internal' | 'portal' | 'service';
  status: 'invited' | 'active' | 'deactivated';
  display_name: string | null;
  granted: boolean;
}

/** An account as a picker sees it, with the person who owns the relationship. */
export interface AccountSummaryRow {
  id: string;
  key: string;
  name: string;
  status: string;
  owner_id: string | null;
  owner_name: string | null;
}

/**
 * op.accounts (operator scope, no RLS) and acct.account_settings (RLS).
 * Callers pass a transaction from the unit of work; settings reads and
 * writes only succeed when that transaction is bound to the account.
 */
@Injectable()
export class AccountsRepository extends RepositoryBase {
  list(tx: Tx, options: { status?: string; limit: number; cursor?: string }): Promise<AccountRow[]> {
    const values: unknown[] = [options.limit];
    const where: string[] = [];
    if (options.status) {
      values.push(options.status);
      where.push(`status = $${values.length}`);
    }
    if (options.cursor) {
      values.push(options.cursor);
      where.push(`key > $${values.length}`);
    }
    where.push(`status <> 'system'`);
    const clause = `where ${where.join(' and ')}`;
    return this.many<AccountRow>(tx, `select * from op.accounts ${clause} order by key limit $1`, values);
  }

  /**
   * Summary rows for the granted accounts (the non-admin picker). The owner
   * is the account's CSM: a list names them beside the account, so the row
   * carries the id to link to and the name to draw, and neither is fetched
   * again per row.
   */
  summariesByIds(tx: Tx, ids: readonly string[]): Promise<AccountSummaryRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.many(
      tx,
      `select a.id, a.key, a.name, a.status,
              a.owner_user_id as owner_id,
              nullif(trim(concat_ws(' ', o.first_name, o.last_name)), '') as owner_name
         from op.accounts a
         left join op.users o on o.id = a.owner_user_id
        where a.id = any ($1::uuid[]) and a.status <> 'system'
        order by a.name`,
      [ids],
    );
  }

  byId(tx: Tx, id: string): Promise<AccountRow> {
    return this.one<AccountRow>(tx, 'account', 'select * from op.accounts where id = $1', [id]);
  }

  /**
   * The person an account is about to be handed to, with the facts that
   * decide whether they may hold it: are they an active internal user, and
   * can they actually see this account. An owner who cannot open the account
   * is not an owner, so the service refuses rather than writing a name
   * nobody can act on.
   *
   * "Can see it" is a grant or the administrator binding, not a grant alone:
   * an `admin:accounts` holder is bound to every live account implicitly
   * (`principal.repository.ts`, resolveAccess) and holds no row in
   * `op.account_grants`, so checking only the grant table would refuse the
   * very people who onboard the accounts.
   */
  ownerCandidate(tx: Tx, userId: string, accountId: string): Promise<OwnerCandidateRow | undefined> {
    return this.maybeOne<OwnerCandidateRow>(
      tx,
      `select u.id, u.kind, u.status,
              nullif(trim(concat_ws(' ', u.first_name, u.last_name)), '') as display_name,
              (exists (select 1 from op.account_grants g where g.user_id = u.id and g.account_id = $2)
               or exists (select 1 from op.role_assignments ra
                            join op.roles r on r.id = ra.role_id
                           where ra.user_id = u.id and ra.account_id is null
                             and r.status = 'active' and r.catalog = 'operator'
                             and 'admin:accounts' = any (r.permissions))) as granted
         from op.users u
        where u.id = $1`,
      [userId, accountId],
    );
  }

  /** The current owner's name, for the audit entry and the security event. */
  ownerName(tx: Tx, userId: string | null): Promise<string | null> {
    if (!userId) return Promise.resolve(null);
    return this.maybeOne<{ display_name: string | null }>(
      tx,
      `select nullif(trim(concat_ws(' ', first_name, last_name)), '') as display_name from op.users where id = $1`,
      [userId],
    ).then((row) => row?.display_name ?? null);
  }

  async insert(
    tx: Tx,
    input: {
      key: string;
      name: string;
      legal_name?: string | null;
      residency_region?: string;
      default_time_zone?: string;
      isolation_tier?: string;
    },
  ): Promise<AccountRow> {
    return await this.one<AccountRow>(
      tx,
      'account',
      `insert into op.accounts (key, name, legal_name, residency_region, default_time_zone, isolation_tier)
         values ($1, $2, $3, coalesce($4, 'us-east-1'), coalesce($5, 'UTC'), coalesce($6, 'shared')) returning *`,
      [
        input.key,
        input.name,
        input.legal_name ?? null,
        input.residency_region,
        input.default_time_zone,
        input.isolation_tier,
      ],
    );
  }

  update(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<AccountRow> {
    return this.updateVersioned<AccountRow>(tx, 'account', 'op.accounts', id, version, assignments);
  }

  insertSettings(tx: Tx, accountId: string): Promise<AccountSettingsRow> {
    return this.one<AccountSettingsRow>(
      tx,
      'account_settings',
      'insert into acct.account_settings (account_id) values ($1) returning *',
      [accountId],
    );
  }

  settings(tx: Tx, accountId: string): Promise<AccountSettingsRow> {
    return this.one<AccountSettingsRow>(
      tx,
      'account_settings',
      'select * from acct.account_settings where account_id = $1',
      [accountId],
    );
  }

  /**
   * The only settings column the portal role may read. Used by the reopen
   * window so a client can see Reopen while it is still allowed, without
   * opening AI, aliases or retention through `select *`.
   */
  reopenWindowDays(tx: Tx, accountId: string): Promise<number> {
    return this.one<{ reopen_window_business_days: number }>(
      tx,
      'account_settings',
      'select reopen_window_business_days from acct.account_settings where account_id = $1',
      [accountId],
    ).then((row) => row.reopen_window_business_days);
  }

  async updateSettings(
    tx: Tx,
    id: string,
    version: number,
    assignments: Record<string, unknown>,
  ): Promise<AccountSettingsRow> {
    return this.updateVersioned<AccountSettingsRow>(
      tx,
      'account_settings',
      'acct.account_settings',
      id,
      version,
      assignments,
    );
  }
}
