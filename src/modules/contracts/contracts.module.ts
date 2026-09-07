import { Body, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Length, MaxLength, Min, MinLength } from 'class-validator';
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
    },
  ): Promise<ContractRow> {
    return this.one<ContractRow>(
      tx,
      'contract',
      `insert into acct.contracts (account_id, key, name, model, currency, period_cadence, period_starts_on, period_ends_on, period_hours, status)
       values ($1, 'CT' || lpad(nextval('acct.contract_number_seq')::text, 5, '0'), $2, $3, coalesce($4, 'USD'), coalesce($5, 'monthly'), $6, $7, $8, coalesce($9, 'active'))
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
      ],
    );
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
}

@Module({
  controllers: [ContractsController],
  providers: [ContractsRepository, ContractsService],
  exports: [ContractsRepository],
})
export class ContractsModule {}
