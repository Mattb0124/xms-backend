import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { RequestContext } from '../../../common/auth/decorators.js';
import type { Principal } from '../../../common/auth/principal.js';
import { actorOf, AuditService } from '../../../common/audit/audit.service.js';
import { ClerkAdminClient } from '../../../common/clerk/clerk-admin.js';
import { SecurityEventsService, type SecurityEvent } from '../../../common/events/security-events.service.js';
import { catalogOf, isPermission } from '../../../contracts/permissions.js';
import type { Tx } from '../../../db/repository.base.js';
import { UnitOfWork } from '../../../db/unit-of-work.js';
import { assertNotLastAdmin, LastAdministratorError } from '../../../domain/identity/last-admin.js';
import { AccountsRepository } from '../accounts/accounts.repository.js';
import type {
  CreateGroupDto,
  CreateRoleDto,
  InviteUserDto,
  ReplaceGranteesDto,
  ReplaceGrantsDto,
  ReplaceMembersDto,
  ReplaceRolesDto,
  UpdateGroupDto,
  UpdateRoleDto,
  UpdateUserDto,
  UsersQueryDto,
} from './users.dto.js';
import {
  USER_EDITABLE,
  UsersRepository,
  type GroupRecord,
  type RoleRecord,
  type UserRecord,
} from './users.repository.js';

