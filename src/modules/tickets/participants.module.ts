import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BadRequestException } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import type { AuditEventType } from '../../contracts/events.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import { parseTicketKey, ticketKey, TicketsRepository, type TicketRow } from './tickets.repository.js';

/** The parts a person can have in a ticket that are not being assigned it. */
export const PARTICIPANT_ROLES = ['collaborator', 'reviewer', 'observer'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

/**
 * Where a part stands. The three ways an invitation can end are three
 * different facts: the invitee said no, the inviter took it back, or
 * somebody who was actually doing the work stepped off it.
 */
export type ParticipantStatus = 'invited' | 'active' | 'declined' | 'withdrawn' | 'left';

export interface ParticipantRow {
  id: string;
  account_id: string;
  ticket_id: string;
  /** Absent on a group invitation nobody has accepted yet. */
  user_id: string | null;
  display_name: string;
  group_id: string | null;
  group_name: string;
  role: ParticipantRole;
  status: ParticipantStatus;
  invited_by: string | null;
  invited_by_name: string;
  responded_at: string | null;
  responded_by: string | null;
  responded_by_name: string;
  decline_reason: string | null;
  joined_at: string | null;
  left_at: string | null;
  created_at: string;
  version: number;
}

/**
 * A participant as a reader sees it. `can_answer` is the server's answer to
 * "is this invitation mine?", because whether somebody is in the group that
 * was asked is knowable here and not in a browser.
 */
export interface ParticipantView extends ParticipantRow {
  can_answer: boolean;
}

export class AddParticipantDto {
  @IsString() @MinLength(1) @MaxLength(200) user_id!: string;

  @IsOptional() @IsString() @MaxLength(200) display_name?: string;

  @IsIn(PARTICIPANT_ROLES) role!: ParticipantRole;
}

/** An invitation names a person or a group, and exactly one of the two. */
export class InviteParticipantDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) user_id?: string;

  @IsOptional() @IsString() @MaxLength(200) display_name?: string;

  @IsOptional() @IsUUID() group_id?: string;

  @IsIn(PARTICIPANT_ROLES) role!: ParticipantRole;
}

export class DeclineInvitationDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

@Injectable()
export class ParticipantsRepository extends RepositoryBase {
  ofTicket(tx: Tx, ticketId: string): Promise<ParticipantRow[]> {
    return this.many<ParticipantRow>(
      tx,
      `select * from acct.ticket_participants where ticket_id = $1 order by created_at`,
      [ticketId],
    );
  }

  live(tx: Tx, ticketId: string, userId: string): Promise<ParticipantRow | undefined> {
    return this.maybeOne<ParticipantRow>(
      tx,
      `select * from acct.ticket_participants
        where ticket_id = $1 and user_id = $2 and status in ('invited', 'active')`,
      [ticketId, userId],
    );
  }

  openGroupInvitation(tx: Tx, ticketId: string, groupId: string): Promise<ParticipantRow | undefined> {
    return this.maybeOne<ParticipantRow>(
      tx,
      `select * from acct.ticket_participants
        where ticket_id = $1 and group_id = $2 and status = 'invited'`,
      [ticketId, groupId],
    );
  }

  byId(tx: Tx, id: string): Promise<ParticipantRow> {
    return this.one<ParticipantRow>(tx, 'participant', 'select * from acct.ticket_participants where id = $1', [id]);
  }

  add(
    tx: Tx,
    input: {
      accountId: string;
      ticketId: string;
      userId: string | null;
      displayName: string;
      groupId?: string | null;
      groupName?: string;
      role: ParticipantRole;
      status: 'invited' | 'active';
      invitedBy: string;
      invitedByName: string;
    },
  ): Promise<ParticipantRow> {
    return this.one<ParticipantRow>(
      tx,
      'participant',
      `insert into acct.ticket_participants
            (account_id, ticket_id, user_id, display_name, group_id, group_name,
             role, status, invited_by, invited_by_name, joined_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, case when $8 = 'active' then now() else null end)
        returning *`,
      [
        input.accountId,
        input.ticketId,
        input.userId,
        input.displayName,
        input.groupId ?? null,
        input.groupName ?? '',
        input.role,
        input.status,
        input.invitedBy,
        input.invitedByName,
      ],
    );
  }

