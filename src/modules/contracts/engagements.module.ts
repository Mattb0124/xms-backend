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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import type { Principal } from '../../common/auth/principal.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';

/**
 * Engagements (Time, Contracts & Budget technical 2.1; functional 5.6,
 * INT-03). The engagement is the commercial envelope a contract sits
 * inside: a name, the owner who is answerable for it, the renewal date and
 * the notice period that decides when a decision must already have been
 * made. The renewal alerts themselves are a worker job
 * (`worker/renewal-jobs.ts`); this file owns the record and its rules.
 *
 * `renewal_alerts_fired` is the once-per-lead-time ledger: 90, 60 and 30
 * for the lead times, 0 for the notice-period boundary. Moving the renewal
 * date clears it, because the alerts a new date deserves have not been sent.
 */
export const RENEWAL_LEAD_DAYS = [90, 60, 30] as const;

/** The notice-period boundary is a date of its own, not a lead time; 0 is its key. */
export const NOTICE_BOUNDARY_KEY = 0;

export const ENGAGEMENT_STATUSES = ['active', 'expiring', 'ended'] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

export interface EngagementRow {
  id: string;
  account_id: string;
  name: string;
  owner_user_id: string | null;
  renewal_date: string | null;
  notice_period_days: number | null;
  status: EngagementStatus;
  renewal_alerts_fired: number[];
  created_at: string;
  updated_at: string;
  version: number;
}

@Injectable()
export class EngagementsRepository extends RepositoryBase {
  forAccount(tx: Tx, accountId: string): Promise<EngagementRow[]> {
    return this.many<EngagementRow>(
      tx,
      `select id, account_id, name, owner_user_id, renewal_date::text as renewal_date, notice_period_days,
              status, renewal_alerts_fired, created_at, updated_at, version
         from acct.engagements where account_id = $1 order by status, name`,
      [accountId],
    );
  }

  byId(tx: Tx, id: string): Promise<EngagementRow> {
    return this.one<EngagementRow>(
      tx,
      'engagement',
      `select id, account_id, name, owner_user_id, renewal_date::text as renewal_date, notice_period_days,
              status, renewal_alerts_fired, created_at, updated_at, version
         from acct.engagements where id = $1`,
      [id],
    );
  }

  /** Engagements with a renewal date that is not already ended, for the daily sweep. */
  dueForReview(tx: Tx, horizonDays: number, batch: number): Promise<EngagementRow[]> {
    return this.many<EngagementRow>(
      tx,
      `select id, account_id, name, owner_user_id, renewal_date::text as renewal_date, notice_period_days,
              status, renewal_alerts_fired, created_at, updated_at, version
         from acct.engagements
        where renewal_date is not null
          and status <> 'ended'
          and renewal_date <= current_date + $1::int
        order by renewal_date limit $2 for update skip locked`,
      [horizonDays, batch],
    );
  }

  insert(
    tx: Tx,
    input: {
      accountId: string;
      name: string;
      ownerUserId: string | null;
      renewalDate: string | null;
      noticePeriodDays: number | null;
      status: EngagementStatus;
    },
  ): Promise<EngagementRow> {
    return this.one<EngagementRow>(
      tx,
      'engagement',
      `insert into acct.engagements (account_id, name, owner_user_id, renewal_date, notice_period_days, status)
       values ($1, $2, $3, $4, $5, $6)
       returning id, account_id, name, owner_user_id, renewal_date::text as renewal_date, notice_period_days,
                 status, renewal_alerts_fired, created_at, updated_at, version`,
      [input.accountId, input.name, input.ownerUserId, input.renewalDate, input.noticePeriodDays, input.status],
    );
  }

  update(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<EngagementRow> {
    return this.updateVersioned<EngagementRow>(tx, 'engagement', 'acct.engagements', id, version, assignments);
  }

  /** The job's own write: no version check, because the sweep holds the row. */
  async stamp(tx: Tx, id: string, fired: readonly number[], status: EngagementStatus): Promise<void> {
    await tx.query(
      `update acct.engagements set renewal_alerts_fired = $2::integer[], status = $3, version = version + 1 where id = $1`,
      [id, [...fired], status],
    );
  }
}

/**
 * The status a renewal date implies on a given day: ended once the date has
 * passed, expiring inside the widest lead window, active before that. Pure
 * so the job and the record agree on one rule.
 */
export function statusFor(renewalDate: string | null, today: string): EngagementStatus {
  if (!renewalDate) return 'active';
  const days = daysBetween(today, renewalDate);
  if (days < 0) return 'ended';
  return days <= Math.max(...RENEWAL_LEAD_DAYS) ? 'expiring' : 'active';
}

/** Whole days from `from` to `to`, both ISO dates; negative when `to` is past. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The alert keys owed today: every lead time already reached and not yet
 * fired, plus the notice-period boundary when the engagement sets one. The
 * date itself does not alert: past it the engagement has ended.
 */
export function alertsDue(
  engagement: Pick<EngagementRow, 'renewal_date' | 'notice_period_days' | 'renewal_alerts_fired'>,
  today: string,
): number[] {
  if (!engagement.renewal_date) return [];
  const days = daysBetween(today, engagement.renewal_date);
  if (days < 0) return [];
  const fired = new Set(engagement.renewal_alerts_fired);
  const due: number[] = RENEWAL_LEAD_DAYS.filter((lead) => days <= lead && !fired.has(lead));
  const notice = engagement.notice_period_days;
  if (notice !== null && days <= notice && !fired.has(NOTICE_BOUNDARY_KEY)) due.push(NOTICE_BOUNDARY_KEY);
  // Widest first, so a first run on a nearly-expired engagement reads as
  // one escalation rather than an arbitrary order.
  return due.sort((a, b) => b - a);
}

export class CreateEngagementDto {
  @IsString() @MinLength(1) @MaxLength(160) name!: string;

