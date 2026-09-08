import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import type { Principal } from '../../common/auth/principal.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import {
  freezeAt,
  freezeProblems,
  insideWindow,
  spanOf,
  type ChangeWindow,
  type FreezeWindow,
  type Span,
} from '../../domain/tickets/change-window.js';

/**
 * Projects and change windows (TM-10, TM-18; Ticket Management functional
 * 5.9 and 5.13, technical 2.4 and 4). A group is a named container with a
 * schedule that a ticket tree belongs to; a change window additionally
 * carries the freeze spans during which nothing may be scheduled.
 *
 * Membership is the ticket's own `ticket_group_id`, set through
 * PATCH /v1/tickets/{key} like any other property, so the ticket service
 * stays the only writer of ticket rows and there is one record of the fact.
 * This module owns the group record, the change calendar and the answer to
 * "is this instant inside a window".
 */
export const GROUP_KINDS = ['project', 'change_window'] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

export const GROUP_STATUSES = ['planned', 'active', 'closed', 'cancelled'] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];

export interface TicketGroupRow {
  id: string;
  account_id: string;
  kind: GroupKind;
  name: string;
  description: string;
  owner_user_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  freeze_windows: FreezeWindow[];
  status: GroupStatus;
  created_at: string;
  updated_at: string;
  version: number;
}

/** The row as the pure rules see it. */
export function toChangeWindow(row: TicketGroupRow): ChangeWindow {
  return {
    id: row.id,
    name: row.name,
    startsAt: row.starts_at ? new Date(row.starts_at) : null,
    endsAt: row.ends_at ? new Date(row.ends_at) : null,
    freezeWindows: row.freeze_windows ?? [],
    status: row.status,
  };
}

@Injectable()
export class TicketGroupsRepository extends RepositoryBase {
  byId(tx: Tx, id: string): Promise<TicketGroupRow> {
    return this.one<TicketGroupRow>(tx, 'ticket_group', 'select * from acct.ticket_groups where id = $1', [id]);
  }

  list(tx: Tx, filters: { accountIds: string[]; kind?: GroupKind; status?: GroupStatus }): Promise<TicketGroupRow[]> {
    return this.many<TicketGroupRow>(
      tx,
      `select * from acct.ticket_groups
        where account_id = any ($1::uuid[])
          and ($2::text is null or kind = $2)
          and ($3::text is null or status = $3)
        order by coalesce(starts_at, created_at) desc, name`,
      [filters.accountIds, filters.kind ?? null, filters.status ?? null],
    );
  }

  /** Change windows overlapping a range, for the calendar (functional 5.13). */
  overlapping(tx: Tx, accountIds: string[], from: string, to: string): Promise<TicketGroupRow[]> {
    return this.many<TicketGroupRow>(
      tx,
      `select * from acct.ticket_groups
        where account_id = any ($1::uuid[]) and kind = 'change_window' and status <> 'cancelled'
          and starts_at is not null and ends_at is not null
          and starts_at < $3::timestamptz and ends_at > $2::timestamptz
        order by starts_at`,
      [accountIds, from, to],
    );
  }

  /** Windows holding an instant, whatever their account within the binding. */
  covering(tx: Tx, accountId: string, at: string): Promise<TicketGroupRow[]> {
    return this.many<TicketGroupRow>(
      tx,
      `select * from acct.ticket_groups
        where account_id = $1 and kind = 'change_window' and status <> 'cancelled'
          and starts_at is not null and ends_at is not null
          and starts_at <= $2::timestamptz and ends_at > $2::timestamptz
        order by starts_at`,
      [accountId, at],
    );
  }

  ticketsOf(
    tx: Tx,
    groupId: string,
  ): Promise<{ id: string; key: string; type: string; state: string; priority: string; short_description: string }[]> {
    return this.many(
      tx,
      `select id, 'CS' || lpad(number::text, 7, '0') as key, type, state, priority, short_description
         from acct.tickets where ticket_group_id = $1 order by number`,
      [groupId],
    );
  }

