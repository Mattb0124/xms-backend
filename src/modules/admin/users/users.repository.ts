import { Injectable } from '@nestjs/common';
import { RepositoryBase, type Tx } from '../../../db/repository.base.js';

export interface UserRecord {
  id: string;
  clerk_user_id: string | null;
  kind: 'internal' | 'portal' | 'service';
  account_id: string | null;
  email: string;
  first_name: string;
  last_name: string;
  title: string | null;
  business_phone: string | null;
  mobile_phone: string | null;
  time_zone: string;
  language: string;
  date_format: string;
  status: 'invited' | 'active' | 'deactivated';
  last_sign_in_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface RoleRecord {
  id: string;
  catalog: 'operator' | 'portal';
  name: string;
  description: string;
  permissions: string[];
  is_system: boolean;
  status: 'active' | 'retired';
  version: number;
}

export interface GroupRecord {
  id: string;
  name: string;
  description: string;
  service_line: string | null;
  lead_user_id: string | null;
  status: 'active' | 'retired';
  version: number;
}

export const USER_EDITABLE = [
  'first_name',
  'last_name',
  'title',
  'business_phone',
  'mobile_phone',
  'time_zone',
  'language',
  'date_format',
] as const;

@Injectable()
export class UsersRepository extends RepositoryBase {
  list(
    tx: Tx,
    options: { kind?: string; accountId?: string; assignable?: boolean; limit: number; cursor?: string },
  ): Promise<UserRecord[]> {
    const values: unknown[] = [options.limit];
    const where: string[] = [];
    if (options.kind) {
      values.push(options.kind);
      where.push(`kind = $${values.length}`);
    }
    if (options.accountId) {
      values.push(options.accountId);
      where.push(`account_id = $${values.length}`);
    }
    if (options.assignable) where.push(`kind = 'internal' and status = 'active'`);
    if (options.cursor) {
      values.push(options.cursor);
      where.push(`email > $${values.length}`);
    }
    const clause = where.length > 0 ? `where ${where.join(' and ')}` : '';
    return this.many<UserRecord>(tx, `select * from op.users ${clause} order by email limit $1`, values);
  }

  byId(tx: Tx, id: string): Promise<UserRecord> {
    return this.one<UserRecord>(tx, 'user', 'select * from op.users where id = $1', [id]);
  }

  byEmail(tx: Tx, email: string): Promise<UserRecord | undefined> {
    return this.maybeOne<UserRecord>(tx, 'select * from op.users where email = $1', [email]);
  }

  insert(
    tx: Tx,
    input: {
      kind: 'internal' | 'portal' | 'service';
      email: string;
      first_name?: string;
      last_name?: string;
      account_id?: string | null;
      clerk_user_id?: string | null;
      status?: 'invited' | 'active';
      time_zone?: string;
    },
  ): Promise<UserRecord> {
    return this.one<UserRecord>(
      tx,
      'user',
      `insert into op.users (kind, email, first_name, last_name, account_id, clerk_user_id, status, time_zone)
       values ($1, $2, coalesce($3, ''), coalesce($4, ''), $5, $6, coalesce($7, 'invited'), coalesce($8, 'UTC')) returning *`,
      [
        input.kind,
        input.email,
        input.first_name,
        input.last_name,
        input.account_id ?? null,
        input.clerk_user_id ?? null,
        input.status,
        input.time_zone,
      ],
    );
  }