  /**
   * Accepting binds the person to the invitation. A group invitation keeps
   * the group it was addressed to, so the record still says who was asked.
   */
  accept(tx: Tx, id: string, userId: string, displayName: string): Promise<ParticipantRow> {
    return this.one<ParticipantRow>(
      tx,
      'participant',
      `update acct.ticket_participants
          set status = 'active',
              user_id = $2,
              display_name = case when display_name = '' then $3 else display_name end,
              joined_at = now(),
              responded_at = now(),
              responded_by = $2,
              responded_by_name = $3,
              version = version + 1
        where id = $1 and status = 'invited'
        returning *`,
      [id, userId, displayName],
    );
  }

  decline(tx: Tx, id: string, userId: string, displayName: string, reason: string | null): Promise<ParticipantRow> {
    return this.one<ParticipantRow>(
      tx,
      'participant',
      `update acct.ticket_participants
          set status = 'declined',
              responded_at = now(),
              responded_by = $2,
              responded_by_name = $3,
              decline_reason = $4,
              version = version + 1
        where id = $1 and status = 'invited'
        returning *`,
      [id, userId, displayName, reason],
    );
  }

  /** The inviter taking the ask back, which is not the invitee saying no. */
  withdraw(tx: Tx, id: string): Promise<ParticipantRow> {
    return this.one<ParticipantRow>(
      tx,
      'participant',
      `update acct.ticket_participants
          set status = 'withdrawn', version = version + 1
        where id = $1 and status = 'invited'
        returning *`,
      [id],
    );
  }

  /** Leaving keeps the row and stamps it, so the history survives. */
  leave(tx: Tx, id: string): Promise<ParticipantRow> {
    return this.one<ParticipantRow>(
      tx,
      'participant',
      `update acct.ticket_participants
          set status = 'left', left_at = now(), version = version + 1
        where id = $1 and status = 'active'
        returning *`,
      [id],
    );
  }

  /**
   * How many distinct people had a part, the assignee aside. Somebody who
   * joined, left and came back counts once, which is what "contributor
   * count" means to anyone asking. An invitation nobody accepted is not a
   * contributor.
   */
  contributorCount(tx: Tx, ticketId: string): Promise<number> {
    return this.one<{ n: number }>(
      tx,
      'participant count',
      `select count(distinct user_id)::int as n from acct.ticket_participants
        where ticket_id = $1 and status in ('active', 'left')`,
      [ticketId],
    ).then((row) => row.n);
  }

  group(tx: Tx, groupId: string): Promise<{ id: string; name: string } | undefined> {
    return this.maybeOne(tx, `select id, name from op.assignment_groups where id = $1 and status = 'active'`, [
      groupId,
    ]);
  }

  /** The groups a person is in, so a whole list can be judged in one query. */
  groupsOfUser(tx: Tx, userId: string): Promise<string[]> {
    return this.many<{ group_id: string }>(
      tx,
      'select group_id::text as group_id from op.group_members where user_id::text = $1',
      [userId],
    ).then((rows) => rows.map((row) => row.group_id));
  }

  /** The members of a group, as the text user ids a ticket names people by. */
  groupMembers(tx: Tx, groupId: string): Promise<string[]> {
    return this.many<{ user_id: string }>(
      tx,
      'select user_id::text as user_id from op.group_members where group_id = $1',
      [groupId],
    ).then((rows) => rows.map((row) => row.user_id));
  }
}

