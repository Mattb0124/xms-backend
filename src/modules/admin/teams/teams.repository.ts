import { Injectable } from '@nestjs/common';
import { RepositoryBase, type Tx } from '../../../db/repository.base.js';

export interface TeamRow {
  id: string;
  name: string;
  description: string;
  lead_user_id: string | null;
  status: 'active' | 'retired';
  created_at: string;
  updated_at: string;
  version: number;
}

/** A team in the list, with the two counts the list actually shows. */
export interface TeamSummaryRow extends TeamRow {
  lead_name: string | null;
  member_count: number;
  account_count: number;
}

export interface TeamMemberRow {
  user_id: string;
  email: string;
  display_name: string | null;
  status: string;
}

export interface TeamAccountRow {
  account_id: string;
  key: string;
  name: string;
  status: string;
  owner_user_id: string | null;
  owner_name: string | null;
}

export const TEAM_EDITABLE = ['name', 'description', 'lead_user_id', 'status'] as const;

/**
 * op.teams and its two join tables (TM-23, migration 0050). Operator scope:
 * a team spans accounts by definition, so it carries no account_id and no
 * RLS, and the portal role holds no grant on any of the three tables.
 */
@Injectable()
export class TeamsRepository extends RepositoryBase {
  list(tx: Tx, options: { status?: string; limit: number }): Promise<TeamSummaryRow[]> {
    const values: unknown[] = [options.limit];
    let clause = '';
    if (options.status) {
      values.push(options.status);
      clause = `where t.status = $${values.length}`;
    }
    return this.many<TeamSummaryRow>(
      tx,
      `select t.*,
              nullif(trim(concat_ws(' ', l.first_name, l.last_name)), '') as lead_name,
              (select count(*)::int from op.team_members m where m.team_id = t.id) as member_count,
              (select count(*)::int from op.team_accounts a where a.team_id = t.id) as account_count
         from op.teams t
         left join op.users l on l.id = t.lead_user_id
         ${clause}
        order by t.status, t.name
        limit $1`,
      values,
    );
  }

  byId(tx: Tx, id: string): Promise<TeamRow> {
    return this.one<TeamRow>(tx, 'team', 'select * from op.teams where id = $1', [id]);
  }

  byName(tx: Tx, name: string): Promise<TeamRow | undefined> {
    return this.maybeOne<TeamRow>(tx, 'select * from op.teams where lower(name) = lower($1)', [name]);
  }

  insert(tx: Tx, input: { name: string; description: string; leadUserId: string | null }): Promise<TeamRow> {
    return this.one<TeamRow>(
      tx,
      'team',
      `insert into op.teams (name, description, lead_user_id) values ($1, $2, $3) returning *`,
      [input.name, input.description, input.leadUserId],
    );
  }

  update(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<TeamRow> {
    return this.updateVersioned<TeamRow>(tx, 'team', 'op.teams', id, version, assignments);
  }

  members(tx: Tx, teamId: string): Promise<TeamMemberRow[]> {
    return this.many<TeamMemberRow>(
      tx,
      `select m.user_id, u.email, nullif(trim(concat_ws(' ', u.first_name, u.last_name)), '') as display_name, u.status
         from op.team_members m
         join op.users u on u.id = m.user_id
        where m.team_id = $1
        order by u.last_name, u.first_name`,
      [teamId],
    );
  }

  accounts(tx: Tx, teamId: string): Promise<TeamAccountRow[]> {
    return this.many<TeamAccountRow>(
      tx,
      `select a.id as account_id, a.key, a.name, a.status, a.owner_user_id,
              nullif(trim(concat_ws(' ', o.first_name, o.last_name)), '') as owner_name
         from op.team_accounts ta
         join op.accounts a on a.id = ta.account_id
         left join op.users o on o.id = a.owner_user_id
        where ta.team_id = $1
        order by a.name`,
      [teamId],
    );
  }

  /**
   * Only internal users may be on a team: a team is an internal construct
   * and a portal identity has no business in one. Returns the ids that are
   * acceptable, so the service can name the ones that are not.
   */
  internalUserIds(tx: Tx, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.many<{ id: string }>(
      tx,
      `select id from op.users where id = any ($1::uuid[]) and kind = 'internal' and status <> 'deactivated'`,
      [ids],
    ).then((rows) => rows.map((row) => row.id));
  }

  liveAccountIds(tx: Tx, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.many<{ id: string }>(
      tx,
      `select id from op.accounts where id = any ($1::uuid[]) and status <> 'system'`,
      [ids],
    ).then((rows) => rows.map((row) => row.id));
  }

  /**
   * An account belongs to at most one team (the unique index says so), so a
   * reassignment has to say which team it is coming from. Returns the
   * accounts already held by a different team, for the typed refusal.
   */
  accountsHeldElsewhere(tx: Tx, teamId: string, ids: readonly string[]): Promise<{ account_id: string; team_id: string }[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.many<{ account_id: string; team_id: string }>(
      tx,
      `select account_id, team_id from op.team_accounts where account_id = any ($1::uuid[]) and team_id <> $2`,
      [ids, teamId],
    );
  }

  async replaceMembers(tx: Tx, teamId: string, userIds: readonly string[], addedBy: string): Promise<void> {
    await tx.query('delete from op.team_members where team_id = $1', [teamId]);
    if (userIds.length === 0) return;
    await tx.query(
      `insert into op.team_members (team_id, user_id, added_by)
       select $1, id, $3 from unnest($2::uuid[]) as id`,
      [teamId, userIds, addedBy],
    );
  }

  async replaceAccounts(tx: Tx, teamId: string, accountIds: readonly string[], addedBy: string): Promise<void> {
    await tx.query('delete from op.team_accounts where team_id = $1', [teamId]);
    if (accountIds.length === 0) return;
    await tx.query(
      `insert into op.team_accounts (team_id, account_id, added_by)
       select $1, id, $3 from unnest($2::uuid[]) as id`,
      [teamId, accountIds, addedBy],
    );
  }
}