  update(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<UserRecord> {
    return this.updateVersioned<UserRecord>(tx, 'user', 'op.users', id, version, assignments);
  }

  // Roles ------------------------------------------------------------------

  roles(tx: Tx, catalog?: string): Promise<RoleRecord[]> {
    return catalog
      ? this.many<RoleRecord>(tx, 'select * from op.roles where catalog = $1 order by name', [catalog])
      : this.many<RoleRecord>(tx, 'select * from op.roles order by catalog, name');
  }

  roleById(tx: Tx, id: string): Promise<RoleRecord> {
    return this.one<RoleRecord>(tx, 'role', 'select * from op.roles where id = $1', [id]);
  }

  roleByName(tx: Tx, catalog: string, name: string): Promise<RoleRecord | undefined> {
    return this.maybeOne<RoleRecord>(tx, 'select * from op.roles where catalog = $1 and lower(name) = lower($2)', [
      catalog,
      name,
    ]);
  }

  insertRole(
    tx: Tx,
    input: { catalog: string; name: string; description?: string; permissions: string[]; is_system?: boolean },
  ): Promise<RoleRecord> {
    return this.one<RoleRecord>(
      tx,
      'role',
      `insert into op.roles (catalog, name, description, permissions, is_system)
       values ($1, $2, coalesce($3, ''), $4, coalesce($5, false)) returning *`,
      [input.catalog, input.name, input.description, input.permissions, input.is_system],
    );
  }

  updateRole(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<RoleRecord> {
    return this.updateVersioned<RoleRecord>(tx, 'role', 'op.roles', id, version, assignments);
  }

  assignmentsOf(tx: Tx, userId: string): Promise<{ role_id: string; account_id: string | null; name: string }[]> {
    return this.many(
      tx,
      `select ra.role_id, ra.account_id, r.name from op.role_assignments ra join op.roles r on r.id = ra.role_id where ra.user_id = $1 order by r.name`,
      [userId],
    );
  }

  async replaceAssignments(
    tx: Tx,
    userId: string,
    roles: { roleId: string; accountId: string | null }[],
  ): Promise<void> {
    await tx.query('delete from op.role_assignments where user_id = $1', [userId]);
    for (const role of roles) {
      await tx.query('insert into op.role_assignments (user_id, role_id, account_id) values ($1, $2, $3)', [
        userId,
        role.roleId,
        role.accountId,
      ]);
    }
  }

  /** Active users holding an active role whose permissions include admin:users (the administrator set). */
  administrators(tx: Tx): Promise<{ user_id: string }[]> {
    return this.many(
      tx,
      `select distinct ra.user_id from op.role_assignments ra
         join op.roles r on r.id = ra.role_id
         join op.users u on u.id = ra.user_id
        where r.status = 'active' and 'admin:users' = any (r.permissions) and u.status = 'active' and ra.account_id is null`,
    );
  }

  // Grants -----------------------------------------------------------------

  grantsOf(tx: Tx, userId: string): Promise<{ account_id: string; granted_by: string; granted_at: string }[]> {
    return this.many(
      tx,
      'select account_id, granted_by, granted_at from op.account_grants where user_id = $1 order by granted_at',
      [userId],
    );
  }

  granteesOf(
    tx: Tx,
    accountId: string,
  ): Promise<{ user_id: string; email: string; first_name: string; last_name: string }[]> {
    return this.many(
      tx,
      `select g.user_id, u.email, u.first_name, u.last_name from op.account_grants g join op.users u on u.id = g.user_id
        where g.account_id = $1 order by u.email`,
      [accountId],
    );
  }

  async replaceGrants(
    tx: Tx,
    userId: string,
    accountIds: string[],
    grantedBy: string,
  ): Promise<{ added: string[]; removed: string[] }> {
    const current = (await this.grantsOf(tx, userId)).map((grant) => grant.account_id);
    const added = accountIds.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !accountIds.includes(id));
    if (removed.length > 0) {
      await tx.query('delete from op.account_grants where user_id = $1 and account_id = any ($2::uuid[])', [
        userId,
        removed,
      ]);
    }
    for (const accountId of added) {
      await tx.query('insert into op.account_grants (user_id, account_id, granted_by) values ($1, $2, $3)', [
        userId,
        accountId,
        grantedBy,
      ]);
    }
    return { added, removed };
  }

  async replaceGrantees(
    tx: Tx,
    accountId: string,
    userIds: string[],
    grantedBy: string,
  ): Promise<{ added: string[]; removed: string[] }> {
    const current = (await this.granteesOf(tx, accountId)).map((grant) => grant.user_id);
    const added = userIds.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !userIds.includes(id));
    if (removed.length > 0) {
      await tx.query('delete from op.account_grants where account_id = $1 and user_id = any ($2::uuid[])', [
        accountId,
        removed,
      ]);
    }
    for (const userId of added) {
      await tx.query('insert into op.account_grants (user_id, account_id, granted_by) values ($1, $2, $3)', [
        userId,
        accountId,
        grantedBy,
      ]);
    }
    return { added, removed };
  }