  /**
   * Other changes already scheduled on the same configuration item inside a
   * window that overlaps this one (TM-18). A change in a state before
   * Scheduled has not claimed the item yet, and a terminal one has released
   * it, so only the states in between count.
   */
  conflictsOnItem(
    tx: Tx,
    accountId: string,
    configurationItemId: string,
    excludeTicketId: string,
    span: Span,
  ): Promise<{ id: string; key: string; group_name: string; starts_at: string; ends_at: string }[]> {
    return this.many(
      tx,
      `select t.id, 'CS' || lpad(t.number::text, 7, '0') as key, g.name as group_name, g.starts_at, g.ends_at
         from acct.tickets t
         join acct.ticket_groups g on g.id = t.ticket_group_id and g.kind = 'change_window' and g.status <> 'cancelled'
        where t.account_id = $1 and t.configuration_item_id = $2 and t.id <> $3
          and t.type = 'change' and t.state in ('scheduled', 'implementing', 'validation')
          and g.starts_at < $5::timestamptz and g.ends_at > $4::timestamptz
        order by g.starts_at`,
      [accountId, configurationItemId, excludeTicketId, span.startsAt.toISOString(), span.endsAt.toISOString()],
    );
  }

  insert(
    tx: Tx,
    input: {
      accountId: string;
      kind: GroupKind;
      name: string;
      description: string;
      ownerUserId: string | null;
      startsAt: string | null;
      endsAt: string | null;
      freezeWindows: FreezeWindow[];
      status: GroupStatus;
    },
  ): Promise<TicketGroupRow> {
    return this.one<TicketGroupRow>(
      tx,
      'ticket_group',
      `insert into acct.ticket_groups
         (account_id, kind, name, description, owner_user_id, starts_at, ends_at, freeze_windows, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) returning *`,
      [
        input.accountId,
        input.kind,
        input.name,
        input.description,
        input.ownerUserId,
        input.startsAt,
        input.endsAt,
        JSON.stringify(input.freezeWindows),
        input.status,
      ],
    );
  }

  update(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<TicketGroupRow> {
    const serialised: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(assignments))
      serialised[key] = key === 'freeze_windows' ? JSON.stringify(value) : value;
    return this.updateVersioned<TicketGroupRow>(tx, 'ticket_group', 'acct.ticket_groups', id, version, serialised);
  }
}

export class FreezeWindowDto {
  @IsISO8601({ strict: true }) starts_at!: string;

  @IsISO8601({ strict: true }) ends_at!: string;

  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class CreateTicketGroupDto {
  @IsUUID('4') account_id!: string;

  @IsIn(GROUP_KINDS) kind!: GroupKind;

  @IsString() @MinLength(1) @MaxLength(160) name!: string;

  @IsOptional() @IsString() @MaxLength(2000) description?: string;

  @IsOptional() @IsUUID('4') owner_user_id?: string | null;

  @IsOptional() @IsISO8601({ strict: true }) starts_at?: string | null;

  @IsOptional() @IsISO8601({ strict: true }) ends_at?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => FreezeWindowDto)
  freeze_windows?: FreezeWindowDto[];

  @IsOptional() @IsIn(GROUP_STATUSES) status?: GroupStatus;
}

export class PatchTicketGroupDto {
  @IsInt() @Min(1) version!: number;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) name?: string;

  @IsOptional() @IsString() @MaxLength(2000) description?: string;

  @IsOptional() @IsUUID('4') owner_user_id?: string | null;

  @IsOptional() @IsISO8601({ strict: true }) starts_at?: string | null;

  @IsOptional() @IsISO8601({ strict: true }) ends_at?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => FreezeWindowDto)
  freeze_windows?: FreezeWindowDto[];

  @IsOptional() @IsIn(GROUP_STATUSES) status?: GroupStatus;
}

