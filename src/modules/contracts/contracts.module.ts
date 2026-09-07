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
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { AFTER_HOURS_HANDLINGS, type AfterHoursHandling } from '../../domain/calendar/after-hours.js';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import type { Principal } from '../../common/auth/principal.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';

/**
 * Contracts, cut to the entitlement anchor (Thirty-Day Build section 5,
 * P2.13.1 cut): one active period modelled on the contract row; periods,
 * rate cards, rollover and overage land in month 2 in the Time, Contracts &
 * Budget module, which will absorb this file.
 */
export interface ContractRow {
  id: string;
  account_id: string;
  key: string;
  name: string;
  model: 'retainer' | 'prepaid_block' | 'time_and_materials' | 'fixed_fee';
  status: 'draft' | 'active' | 'expired' | 'closed';
  currency: string;
  period_cadence: 'monthly' | 'quarterly' | 'annual' | 'none';
  period_starts_on: string | null;
  period_ends_on: string | null;
  period_hours: string | null;
  sla_policy: Record<string, unknown> | null;
  /** How a non-standard after-hours class is handled (TB-13). */
  after_hours_handling: AfterHoursHandling;
  /** Premium multiplier under `premium_rate`; numeric comes back as a string. */
  after_hours_multiplier: string | null;
  version: number;
}

@Injectable()
export class ContractsRepository extends RepositoryBase {
  activeForAccount(tx: Tx, accountId: string): Promise<ContractRow[]> {
    return this.many<ContractRow>(
      tx,
      `select * from acct.contracts where account_id = $1 and status = 'active' order by name`,
      [accountId],
    );
  }

  forAccount(tx: Tx, accountId: string): Promise<ContractRow[]> {
    return this.many<ContractRow>(tx, `select * from acct.contracts where account_id = $1 order by status, name`, [
      accountId,
    ]);
  }

  byId(tx: Tx, id: string): Promise<ContractRow> {
    return this.one<ContractRow>(tx, 'contract', 'select * from acct.contracts where id = $1', [id]);
  }

  insert(
    tx: Tx,
    input: {
      accountId: string;
      name: string;
      model: string;
      currency?: string;
      period_cadence?: string;
      period_starts_on?: string;
      period_ends_on?: string;
      period_hours?: number;
      status?: string;
      after_hours_handling?: AfterHoursHandling;
      after_hours_multiplier?: number | null;
    },
  ): Promise<ContractRow> {
    return this.one<ContractRow>(
      tx,
      'contract',
      `insert into acct.contracts (account_id, key, name, model, currency, period_cadence, period_starts_on, period_ends_on, period_hours, status, after_hours_handling, after_hours_multiplier)
       values ($1, 'CT' || lpad(nextval('acct.contract_number_seq')::text, 5, '0'), $2, $3, coalesce($4, 'USD'), coalesce($5, 'monthly'), $6, $7, $8, coalesce($9, 'active'), coalesce($10, 'none'), $11)
       returning *`,
      [
        input.accountId,
        input.name,
        input.model,
        input.currency,
        input.period_cadence,
        input.period_starts_on ?? null,
        input.period_ends_on ?? null,
        input.period_hours ?? null,
        input.status,
        input.after_hours_handling ?? null,
        input.after_hours_multiplier ?? null,
      ],
    );
  }

  update(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<ContractRow> {
    return this.updateVersioned<ContractRow>(tx, 'contract', 'acct.contracts', id, version, assignments);
  }

  /** True when the contract's current period (if any) contains the date. */
  periodOpen(contract: ContractRow, on: Date): boolean {
    if (contract.status !== 'active') return false;
    const day = on.toISOString().slice(0, 10);
    if (contract.period_starts_on && day < contract.period_starts_on) return false;
    if (contract.period_ends_on && day > contract.period_ends_on) return false;
    return true;
  }
}

export class CreateContractDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsIn(['retainer', 'prepaid_block', 'time_and_materials', 'fixed_fee'])
  model!: ContractRow['model'];

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @IsIn(['monthly', 'quarterly', 'annual', 'none'])
  period_cadence?: ContractRow['period_cadence'];

  @IsOptional()
  @IsISO8601()
  period_starts_on?: string;