  @IsOptional() @IsUUID('4') owner_user_id?: string | null;

  @IsOptional() @IsISO8601({ strict: true }) renewal_date?: string | null;

  @IsOptional() @IsInt() @Min(0) @Max(365) notice_period_days?: number | null;
}

export class PatchEngagementDto {
  @IsInt() @Min(1) version!: number;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) name?: string;

  @IsOptional() @IsUUID('4') owner_user_id?: string | null;

  @IsOptional() @IsISO8601({ strict: true }) renewal_date?: string | null;

  @IsOptional() @IsInt() @Min(0) @Max(365) notice_period_days?: number | null;

  @IsOptional() @IsIn(ENGAGEMENT_STATUSES) status?: EngagementStatus;
}

const PATCH_FIELDS = ['name', 'owner_user_id', 'renewal_date', 'notice_period_days', 'status'] as const;

@Injectable()
export class EngagementsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly engagements: EngagementsRepository,
    private readonly audit: AuditService,
  ) {}

  list(principal: Principal, accountId: string): Promise<EngagementRow[]> {
    return this.uow.run(principal, (tx) => this.engagements.forAccount(tx, accountId));
  }

  create(
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    dto: CreateEngagementDto,
    today = isoToday(),
  ): Promise<EngagementRow> {
    assertNotice(dto.notice_period_days ?? null, dto.renewal_date ?? null);
    return this.uow.run(principal, async (tx) => {
      const engagement = await this.engagements.insert(tx, {
        accountId,
        name: dto.name,
        ownerUserId: dto.owner_user_id ?? principal.userId,
        renewalDate: dto.renewal_date ?? null,
        noticePeriodDays: dto.notice_period_days ?? null,
        status: statusFor(dto.renewal_date ?? null, today),
      });
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'engagement',
          entityId: engagement.id,
          eventType: 'created',
          newValue: {
            name: engagement.name,
            renewal_date: engagement.renewal_date,
            notice_period_days: engagement.notice_period_days,
            status: engagement.status,
          },
        },
      ]);
      return engagement;
    });
  }

  patch(
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    id: string,
    dto: PatchEngagementDto,
    today = isoToday(),
  ): Promise<EngagementRow> {
    return this.uow.run(principal, async (tx) => {
      const before = await this.engagements.byId(tx, id);
      if (before.account_id !== accountId) throw new NotFoundException({ code: 'not_found', entity: 'engagement' });
      const renewalDate = dto.renewal_date === undefined ? before.renewal_date : dto.renewal_date;
      const noticeDays = dto.notice_period_days === undefined ? before.notice_period_days : dto.notice_period_days;
      assertNotice(noticeDays, renewalDate);
      const assignments: Record<string, unknown> = {
        name: dto.name ?? before.name,
        owner_user_id: dto.owner_user_id === undefined ? before.owner_user_id : dto.owner_user_id,
        renewal_date: renewalDate,
        notice_period_days: noticeDays,
        // An explicit status wins; otherwise a moved renewal date decides it.
        status: dto.status ?? (renewalDate === before.renewal_date ? before.status : statusFor(renewalDate, today)),
      };
      // A new renewal date has had none of its alerts sent, so the ledger
      // starts empty rather than suppressing the alerts the new date earns.
      if (renewalDate !== before.renewal_date) assignments.renewal_alerts_fired = [];
      const after = await this.engagements.update(tx, id, dto.version, assignments);
      const changed = PATCH_FIELDS.filter((field) => before[field] !== after[field]);
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'engagement',
          entityId: id,
          eventType: 'updated',
          oldValue: Object.fromEntries(changed.map((field) => [field, before[field]])),
          newValue: Object.fromEntries(changed.map((field) => [field, after[field]])),
        },
      ]);
      return after;
    });
  }
}

/** A notice period longer than the time left is not a rule anyone can meet. */
function assertNotice(noticeDays: number | null, renewalDate: string | null): void {
  if (noticeDays !== null && renewalDate === null)
    throw new BadRequestException({ code: 'renewal_date_required', field: 'notice_period_days' });
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Reads sit under contracts:view (which contracts:manage implies) so an
 * account owner reading the account record sees its engagements; writes
 * need contracts:manage, as technical 4 requires.
 */
@ApiTags('contracts')
@ApiBearerAuth()
@Controller('accounts/:accountId/engagements')
export class EngagementsController {
  constructor(private readonly engagements: EngagementsService) {}

  @Get()
  @RequirePermission('contracts:view')
  list(@CurrentPrincipal() principal: Principal, @Param('accountId', ParseUUIDPipe) accountId: string) {
    return this.engagements.list(principal, accountId);
  }

  @Post()
  @RequirePermission('contracts:manage')
  create(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: CreateEngagementDto,
  ) {
    return this.engagements.create(principal, ctx, accountId, dto);
  }

  @Patch(':id')
  @RequirePermission('contracts:manage')
  patch(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchEngagementDto,
  ) {
    return this.engagements.patch(principal, ctx, accountId, id, dto);
  }
}

@Module({
  providers: [EngagementsRepository, EngagementsService],
  exports: [EngagementsRepository, EngagementsService],
})
export class EngagementsCoreModule {}

@Module({
  imports: [EngagementsCoreModule],
  controllers: [EngagementsController],
  exports: [EngagementsCoreModule],
})
export class EngagementsModule {}