  // Groups -----------------------------------------------------------------

  groups(tx: Tx): Promise<GroupRecord[]> {
    return this.many<GroupRecord>(tx, 'select * from op.assignment_groups order by name');
  }

  groupById(tx: Tx, id: string): Promise<GroupRecord> {
    return this.one<GroupRecord>(tx, 'group', 'select * from op.assignment_groups where id = $1', [id]);
  }

  insertGroup(
    tx: Tx,
    input: { name: string; description?: string; service_line?: string | null; lead_user_id?: string | null },
  ): Promise<GroupRecord> {
    return this.one<GroupRecord>(
      tx,
      'group',
      `insert into op.assignment_groups (name, description, service_line, lead_user_id) values ($1, coalesce($2, ''), $3, $4) returning *`,
      [input.name, input.description, input.service_line ?? null, input.lead_user_id ?? null],
    );
  }

  updateGroup(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<GroupRecord> {
    return this.updateVersioned<GroupRecord>(tx, 'group', 'op.assignment_groups', id, version, assignments);
  }

  membersOf(
    tx: Tx,
    groupId: string,
  ): Promise<{ user_id: string; email: string; first_name: string; last_name: string }[]> {
    return this.many(
      tx,
      `select m.user_id, u.email, u.first_name, u.last_name from op.group_members m join op.users u on u.id = m.user_id
        where m.group_id = $1 order by u.email`,
      [groupId],
    );
  }

  async replaceMembers(tx: Tx, groupId: string, userIds: string[]): Promise<{ added: string[]; removed: string[] }> {
    const current = (await this.membersOf(tx, groupId)).map((member) => member.user_id);
    const added = userIds.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !userIds.includes(id));
    if (removed.length > 0) {
      await tx.query('delete from op.group_members where group_id = $1 and user_id = any ($2::uuid[])', [
        groupId,
        removed,
      ]);
    }
    for (const userId of added) {
      await tx.query('insert into op.group_members (group_id, user_id) values ($1, $2)', [groupId, userId]);
    }
    return { added, removed };
  }

  /**
   * Open tickets still assigned to people leaving a group (TM-08: "removing
   * a member with open assigned tickets lists them for reassignment"). The
   * query lives here rather than in the ticket repository because the ticket
   * module already depends on this one, so the dependency cannot run the
   * other way. It reads under whatever account binding the caller holds, so
   * an administrator sees the tickets on the accounts granted to them.
   */
  openAssignedTickets(
    tx: Tx,
    userIds: string[],
  ): Promise<
    { id: string; key: string; account_id: string; assignee_id: string; state: string; short_description: string }[]
  > {
    if (userIds.length === 0) return Promise.resolve([]);
    return this.many(
      tx,
      `select id, 'CS' || lpad(number::text, 7, '0') as key, account_id, assignee_id, state, short_description
         from acct.tickets
        where assignee_id = any ($1::text[]) and state not in ('closed', 'cancelled')
        order by account_id, number`,
      [userIds],
    );
  }

  groupsOfUser(tx: Tx, userId: string): Promise<{ group_id: string; name: string }[]> {
    return this.many(
      tx,
      `select m.group_id, g.name from op.group_members m join op.assignment_groups g on g.id = m.group_id where m.user_id = $1`,
      [userId],
    );
  }
}