const toList = ({ value }: { value: unknown }): string[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value.map(String) : String(value).split(',').filter(Boolean);

export class ListTicketGroupsQueryDto {
  @IsOptional() @Transform(toList) @IsArray() @IsUUID('4', { each: true }) account_id?: string[];

  @IsOptional() @IsIn(GROUP_KINDS) kind?: GroupKind;

  @IsOptional() @IsIn(GROUP_STATUSES) status?: GroupStatus;
}

export class ChangeCalendarQueryDto {
  @IsOptional() @Transform(toList) @IsArray() @IsUUID('4', { each: true }) account_id?: string[];

  @IsISO8601({ strict: true }) from!: string;

  @IsISO8601({ strict: true }) to!: string;
}

export class WindowAtQueryDto {
  @IsUUID('4') account_id!: string;

  @IsOptional() @IsISO8601({ strict: true }) at?: string;
}

const PATCH_FIELDS = ['name', 'description', 'owner_user_id', 'starts_at', 'ends_at', 'status'] as const;

@Injectable()
export class TicketGroupsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly groups: TicketGroupsRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  list(principal: Principal, query: ListTicketGroupsQueryDto): Promise<TicketGroupRow[]> {
    const accountIds = (query.account_id?.length ? query.account_id : [...principal.accountIds]).filter((id) =>
      principal.accountIds.includes(id),
    );
    if (accountIds.length === 0) return Promise.resolve([]);
    return this.uow.run(principal, (tx) =>
      this.groups.list(tx, { accountIds, kind: query.kind, status: query.status }),
    );
  }

  get(principal: Principal, id: string): Promise<TicketGroupRow & { tickets: unknown[] }> {
    return this.uow.run(principal, async (tx) => ({
      ...(await this.groups.byId(tx, id)),
      tickets: await this.groups.ticketsOf(tx, id),
    }));
  }

  create(principal: Principal, ctx: RequestContext, dto: CreateTicketGroupDto): Promise<TicketGroupRow> {
    if (!principal.accountIds.includes(dto.account_id))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
    const freezes = (dto.freeze_windows ?? []) as FreezeWindow[];
    assertSchedule(dto.kind, dto.starts_at ?? null, dto.ends_at ?? null, freezes);
    const correlationId = ctx.requestId ?? randomUUID();
    return this.uow.run(principal, async (tx) => {
      const group = await this.groups.insert(tx, {
        accountId: dto.account_id,
        kind: dto.kind,
        name: dto.name,
        description: dto.description ?? '',
        ownerUserId: dto.owner_user_id ?? principal.userId,
        startsAt: dto.starts_at ?? null,
        endsAt: dto.ends_at ?? null,
        freezeWindows: freezes,
        status: dto.status ?? 'planned',
      });
      await this.audit.account(tx, dto.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'ticket_group',
          entityId: group.id,
          eventType: 'created',
          newValue: { kind: group.kind, name: group.name, starts_at: group.starts_at, ends_at: group.ends_at },
        },
      ]);
      await this.outbox.write(tx, {
        accountId: dto.account_id,
        aggregate: 'ticket_group',
        aggregateId: group.id,
        eventType: 'ticket_group.created',
        correlationId,
        payload: { kind: group.kind, name: group.name, starts_at: group.starts_at, ends_at: group.ends_at },
      });
      return group;
    });
  }

  patch(principal: Principal, ctx: RequestContext, id: string, dto: PatchTicketGroupDto): Promise<TicketGroupRow> {
    const correlationId = ctx.requestId ?? randomUUID();
    return this.uow.run(principal, async (tx) => {
      const before = await this.groups.byId(tx, id);
      const startsAt = dto.starts_at === undefined ? before.starts_at : dto.starts_at;
      const endsAt = dto.ends_at === undefined ? before.ends_at : dto.ends_at;
      const freezes = (dto.freeze_windows ?? before.freeze_windows ?? []) as FreezeWindow[];
      assertSchedule(before.kind, startsAt, endsAt, freezes);
      const assignments: Record<string, unknown> = { starts_at: startsAt, ends_at: endsAt, freeze_windows: freezes };
      for (const field of ['name', 'description', 'owner_user_id', 'status'] as const)
        if (dto[field] !== undefined) assignments[field] = dto[field];
      const after = await this.groups.update(tx, id, dto.version, assignments);
      const changed = PATCH_FIELDS.filter((field) => before[field] !== after[field]);
      await this.audit.account(tx, before.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'ticket_group',
          entityId: id,
          eventType: 'updated',
          oldValue: Object.fromEntries(changed.map((field) => [field, before[field]])),
          newValue: Object.fromEntries(changed.map((field) => [field, after[field]])),
        },
      ]);
      // Moving a window moves the work planned around it, so the calendar
      // integration and everything else downstream is told (INT-05).
      await this.outbox.write(tx, {
        accountId: before.account_id,
        aggregate: 'ticket_group',
        aggregateId: id,
        eventType: 'ticket_group.updated',
        correlationId,
        payload: { fields: changed, starts_at: after.starts_at, ends_at: after.ends_at },
      });
      return after;
    });
  }

  /** The change calendar across the granted accounts (functional 5.13). */
  calendar(principal: Principal, query: ChangeCalendarQueryDto): Promise<unknown> {
    const accountIds = (query.account_id?.length ? query.account_id : [...principal.accountIds]).filter((id) =>
      principal.accountIds.includes(id),
    );
    if (accountIds.length === 0) return Promise.resolve({ from: query.from, to: query.to, windows: [] });
    return this.uow.run(principal, async (tx) => {
      const rows = await this.groups.overlapping(tx, accountIds, query.from, query.to);
      const windows = [];
      for (const row of rows) {
        windows.push({
          id: row.id,
          account_id: row.account_id,
          name: row.name,
          status: row.status,
          starts_at: row.starts_at,
          ends_at: row.ends_at,
          freeze_windows: row.freeze_windows ?? [],
          tickets: await this.groups.ticketsOf(tx, row.id),
        });
      }
      return { from: query.from, to: query.to, windows };
    });
  }

  /**
   * Whether an instant is inside a change window of the account, and whether
   * a freeze covers it. The transition gate asks the same question of the
   * same rules, so what a screen shows and what the server enforces cannot
   * disagree.
   */
  at(principal: Principal, query: WindowAtQueryDto): Promise<unknown> {
    if (!principal.accountIds.includes(query.account_id))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
    const at = new Date(query.at ?? new Date().toISOString());
    return this.uow.run(principal, async (tx) => {
      const rows = await this.groups.covering(tx, query.account_id, at.toISOString());
      const open = rows
        .map((row) => ({ row, window: toChangeWindow(row) }))
        .filter((candidate) => insideWindow(candidate.window, at));
      const frozen = open.filter((candidate) => freezeAt(candidate.window, at) !== undefined);
      return {
        at: at.toISOString(),
        // Inside a window and not frozen is the only state in which work may
        // be implemented without an override.
        inside: open.length > frozen.length,
        frozen: frozen.length > 0 && open.length === frozen.length,
        windows: open.map((candidate) => ({
          id: candidate.row.id,
          name: candidate.row.name,
          status: candidate.row.status,
          starts_at: candidate.row.starts_at,
          ends_at: candidate.row.ends_at,
          freeze: freezeAt(candidate.window, at) ?? null,
        })),
      };
    });
  }
}