@Injectable()
export class ParticipantsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly participants: ParticipantsRepository,
    private readonly tickets: TicketsRepository,
    private readonly notifications: NotificationsRepository,
    private readonly audit: AuditService,
  ) {}

  /** A ticket by its key or its id, the way every other route accepts one. */
  private async ticketOf(tx: Tx, key: string): Promise<TicketRow> {
    const number = parseTicketKey(key);
    return number ? this.tickets.byNumber(tx, number) : this.tickets.byId(tx, key);
  }

  list(principal: Principal, key: string) {
    return this.uow.run(principal, async (tx) => {
      const ticket = await this.ticketOf(tx, key);
      const rows = await this.participants.ofTicket(tx, ticket.id);
      const mine = rows.some((row) => row.status === 'invited' && row.group_id)
        ? new Set(await this.participants.groupsOfUser(tx, principal.userId))
        : new Set<string>();
      const items: ParticipantView[] = rows.map((row) => ({
        ...row,
        can_answer:
          row.status === 'invited' &&
          (row.user_id ? row.user_id === principal.userId : Boolean(row.group_id && mine.has(row.group_id))),
      }));
      return { items, contributors: await this.participants.contributorCount(tx, ticket.id) };
    });
  }

  /**
   * Puts somebody on the ticket. The assignee is not written here: the ticket
   * owns that, and a second place to say who owns the work is a second place
   * for it to be wrong.
   */
  add(principal: Principal, ctx: RequestContext, key: string, dto: AddParticipantDto) {
    return this.uow.run(principal, async (tx) => {
      const ticket = await this.ticketOf(tx, key);
      await this.refuseAssigneeOrDuplicate(tx, ticket, dto.user_id);
      const row = await this.participants.add(tx, {
        accountId: ticket.account_id,
        ticketId: ticket.id,
        userId: dto.user_id,
        displayName: dto.display_name ?? '',
        role: dto.role,
        status: 'active',
        invitedBy: principal.userId,
        invitedByName: principal.displayName ?? '',
      });
      await this.record(tx, ticket, principal, ctx, 'ticket.participant_added', {
        user_id: dto.user_id,
        role: dto.role,
      });
      return row;
    });
  }

  /**
   * Asks somebody onto the ticket without handing it to them (TM-22). The
   * assignee is untouched by every path through this method, which is the
   * whole point: the alternative people reach for today is a transfer they
   * never get back.
   */
  invite(principal: Principal, ctx: RequestContext, key: string, dto: InviteParticipantDto) {
    return this.uow.run(principal, async (tx) => {
      if ((dto.user_id ? 1 : 0) + (dto.group_id ? 1 : 0) !== 1)
        throw new BadRequestException({ code: 'invite_a_person_or_a_group' });
      const ticket = await this.ticketOf(tx, key);
      const notify: string[] = [];
      let row: ParticipantRow;
      if (dto.user_id) {
        await this.refuseAssigneeOrDuplicate(tx, ticket, dto.user_id);
        row = await this.participants.add(tx, {
          accountId: ticket.account_id,
          ticketId: ticket.id,
          userId: dto.user_id,
          displayName: dto.display_name ?? '',
          role: dto.role,
          status: 'invited',
          invitedBy: principal.userId,
          invitedByName: principal.displayName ?? '',
        });
        notify.push(dto.user_id);
      } else {
        const group = await this.participants.group(tx, dto.group_id as string);
        if (!group) throw new ConflictException({ code: 'group_not_found' });
        if (await this.participants.openGroupInvitation(tx, ticket.id, group.id))
          throw new ConflictException({ code: 'group_already_invited' });
        row = await this.participants.add(tx, {
          accountId: ticket.account_id,
          ticketId: ticket.id,
          userId: null,
          displayName: '',
          groupId: group.id,
          groupName: group.name,
          role: dto.role,
          status: 'invited',
          invitedBy: principal.userId,
          invitedByName: principal.displayName ?? '',
        });
        notify.push(...(await this.participants.groupMembers(tx, group.id)));
      }
      await this.tell(tx, ticket, notify, principal, {
        type: 'ticket.participant_invited',
        title: `${principal.displayName || 'Somebody'} asked you onto ${ticketKey(ticket.number)} as ${dto.role}`,
        collapseKey: `invitation:${row.id}`,
      });
      await this.record(tx, ticket, principal, ctx, 'ticket.participant_invited', {
        user_id: dto.user_id ?? null,
        group_id: dto.group_id ?? null,
        role: dto.role,
      });
      return row;
    });
  }

  /** Saying yes. A group's invitation is accepted by one of its members. */
  accept(principal: Principal, ctx: RequestContext, key: string, id: string) {
    return this.uow.run(principal, async (tx) => {
      const ticket = await this.ticketOf(tx, key);
      const before = await this.mine(tx, ticket, id, principal);
      if (before.group_id) await this.refuseAssigneeOrDuplicate(tx, ticket, principal.userId);
      const row = await this.participants.accept(tx, id, principal.userId, principal.displayName ?? '');
      await this.answered(tx, ticket, before, principal, 'accepted');
      await this.record(tx, ticket, principal, ctx, 'ticket.participant_accepted', {
        user_id: principal.userId,
        group_id: before.group_id,
        role: before.role,
      });
      return row;
    });
  }

  /** Saying no, which is a fact worth keeping and not a row worth deleting. */
  decline(principal: Principal, ctx: RequestContext, key: string, id: string, dto: DeclineInvitationDto) {
    return this.uow.run(principal, async (tx) => {
      const ticket = await this.ticketOf(tx, key);
      const before = await this.mine(tx, ticket, id, principal);
      const row = await this.participants.decline(
        tx,
        id,
        principal.userId,
        principal.displayName ?? '',
        dto.reason?.trim() || null,
      );
      await this.answered(tx, ticket, before, principal, 'declined');
      await this.record(tx, ticket, principal, ctx, 'ticket.participant_declined', {
        user_id: before.user_id,
        group_id: before.group_id,
        reason: row.decline_reason,
      });
      return row;
    });
  }

  /**
   * Taking somebody off the ticket. An invitation nobody answered is
   * withdrawn; a person who was doing the work leaves. The two are different
   * things and the record says which one happened.
   */
  remove(principal: Principal, ctx: RequestContext, key: string, id: string) {
    return this.uow.run(principal, async (tx) => {
      const ticket = await this.ticketOf(tx, key);
      const before = await this.participants.byId(tx, id);
      if (before.ticket_id !== ticket.id) throw new ConflictException({ code: 'not_on_this_ticket' });
      const invited = before.status === 'invited';
      const row = invited ? await this.participants.withdraw(tx, id) : await this.participants.leave(tx, id);
      await this.record(
        tx,
        ticket,
        principal,
        ctx,
        invited ? 'ticket.participant_withdrawn' : 'ticket.participant_left',
        {},
        { user_id: before.user_id, group_id: before.group_id, role: before.role },
      );
      return row;
    });
  }

  /**
   * The ticket owns its assignee, and nobody is on it twice. Both refusals
   * belong to every path that puts a person on a ticket.
   */
  private async refuseAssigneeOrDuplicate(tx: Tx, ticket: TicketRow, userId: string): Promise<void> {
    if (ticket.assignee_id === userId) throw new ConflictException({ code: 'assignee_is_not_a_participant' });
    const existing = await this.participants.live(tx, ticket.id, userId);
    if (existing) throw new ConflictException({ code: 'already_a_participant', role: existing.role });
  }

  /**
   * An invitation is answered by the person it was addressed to, or by a
   * member of the group it was addressed to. Nobody answers for anybody else.
   */
  private async mine(tx: Tx, ticket: TicketRow, id: string, principal: Principal): Promise<ParticipantRow> {
    const row = await this.participants.byId(tx, id);
    if (row.ticket_id !== ticket.id) throw new ConflictException({ code: 'not_on_this_ticket' });
    if (row.status !== 'invited') throw new ConflictException({ code: 'invitation_not_open' });
    if (row.user_id && row.user_id !== principal.userId) throw new ForbiddenException({ code: 'not_your_invitation' });
    if (row.group_id) {
      const members = await this.participants.groupMembers(tx, row.group_id);
      if (!members.includes(principal.userId)) throw new ForbiddenException({ code: 'not_your_invitation' });
    }
    return row;
  }

  /** The person who asked hears the answer, unless they answered it. */
  private answered(
    tx: Tx,
    ticket: TicketRow,
    before: ParticipantRow,
    principal: Principal,
    verb: 'accepted' | 'declined',
  ): Promise<void> {
    if (!before.invited_by || before.invited_by === principal.userId) return Promise.resolve();
    const key = ticketKey(ticket.number);
    const who = principal.displayName || 'Somebody';
    return this.tell(tx, ticket, [before.invited_by], principal, {
      type: 'ticket.participant_responded',
      title: before.group_name
        ? `${who} ${verb} for ${before.group_name} on ${key}`
        : `${who} ${verb} your invitation on ${key}`,
      collapseKey: `invitation-answer:${before.id}`,
    });
  }

  private async tell(
    tx: Tx,
    ticket: TicketRow,
    recipients: string[],
    principal: Principal,
    note: { type: string; title: string; collapseKey: string },
  ): Promise<void> {
    const key = ticketKey(ticket.number);
    for (const recipientId of new Set(recipients)) {
      if (!recipientId || recipientId === principal.userId) continue;
      await this.notifications.upsert(tx, {
        accountId: ticket.account_id,
        recipientId,
        type: note.type,
        title: note.title,
        body: ticket.short_description,
        targetKind: 'ticket',
        targetId: ticket.id,
        link: `/cases/${key}`,
        collapseKey: note.collapseKey,
      });
    }
  }

  private record(
    tx: Tx,
    ticket: TicketRow,
    principal: Principal,
    ctx: RequestContext,
    eventType: AuditEventType,
    newValue: Record<string, unknown>,
    oldValue?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.audit.account(tx, ticket.account_id, actorOf(principal), ctx, [
      {
        entityKind: 'ticket',
        entityId: ticket.id,
        ticketId: ticket.id,
        eventType,
        ...(oldValue ? { oldValue } : {}),
        newValue,
      },
    ]);
  }
}

