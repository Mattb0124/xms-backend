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
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { OVERAGE_RULES, ROLLOVER_RULES, type OverageRule, type RolloverRule } from '../../domain/time/budget.js';
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
  /** Budget rules (Time, Contracts & Budget technical 2.2). */
  threshold_percents: number[];
  threshold_notify_client: boolean;
  overage_rule: OverageRule;
  overage_multiplier: string | null;
  rollover_rule: RolloverRule;
  rollover_cap_hours: string | null;
  forecast_window_days: number;
  /** Technologies the contract requires (CAP-07 account lens). */
  technology_codes: string[];
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
      threshold_percents?: number[];
      threshold_notify_client?: boolean;
      overage_rule?: OverageRule;
      overage_multiplier?: number | null;
      rollover_rule?: RolloverRule;
      rollover_cap_hours?: number | null;
      forecast_window_days?: number;
      technology_codes?: string[];
    },
  ): Promise<ContractRow> {
    return this.one<ContractRow>(
      tx,
      'contract',
      `insert into acct.contracts (account_id, key, name, model, currency, period_cadence, period_starts_on, period_ends_on, period_hours, status, after_hours_handling, after_hours_multiplier,
                                   threshold_percents, threshold_notify_client, overage_rule, overage_multiplier, rollover_rule, rollover_cap_hours, forecast_window_days, technology_codes)
       values ($1, 'CT' || lpad(nextval('acct.contract_number_seq')::text, 5, '0'), $2, $3, coalesce($4, 'USD'), coalesce($5, 'monthly'), $6, $7, $8, coalesce($9, 'active'), coalesce($10, 'none'), $11,
               coalesce($12::integer[], '{50,75,90,100}'), coalesce($13, false), coalesce($14, 'allow_flag'), $15, coalesce($16, 'none'), $17, coalesce($18, 10), coalesce($19::text[], '{}'))
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
        input.threshold_percents ?? null,
        input.threshold_notify_client ?? null,
        input.overage_rule ?? null,
        input.overage_multiplier ?? null,
        input.rollover_rule ?? null,
        input.rollover_cap_hours ?? null,
        input.forecast_window_days ?? null,
        input.technology_codes ?? null,
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

/** The commercial rules an operator sets on a contract (Time, Contracts & Budget 2.2; TB-09, TB-11). */
export class ContractRulesDto {
  @IsOptional()
  @IsIn(AFTER_HOURS_HANDLINGS)
  after_hours_handling?: AfterHoursHandling;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(9.999)
  after_hours_multiplier?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(1000, { each: true })
  threshold_percents?: number[];

  @IsOptional()
  @IsBoolean()
  threshold_notify_client?: boolean;

  @IsOptional()
  @IsIn(OVERAGE_RULES)
  overage_rule?: OverageRule;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(9.999)
  overage_multiplier?: number | null;

  @IsOptional()
  @IsIn(ROLLOVER_RULES)
  rollover_rule?: RolloverRule;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  rollover_cap_hours?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  forecast_window_days?: number;

  /** Skill codes the contract requires (CAP-07). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @Matches(/^[a-z0-9][a-z0-9_.-]{0,59}$/, { each: true })
  technology_codes?: string[];
}

export class CreateContractDto extends ContractRulesDto {
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
}

/** The rules, changeable on a live contract with the version (TB-09, TB-11, TB-13). */
export class PatchContractDto extends ContractRulesDto {
  @IsInt()
  @Min(1)
  version!: number;
}

const RULE_FIELDS = [
  'after_hours_handling',
  'after_hours_multiplier',
  'threshold_percents',
  'threshold_notify_client',
  'overage_rule',
  'overage_multiplier',
  'rollover_rule',
  'rollover_cap_hours',
  'forecast_window_days',
  'technology_codes',
] as const;

/** The rule set as it would stand after the patch; the checks that tie a multiplier or cap to its rule. */
export function assertRules(rules: {
  after_hours_handling: AfterHoursHandling;
  after_hours_multiplier: number | null;
  overage_rule: OverageRule;
  overage_multiplier: number | null;
  rollover_rule: RolloverRule;
  rollover_cap_hours: number | null;
}): void {
  if (rules.after_hours_handling === 'premium_rate' && rules.after_hours_multiplier === null)
    throw new BadRequestException({ code: 'multiplier_required', handling: 'premium_rate' });
  if (rules.overage_rule === 'allow_rate' && rules.overage_multiplier === null)
    throw new BadRequestException({ code: 'multiplier_required', handling: 'allow_rate' });
  if (rules.rollover_rule === 'cap' && rules.rollover_cap_hours === null)
    throw new BadRequestException({ code: 'cap_required', rule: 'cap' });
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
    assertRules({
      after_hours_handling: dto.after_hours_handling ?? 'none',
      after_hours_multiplier: dto.after_hours_multiplier ?? null,
      overage_rule: dto.overage_rule ?? 'allow_flag',
      overage_multiplier: dto.overage_multiplier ?? null,
      rollover_rule: dto.rollover_rule ?? 'none',
      rollover_cap_hours: dto.rollover_cap_hours ?? null,
    });
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
      const numeric = (value: string | null) => (value === null ? null : Number(value));
      const next = {
        after_hours_handling: dto.after_hours_handling ?? before.after_hours_handling,
        after_hours_multiplier:
          dto.after_hours_multiplier === undefined
            ? numeric(before.after_hours_multiplier)
            : dto.after_hours_multiplier,
        threshold_percents: dto.threshold_percents ?? before.threshold_percents,
        threshold_notify_client: dto.threshold_notify_client ?? before.threshold_notify_client,
        overage_rule: dto.overage_rule ?? before.overage_rule,
        overage_multiplier:
          dto.overage_multiplier === undefined ? numeric(before.overage_multiplier) : dto.overage_multiplier,
        rollover_rule: dto.rollover_rule ?? before.rollover_rule,
        rollover_cap_hours:
          dto.rollover_cap_hours === undefined ? numeric(before.rollover_cap_hours) : dto.rollover_cap_hours,
        forecast_window_days: dto.forecast_window_days ?? before.forecast_window_days,
        technology_codes: dto.technology_codes ? [...new Set(dto.technology_codes)] : before.technology_codes,
      };
      assertRules(next);
      const assignments: Record<string, unknown> = {
        ...next,
        after_hours_multiplier: next.after_hours_handling === 'premium_rate' ? next.after_hours_multiplier : null,
        overage_multiplier: next.overage_rule === 'allow_rate' ? next.overage_multiplier : null,
        rollover_cap_hours: next.rollover_rule === 'cap' ? next.rollover_cap_hours : null,
      };
      const after = await this.contracts.update(tx, id, dto.version, assignments);
      const changed = RULE_FIELDS.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'contract',
          entityId: id,
          eventType: 'updated',
          field: 'rules',
          oldValue: Object.fromEntries(changed.map((field) => [field, before[field]])),
          newValue: Object.fromEntries(changed.map((field) => [field, after[field]])),
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