/** A change window without both ends is not a window, and a bad freeze is not a rule. */
function assertSchedule(
  kind: GroupKind,
  startsAt: string | null,
  endsAt: string | null,
  freezes: readonly FreezeWindow[],
): void {
  const problems = freezeProblems(freezes);
  if (kind === 'change_window' && (!startsAt || !endsAt)) problems.push('a change window needs a start and an end');
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt))
    problems.push('ends_at must be after starts_at');
  if (problems.length > 0) throw new BadRequestException({ code: 'invalid_schedule', problems });
}

/** Exported so the ticket service words the same refusal the calendar shows. */
export function windowSpan(row: TicketGroupRow): Span | null {
  return spanOf(toChangeWindow(row));
}

@ApiTags('tickets')
@ApiBearerAuth()
@Controller('ticket-groups')
export class TicketGroupsController {
  constructor(private readonly groups: TicketGroupsService) {}

  @Get()
  @RequirePermission('tickets:view')
  list(@CurrentPrincipal() principal: Principal, @Query() query: ListTicketGroupsQueryDto) {
    return this.groups.list(principal, query);
  }

  @Post()
  @RequirePermission('tickets:work')
  create(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Body() dto: CreateTicketGroupDto,
  ) {
    return this.groups.create(principal, ctx, dto);
  }

  @Get(':id')
  @RequirePermission('tickets:view')
  get(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.groups.get(principal, id);
  }

  @Patch(':id')
  @RequirePermission('tickets:work')
  patch(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchTicketGroupDto,
  ) {
    return this.groups.patch(principal, ctx, id, dto);
  }
}

@ApiTags('tickets')
@ApiBearerAuth()
@Controller('change-calendar')
export class ChangeCalendarController {
  constructor(private readonly groups: TicketGroupsService) {}

  @Get()
  @RequirePermission('tickets:view')
  calendar(@CurrentPrincipal() principal: Principal, @Query() query: ChangeCalendarQueryDto) {
    return this.groups.calendar(principal, query);
  }

  @Get('at')
  @RequirePermission('tickets:view')
  at(@CurrentPrincipal() principal: Principal, @Query() query: WindowAtQueryDto) {
    return this.groups.at(principal, query);
  }
}

@Module({
  providers: [TicketGroupsRepository, TicketGroupsService, OutboxService],
  exports: [TicketGroupsRepository, TicketGroupsService],
})
export class ChangeWindowsCoreModule {}

@Module({
  imports: [ChangeWindowsCoreModule],
  controllers: [TicketGroupsController, ChangeCalendarController],
  exports: [ChangeWindowsCoreModule],
})
export class ChangeWindowsModule {}