@ApiTags('tickets')
@ApiBearerAuth()
@Controller('tickets')
export class ParticipantsController {
  constructor(private readonly participants: ParticipantsService) {}

  @Get(':key/participants')
  @RequirePermission('tickets:view')
  list(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.participants.list(principal, key);
  }

  @Post(':key/participants')
  @RequirePermission('tickets:work')
  add(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: AddParticipantDto,
  ) {
    return this.participants.add(principal, ctx, key, dto);
  }

  @Post(':key/participants/invitations')
  @RequirePermission('tickets:work')
  invite(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: InviteParticipantDto,
  ) {
    return this.participants.invite(principal, ctx, key, dto);
  }

  /**
   * Answering is the invitee's own act, so it needs no more permission than
   * reading the ticket: the authority to involve them was spent when the
   * invitation was sent, and the service checks the answer is theirs to give.
   */
  @Post(':key/participants/:id/accept')
  @HttpCode(200)
  @RequirePermission('tickets:view')
  accept(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Param('id') id: string,
  ) {
    return this.participants.accept(principal, ctx, key, id);
  }

  @Post(':key/participants/:id/decline')
  @HttpCode(200)
  @RequirePermission('tickets:view')
  decline(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Param('id') id: string,
    @Body() dto: DeclineInvitationDto,
  ) {
    return this.participants.decline(principal, ctx, key, id, dto);
  }

  @Delete(':key/participants/:id')
  @HttpCode(200)
  @RequirePermission('tickets:work')
  remove(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Param('id') id: string,
  ) {
    return this.participants.remove(principal, ctx, key, id);
  }
}

@Module({
  providers: [ParticipantsRepository, ParticipantsService, TicketsRepository, NotificationsRepository],
  controllers: [ParticipantsController],
  exports: [ParticipantsService, ParticipantsRepository],
})
export class ParticipantsModule {}
