import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ConflictException } from '@nestjs/common';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { parseTicketKey, TicketsRepository, type TicketRow } from './tickets.repository.js';

/** The parts a person can have in a ticket that are not being assigned it. */
export const PARTICIPANT_ROLES = ['collaborator', 'reviewer', 'observer'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export interface ParticipantRow {
  id: string;
  account_id: string;
  ticket_id: string;
  user_id: string;
  display_name: string;
  role: ParticipantRole;
  status: 'invited' | 'active' | 'declined' | 'left';
  invited_by: string | null;
  invited_by_name: string;
  joined_at: string | null;
  left_at: string | null;
  created_at: string;
  version: number;
}

export class AddParticipantDto {
  @IsString() @MinLength(1) @MaxLength(200) user_id!: string;

  @IsOptional() @IsString() @MaxLength(200) display_name?: string;

  @IsIn(PARTICIPANT_ROLES) role!: ParticipantRole;
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

  byId(tx: Tx, id: string): Promise<ParticipantRow> {
    return this.one<ParticipantRow>(tx, 'participant', 'select * from acct.ticket_participants where id = $1', [id]);
  }

  add(
    tx: Tx,
    input: {
      accountId: string;
      ticketId: string;
      userId: string;
      displayName: string;
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
            (account_id, ticket_id, user_id, display_name, role, status, invited_by, invited_by_name, joined_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, case when $6 = 'active' then now() else null end)
        returning *`,
      [
        input.accountId,
        input.ticketId,
        input.userId,
        input.displayName,
        input.role,
        input.status,
        input.invitedBy,
        input.invitedByName,
      ],
    );
  }

  /** Leaving keeps the row and stamps it, so the history survives. */
  leave(tx: Tx, id: string): Promise<ParticipantRow> {
    return this.one<ParticipantRow>(
      tx,
      'participant',
      `update acct.ticket_participants
          set status = 'left', left_at = now(), version = version + 1
        where id = $1 and status in ('invited', 'active')
        returning *`,
      [id],
    );
  }

  /**
   * How many distinct people had a part, the assignee aside. Somebody who
   * joined, left and came back counts once, which is what "contributor
   * count" means to anyone asking.
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
}

@Injectable()
export class ParticipantsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly participants: ParticipantsRepository,
    private readonly tickets: TicketsRepository,
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
      return { items: rows, contributors: await this.participants.contributorCount(tx, ticket.id) };
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
      if (ticket.assignee_id === dto.user_id) throw new ConflictException({ code: 'assignee_is_not_a_participant' });
      const existing = await this.participants.live(tx, ticket.id, dto.user_id);
      if (existing) throw new ConflictException({ code: 'already_a_participant', role: existing.role });
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
      await this.audit.account(tx, ticket.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'ticket',
          entityId: ticket.id,
          ticketId: ticket.id,
          eventType: 'ticket.participant_added',
          newValue: { user_id: dto.user_id, role: dto.role },
        },
      ]);
      return row;
    });
  }

  remove(principal: Principal, ctx: RequestContext, key: string, id: string) {
    return this.uow.run(principal, async (tx) => {
      const ticket = await this.ticketOf(tx, key);
      const before = await this.participants.byId(tx, id);
      if (before.ticket_id !== ticket.id) throw new ConflictException({ code: 'not_on_this_ticket' });
      const row = await this.participants.leave(tx, id);
      await this.audit.account(tx, ticket.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'ticket',
          entityId: ticket.id,
          ticketId: ticket.id,
          eventType: 'ticket.participant_left',
          oldValue: { user_id: before.user_id, role: before.role },
          newValue: {},
        },
      ]);
      return row;
    });
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
  providers: [ParticipantsRepository, ParticipantsService, TicketsRepository],
  controllers: [ParticipantsController],
  exports: [ParticipantsService, ParticipantsRepository],
})
export class ParticipantsModule {}