/**
 * Users, roles, grants and groups (Accounts & Administration technical 3.3,
 * 4). Reconcile-the-whole-set semantics for roles, grants and members (the
 * studio's solution_access_grants pattern); the last administrator can never
 * be removed; every change writes an operator audit event and the admin
 * security event in the same transaction.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly users: UsersRepository,
    private readonly accounts: AccountsRepository,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
    private readonly clerk: ClerkAdminClient,
  ) {}

  list(query: UsersQueryDto): Promise<UserRecord[]> {
    return this.uow.operator((tx) =>
      this.users.list(tx, {
        kind: query.kind,
        assignable: query.assignable,
        limit: Math.min(query.limit ?? 50, 200),
        cursor: query.cursor,
      }),
    );
  }

  /** Pickers: active internal users only, no profile detail beyond the name. */
  assignable(): Promise<Pick<UserRecord, 'id' | 'email' | 'first_name' | 'last_name'>[]> {
    return this.uow.operator(async (tx) =>
      (await this.users.list(tx, { assignable: true, limit: 200 })).map((user) => ({
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
      })),
    );
  }

  async get(id: string): Promise<UserRecord & { roles: unknown[]; grants: unknown[]; groups: unknown[] }> {
    return this.uow.operator(async (tx) => {
      const user = await this.users.byId(tx, id);
      // One client, one query at a time (pg refuses concurrent queries on a client from version 9).
      const roles = await this.users.assignmentsOf(tx, id);
      const grants = await this.users.grantsOf(tx, id);
      const groups = await this.users.groupsOfUser(tx, id);
      return { ...user, roles, grants, groups };
    });
  }

  async invite(
    principal: Principal,
    ctx: RequestContext,
    dto: InviteUserDto,
    kind: 'internal' | 'portal',
    accountId?: string,
  ): Promise<UserRecord> {
    const email = dto.email.toLowerCase();
    const user = await this.uow.operator(async (tx) => {
      if (await this.users.byEmail(tx, email)) throw new ConflictException({ code: 'email_in_use' });
      if (kind === 'portal' && !accountId) throw new BadRequestException({ code: 'account_required' });
      if (accountId) await this.accounts.byId(tx, accountId);
      const created = await this.users.insert(tx, {
        kind,
        email,
        first_name: dto.first_name,
        last_name: dto.last_name,
        time_zone: dto.time_zone,
        account_id: kind === 'portal' ? accountId : null,
      });
      if (dto.role_ids?.length) {
        const roles = await this.validRoles(tx, dto.role_ids, kind === 'portal' ? 'portal' : 'operator');
        await this.users.replaceAssignments(
          tx,
          created.id,
          roles.map((role) => ({ roleId: role.id, accountId: null })),
        );
      }
      if (kind === 'portal' && accountId) {
        await this.users.replaceGrants(tx, created.id, [accountId], principal.userId);
      } else if (dto.account_ids?.length) {
        await this.users.replaceGrants(tx, created.id, dto.account_ids, principal.userId);
      }
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'user',
          entityId: created.id,
          eventType: 'created',
          newValue: { email, kind, roles: dto.role_ids ?? [], accounts: dto.account_ids ?? [] },
        },
      ]);
      await this.security.write(
        this.adminEvent(principal, ctx, 'admin.user.created', 'user', created.id, { email, kind }, accountId),
        tx,
      );
      return created;
    });
    await this.clerk.createInvitation(email);
    await this.uow.operator((tx) =>
      this.security.write(
        this.adminEvent(principal, ctx, 'auth.invite.sent', 'user', user.id, { email }, accountId),
        tx,
      ),
    );
    return user;
  }

  async update(principal: Principal, ctx: RequestContext, id: string, dto: UpdateUserDto): Promise<UserRecord> {
    return this.uow.operator(async (tx) => {
      const before = await this.users.byId(tx, id);
      const assignments: Record<string, unknown> = {};
      for (const field of USER_EDITABLE) if (dto[field] !== undefined) assignments[field] = dto[field];
      if (dto.status && dto.status !== before.status) {
        if (dto.status === 'deactivated') await this.assertNotLastAdminAfterRemoving(tx, id);
        assignments.status = dto.status;
      }
      const after = await this.users.update(tx, id, dto.version, assignments);
      const entries = this.audit.diff('user', id, 'updated', before as never, after as never, [
        ...USER_EDITABLE,
        'status',
      ]);
      if (entries.length > 0) await this.audit.operator(tx, actorOf(principal), ctx, entries);
      if (before.status !== after.status && after.status === 'deactivated') {
        await this.security.write(this.adminEvent(principal, ctx, 'admin.user.deactivated', 'user', id, {}), tx);
        if (after.clerk_user_id) await this.clerk.revokeSessions(after.clerk_user_id);
      }
      return after;
    });
  }

  async replaceRoles(principal: Principal, ctx: RequestContext, id: string, dto: ReplaceRolesDto): Promise<unknown[]> {
    return this.uow.operator(async (tx) => {
      const user = await this.users.byId(tx, id);
      const catalog = user.kind === 'portal' ? 'portal' : 'operator';
      const roles = await this.validRoles(
        tx,
        dto.roles.map((role) => role.role_id),
        catalog,
      );
      for (const assignment of dto.roles) {
        if (assignment.account_id) await this.accounts.byId(tx, assignment.account_id);
      }
      const before = await this.users.assignmentsOf(tx, id);
      const keepsAdmin = roles.some((role) => role.permissions.includes('admin:users'));
      if (!keepsAdmin) await this.assertNotLastAdminAfterRemoving(tx, id);
      await this.users.replaceAssignments(
        tx,
        id,
        dto.roles.map((role) => ({ roleId: role.role_id, accountId: role.account_id ?? null })),
      );
      const after = await this.users.assignmentsOf(tx, id);
      await this.audit.operator(tx, actorOf(principal), ctx, [
        { entityKind: 'user', entityId: id, eventType: 'updated', field: 'roles', oldValue: before, newValue: after },
      ]);
      await this.security.write(
        this.adminEvent(principal, ctx, 'admin.user.role_changed', 'user', id, {
          roles: after.map((role) => role.name),
        }),
        tx,
      );
      return after;
    });
  }

  async replaceGrants(
    principal: Principal,
    ctx: RequestContext,
    id: string,
    dto: ReplaceGrantsDto,
  ): Promise<unknown[]> {
    return this.uow.operator(async (tx) => {
      const user = await this.users.byId(tx, id);
      if (user.kind === 'portal') throw new ConflictException({ code: 'portal_user_grants_fixed' });
      for (const accountId of dto.account_ids) await this.accounts.byId(tx, accountId);
      const change = await this.users.replaceGrants(tx, id, dto.account_ids, principal.userId);
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'user',
          entityId: id,
          eventType: 'updated',
          field: 'grants',
          oldValue: change.removed,
          newValue: change.added,
        },
      ]);
      await this.security.write(this.adminEvent(principal, ctx, 'admin.user.grants_changed', 'user', id, change), tx);
      return this.users.grantsOf(tx, id);
    });
  }

  async replaceGrantees(
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    dto: ReplaceGranteesDto,
  ): Promise<unknown[]> {
    return this.uow.operator(async (tx) => {
      await this.accounts.byId(tx, accountId);
      for (const userId of dto.user_ids) {
        const user = await this.users.byId(tx, userId);
        if (user.kind !== 'internal') throw new ConflictException({ code: 'internal_users_only', userId });
      }
      const change = await this.users.replaceGrantees(tx, accountId, dto.user_ids, principal.userId);
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'account',
          entityId: accountId,
          eventType: 'updated',
          field: 'grantees',
          oldValue: change.removed,
          newValue: change.added,
        },
      ]);
      await this.security.write(
        this.adminEvent(principal, ctx, 'admin.user.grants_changed', 'account', accountId, change, accountId),
        tx,
      );
      return this.users.granteesOf(tx, accountId);
    });
  }

  grantees(accountId: string): Promise<unknown[]> {
    return this.uow.operator((tx) => this.users.granteesOf(tx, accountId));
  }

  portalUsers(accountId: string): Promise<UserRecord[]> {
    return this.uow.operator((tx) => this.users.list(tx, { kind: 'portal', accountId, limit: 200 }));
  }

  // Roles ------------------------------------------------------------------

  roles(catalog?: string): Promise<RoleRecord[]> {
    return this.uow.operator((tx) => this.users.roles(tx, catalog));
  }

  role(id: string): Promise<RoleRecord> {
    return this.uow.operator((tx) => this.users.roleById(tx, id));
  }

  async createRole(principal: Principal, ctx: RequestContext, dto: CreateRoleDto): Promise<RoleRecord> {
    this.assertPermissionsInCatalog(dto.permissions, dto.catalog);
    return this.uow.operator(async (tx) => {
      const role = await this.users.insertRole(tx, dto);
      await this.audit.operator(tx, actorOf(principal), ctx, [
        { entityKind: 'role', entityId: role.id, eventType: 'created', newValue: dto },
      ]);
      await this.security.write(
        this.adminEvent(principal, ctx, 'admin.role.changed', 'role', role.id, { name: role.name }),
        tx,
      );
      return role;
    });
  }

  async updateRole(principal: Principal, ctx: RequestContext, id: string, dto: UpdateRoleDto): Promise<RoleRecord> {
    return this.uow.operator(async (tx) => {
      const before = await this.users.roleById(tx, id);
      if (before.is_system && (dto.name || dto.status === 'retired'))
        throw new ConflictException({ code: 'system_role_fixed' });
      if (dto.permissions) this.assertPermissionsInCatalog(dto.permissions, before.catalog);
      const assignments: Record<string, unknown> = {};
      for (const field of ['name', 'description', 'permissions', 'status'] as const)
        if (dto[field] !== undefined) assignments[field] = dto[field];
      const losesAdmin =
        before.permissions.includes('admin:users') && dto.permissions && !dto.permissions.includes('admin:users');
      if (losesAdmin || dto.status === 'retired') {
        const admins = await this.users.administrators(tx);
        const holders = (await this.users.roles(tx, 'operator')).filter(
          (role) => role.id !== id && role.permissions.includes('admin:users'),
        );
        if (admins.length > 0 && holders.length === 0) throw new LastAdministratorError();
      }
      const after = await this.users.updateRole(tx, id, dto.version, assignments);
      const entries = this.audit.diff('role', id, 'updated', before as never, after as never, [
        'name',
        'description',
        'permissions',
        'status',
      ]);
      if (entries.length > 0) await this.audit.operator(tx, actorOf(principal), ctx, entries);
      await this.security.write(
        this.adminEvent(principal, ctx, 'admin.role.changed', 'role', id, {
          fields: entries.map((entry) => entry.field),
        }),
        tx,
      );
      return after;
    });
  }

  // Groups -----------------------------------------------------------------

  groups(): Promise<GroupRecord[]> {
    return this.uow.operator((tx) => this.users.groups(tx));
  }

  async group(id: string): Promise<GroupRecord & { members: unknown[] }> {
    return this.uow.operator(async (tx) => ({
      ...(await this.users.groupById(tx, id)),
      members: await this.users.membersOf(tx, id),
    }));
  }

  async createGroup(principal: Principal, ctx: RequestContext, dto: CreateGroupDto): Promise<GroupRecord> {
    return this.uow.operator(async (tx) => {
      if (dto.lead_user_id) await this.users.byId(tx, dto.lead_user_id);
      const group = await this.users.insertGroup(tx, dto);
      await this.audit.operator(tx, actorOf(principal), ctx, [
        { entityKind: 'group', entityId: group.id, eventType: 'created', newValue: dto },
      ]);
      await this.security.write(
        this.adminEvent(principal, ctx, 'admin.group.changed', 'group', group.id, { name: group.name }),
        tx,
      );
      return group;
    });
  }

  async updateGroup(principal: Principal, ctx: RequestContext, id: string, dto: UpdateGroupDto): Promise<GroupRecord> {
    return this.uow.operator(async (tx) => {
      const before = await this.users.groupById(tx, id);
      const assignments: Record<string, unknown> = {};
      for (const field of ['name', 'description', 'service_line', 'lead_user_id', 'status'] as const)
        if (dto[field] !== undefined) assignments[field] = dto[field];
      const after = await this.users.updateGroup(tx, id, dto.version, assignments);
      const entries = this.audit.diff('group', id, 'updated', before as never, after as never, [
        'name',
        'description',
        'service_line',
        'lead_user_id',
        'status',
      ]);
      if (entries.length > 0) await this.audit.operator(tx, actorOf(principal), ctx, entries);
      return after;
    });
  }

  /**
   * Reconciles the membership and answers with the members plus the work the
   * people leaving still hold: "removing a member with open assigned tickets
   * lists them for reassignment" (Accounts & Administration functional 5.6).
   * The removal is not blocked, because a person may leave a team mid-flight;
   * the screen is told what has to move.
   */
  async replaceMembers(
    principal: Principal,
    ctx: RequestContext,
    id: string,
    dto: ReplaceMembersDto,
  ): Promise<{ members: unknown[]; reassign: unknown[] }> {
    const result = await this.uow.operator(async (tx) => {
      await this.users.groupById(tx, id);
      for (const userId of dto.user_ids) {
        const user = await this.users.byId(tx, userId);
        if (user.kind !== 'internal') throw new ConflictException({ code: 'internal_users_only', userId });
      }
      const change = await this.users.replaceMembers(tx, id, dto.user_ids);
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'group',
          entityId: id,
          eventType: 'updated',
          field: 'members',
          oldValue: change.removed,
          newValue: change.added,
        },
      ]);
      await this.security.write(this.adminEvent(principal, ctx, 'admin.group.changed', 'group', id, change), tx);
      return { members: await this.users.membersOf(tx, id), removed: change.removed };
    });
    // Tickets are account-scoped, so the listing runs under the principal's
    // own binding rather than the operator scope the membership write uses.
    const reassign = await this.uow.run(principal, (tx) => this.users.openAssignedTickets(tx, result.removed));
    return { members: result.members, reassign };
  }

  // Helpers ----------------------------------------------------------------

  private async validRoles(tx: Tx, ids: string[], catalog: 'operator' | 'portal'): Promise<RoleRecord[]> {
    const roles: RoleRecord[] = [];
    for (const id of ids) {
      const role = await this.users.roleById(tx, id);
      if (role.catalog !== catalog || role.status !== 'active')
        throw new ConflictException({ code: 'role_not_applicable', roleId: id });
      roles.push(role);
    }
    return roles;
  }

  private assertPermissionsInCatalog(permissions: string[], catalog: 'operator' | 'portal'): void {
    const bad = permissions.filter((key) => !isPermission(key) || catalogOf(key) !== catalog);
    if (bad.length > 0) throw new BadRequestException({ code: 'unknown_permissions', permissions: bad });
  }

  private async assertNotLastAdminAfterRemoving(tx: Tx, userId: string): Promise<void> {
    const admins = await this.users.administrators(tx);
    assertNotLastAdmin(
      admins.map((admin) => ({ userId: admin.user_id, active: admin.user_id !== userId, isAdministrator: true })),
    );
  }

  private adminEvent(
    principal: Principal,
    ctx: RequestContext,
    type: SecurityEvent['type'],
    entityKind: string,
    entityId: string,
    attrs: Record<string, unknown>,
    accountId?: string,
  ): SecurityEvent {
    return {
      type,
      outcome: 'success',
      accountId: accountId ?? null,
      actorKind: 'user',
      actorId: principal.userId,
      actorName: principal.displayName,
      principalKind: principal.kind,
      requestId: ctx.requestId,
      entityKind,
      entityId,
      attrs,
    };
  }
}
