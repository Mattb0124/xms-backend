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
  version: number;
}

export const ACCOUNT_EDITABLE = [
  'name',
  'legal_name',
  'isolation_tier',
  'residency_region',
  'default_time_zone',
  'branding',
  'owner_user_id',
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
] as const;

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

  /** Summary rows for the granted accounts (the non-admin picker). */
  summariesByIds(tx: Tx, ids: readonly string[]): Promise<Pick<AccountRow, 'id' | 'key' | 'name' | 'status'>[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.many(
      tx,
      `select id, key, name, status from op.accounts where id = any ($1::uuid[]) and status <> 'system' order by name`,
      [ids],
    );
  }

  byId(tx: Tx, id: string): Promise<AccountRow> {
    return this.one<AccountRow>(tx, 'account', 'select * from op.accounts where id = $1', [id]);
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