  @IsOptional()
  @IsISO8601()
  period_ends_on?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  period_hours?: number;

  @IsOptional()
  @IsIn(AFTER_HOURS_HANDLINGS)
  after_hours_handling?: AfterHoursHandling;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(9.999)
  after_hours_multiplier?: number | null;
}

/** The commercial handling of after-hours work, changeable on a live contract (TB-13). */
export class PatchContractDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsIn(AFTER_HOURS_HANDLINGS)
  after_hours_handling?: AfterHoursHandling;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(9.999)
  after_hours_multiplier?: number | null;
}

@Injectable()
export class ContractsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly contracts: ContractsRepository,
    private readonly audit: AuditService,
  ) {}

  list(principal: Principal, accountId: string): Promise<ContractRow[]> {
    return this.uow.run(principal, (tx) => this.contracts.forAccount(tx, accountId));
  }

  create(principal: Principal, ctx: RequestContext, accountId: string, dto: CreateContractDto): Promise<ContractRow> {
    return this.uow.run(principal, async (tx) => {
      const contract = await this.contracts.insert(tx, { accountId, ...dto });
      const startsOn = dto.period_starts_on ?? new Date().toISOString().slice(0, 8) + '01';
      const endsOn =
        dto.period_ends_on ??
        new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      await tx.query(
        `insert into acct.contract_periods (account_id, contract_id, starts_on, ends_on, contracted_minutes) values ($1, $2, $3, $4, $5)`,
        [accountId, contract.id, startsOn, endsOn, Math.round((dto.period_hours ?? 0) * 60)],
      );
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'contract',
          entityId: contract.id,
          eventType: 'created',
          newValue: { key: contract.key, name: contract.name, model: contract.model },
        },
      ]);
      return contract;
    });
  }

  patch(principal: Principal, ctx: RequestContext, accountId: string, id: string, dto: PatchContractDto) {
    return this.uow.run(principal, async (tx) => {
      const before = await this.contracts.byId(tx, id);
      if (before.account_id !== accountId) throw new NotFoundException({ code: 'not_found', entity: 'contract' });
      const handling = dto.after_hours_handling ?? before.after_hours_handling;
      const multiplier =
        dto.after_hours_multiplier === undefined
          ? before.after_hours_multiplier === null
            ? null
            : Number(before.after_hours_multiplier)
          : dto.after_hours_multiplier;
      if (handling === 'premium_rate' && multiplier === null)
        throw new BadRequestException({ code: 'multiplier_required', handling });
      const assignments: Record<string, unknown> = {
        after_hours_handling: handling,
        after_hours_multiplier: handling === 'premium_rate' ? multiplier : null,
      };
      const after = await this.contracts.update(tx, id, dto.version, assignments);
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'contract',
          entityId: id,
          eventType: 'updated',
          field: 'after_hours',
          oldValue: { handling: before.after_hours_handling, multiplier: before.after_hours_multiplier },
          newValue: { handling: after.after_hours_handling, multiplier: after.after_hours_multiplier },
        },
      ]);
      return after;
    });
  }
}

@ApiTags('contracts')
@ApiBearerAuth()
@Controller('accounts/:accountId/contracts')
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  @RequirePermission('tickets:view')
  list(@CurrentPrincipal() principal: Principal, @Param('accountId', ParseUUIDPipe) accountId: string) {
    return this.contracts.list(principal, accountId);
  }

  @Post()
  @RequirePermission('contracts:manage')
  create(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: CreateContractDto,
  ) {
    return this.contracts.create(principal, ctx, accountId, dto);
  }

  @Patch(':contractId')
  @RequirePermission('contracts:manage')
  patch(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('contractId', ParseUUIDPipe) contractId: string,
    @Body() dto: PatchContractDto,
  ) {
    return this.contracts.patch(principal, ctx, accountId, contractId, dto);
  }
}

@Module({
  providers: [ContractsRepository, ContractsService],
  exports: [ContractsRepository, ContractsService],
})
export class ContractsCoreModule {}

@Module({
  imports: [ContractsCoreModule],
  controllers: [ContractsController],
  exports: [ContractsCoreModule],
})
export class ContractsModule {}
