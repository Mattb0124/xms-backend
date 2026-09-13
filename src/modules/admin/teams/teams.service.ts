import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { RequestContext } from '../../../common/auth/decorators.js';
import type { Principal } from '../../../common/auth/principal.js';
import { actorOf, AuditService } from '../../../common/audit/audit.service.js';
import { SecurityEventsService } from '../../../common/events/security-events.service.js';
import { UnitOfWork } from '../../../db/unit-of-work.js';
import {
  TEAM_EDITABLE,
  TeamsRepository,
  type TeamAccountRow,
  type TeamMemberRow,
  type TeamRow,
  type TeamSummaryRow,
} from './teams.repository.js';
import type { CreateTeamDto, SetTeamAccountsDto, SetTeamMembersDto, TeamsQueryDto, UpdateTeamDto } from './teams.dto.js';

/**
 * Teams (TM-23). A team groups people and the accounts they are responsible
 * for, which is the unit an account owner belongs to. Operator scope
 * throughout: `uow.operator` rather than `uow.run`, because there is no one
 * account to bind to and the tables carry no account_id.
 *
 * Every mutation writes an operator audit entry and a security event in the
 * same transaction. Nothing here decides routing: that half of TM-23 waits
 * on C-01.
 */
@Injectable()
export class TeamsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly teams: TeamsRepository,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
  ) {}

  list(query: TeamsQueryDto): Promise<TeamSummaryRow[]> {
    return this.uow.operator((tx) => this.teams.list(tx, { status: query.status, limit: Math.min(query.limit ?? 50, 200) }));
  }

  get(id: string): Promise<TeamRow & { members: TeamMemberRow[]; accounts: TeamAccountRow[] }> {
    return this.uow.operator(async (tx) => {
      const team = await this.teams.byId(tx, id);
      // One client, one query at a time: pg refuses concurrent queries on a
      // client, so these are sequential and not a Promise.all.
      const members = await this.teams.members(tx, id);
      const accounts = await this.teams.accounts(tx, id);
      return { ...team, members, accounts };
    });
  }

  async create(principal: Principal, ctx: RequestContext, dto: CreateTeamDto): Promise<TeamRow> {
    return this.uow.operator(async (tx) => {
      if (await this.teams.byName(tx, dto.name)) throw new ConflictException({ code: 'team_name_in_use' });
      if (dto.lead_user_id) await this.assertInternal(tx, [dto.lead_user_id]);
      const team = await this.teams.insert(tx, {
        name: dto.name,
        description: dto.description ?? '',
        leadUserId: dto.lead_user_id ?? null,
      });
      await this.record(tx, principal, ctx, team.id, 'created', {
        name: team.name,
        lead_user_id: team.lead_user_id,
      });
      return team;
    });
  }

  async update(principal: Principal, ctx: RequestContext, id: string, dto: UpdateTeamDto): Promise<TeamRow> {
    return this.uow.operator(async (tx) => {
      const before = await this.teams.byId(tx, id);
      if (dto.name && dto.name.toLowerCase() !== before.name.toLowerCase()) {
        if (await this.teams.byName(tx, dto.name)) throw new ConflictException({ code: 'team_name_in_use' });
      }
      if (dto.lead_user_id) await this.assertInternal(tx, [dto.lead_user_id]);
      const assignments: Record<string, unknown> = {};
      for (const field of TEAM_EDITABLE) {
        if (dto[field] !== undefined) assignments[field] = dto[field];
      }
      const after = await this.teams.update(tx, id, dto.version, assignments);
      const entries = this.audit.diff('team', id, 'admin.team.changed', before as never, after as never, [
        ...TEAM_EDITABLE,
      ]);
      if (entries.length > 0) {
        await this.audit.operator(tx, actorOf(principal), ctx, entries);
        await this.securityEvent(principal, ctx, id, { changed: entries.map((entry) => entry.field) }, tx);
      }
      return after;
    });
  }

  async setMembers(
    principal: Principal,
    ctx: RequestContext,
    id: string,
    dto: SetTeamMembersDto,
  ): Promise<TeamMemberRow[]> {
    return this.uow.operator(async (tx) => {
      await this.teams.byId(tx, id);
      const ids = unique(dto.user_ids);
      await this.assertInternal(tx, ids);
      await this.teams.replaceMembers(tx, id, ids, principal.userId);
      await this.record(tx, principal, ctx, id, 'members_changed', { user_ids: ids });
      return this.teams.members(tx, id);
    });
  }

  async setAccounts(
    principal: Principal,
    ctx: RequestContext,
    id: string,
    dto: SetTeamAccountsDto,
  ): Promise<TeamAccountRow[]> {
    return this.uow.operator(async (tx) => {
      await this.teams.byId(tx, id);
      const ids = unique(dto.account_ids);
      const live = new Set(await this.teams.liveAccountIds(tx, ids));
      const unknown = ids.filter((accountId) => !live.has(accountId));
      if (unknown.length > 0) throw new BadRequestException({ code: 'unknown_accounts', account_ids: unknown });
      // An account belongs to at most one team. Moving it is a decision
      // somebody makes deliberately, so it is refused here rather than
      // silently taken off the other team's book.
      const held = await this.teams.accountsHeldElsewhere(tx, id, ids);
      if (held.length > 0) {
        throw new ConflictException({ code: 'accounts_held_by_another_team', accounts: held });
      }
      await this.teams.replaceAccounts(tx, id, ids, principal.userId);
      await this.record(tx, principal, ctx, id, 'accounts_changed', { account_ids: ids });
      return this.teams.accounts(tx, id);
    });
  }

  /** Only active internal users belong on a team; the realms do not cross. */
  private async assertInternal(tx: Parameters<TeamsRepository['internalUserIds']>[0], ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const allowed = new Set(await this.teams.internalUserIds(tx, ids));
    const refused = ids.filter((id) => !allowed.has(id));
    if (refused.length > 0) throw new BadRequestException({ code: 'not_internal_users', user_ids: refused });
  }

  private async record(
    tx: Parameters<AuditService['operator']>[0],
    principal: Principal,
    ctx: RequestContext,
    teamId: string,
    change: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.operator(tx, actorOf(principal), ctx, [
      {
        entityKind: 'team',
        entityId: teamId,
        eventType: 'admin.team.changed',
        field: change,
        newValue: detail,
      },
    ]);
    await this.securityEvent(principal, ctx, teamId, { change, ...detail }, tx);
  }

  private securityEvent(
    principal: Principal,
    ctx: RequestContext,
    teamId: string,
    attrs: Record<string, unknown>,
    tx: Parameters<SecurityEventsService['write']>[1],
  ): Promise<void> {
    return this.security.write(
      {
        type: 'admin.team.changed',
        outcome: 'success',
        actorKind: 'user',
        actorId: principal.userId,
        actorName: principal.displayName,
        principalKind: principal.kind,
        requestId: ctx.requestId,
        entityKind: 'team',
        entityId: teamId,
        attrs,
      },
      tx,
    );
  }
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
