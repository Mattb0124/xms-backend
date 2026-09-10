import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { profitability, type CostRateView, type Profitability } from '../../domain/time/profitability.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { TimeRepository } from './time.repository.js';

/**
 * What a person costs, and what an account's work is worth after it.
 *
 * Cost rates are operator data: the same consultant costs the same whoever
 * they are working for, and what they cost is our business rather than the
 * client's. They are therefore held in `op`, outside any account's reach,
 * and answered to `finance:view-margin` rather than to the `contracts:view`
 * that opens a rate card to a delivery lead.
 */
export interface CostRateRow {
  id: string;
  person_id: string;
  effective_from: string;
  cost_rate: number;
  currency: string;
  note: string;
  created_by: string;
  created_at: string;
}

export class SetCostRateDto {
  /** The day this rate starts applying; the previous one holds until then. */
  @IsISO8601({ strict: true })
  effective_from!: string;

  /** Per hour. Zero is a real answer: a pass-through subcontractor costs nothing. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100_000)
  cost_rate!: number;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class PersonParam {
  @IsUUID('4') personId!: string;
}

export class CostRateParam {
  @IsUUID('4') personId!: string;
  @IsUUID('4') id!: string;
}

export class ProfitabilityQueryDto {
  @IsISO8601({ strict: true }) from!: string;
  @IsISO8601({ strict: true }) to!: string;
}

@Injectable()
export class CostRatesRepository extends RepositoryBase {
  ofPerson(tx: Tx, personId: string): Promise<CostRateRow[]> {
    return this.many<CostRateRow & { cost_rate: string }>(
      tx,
      `select id, person_id, effective_from::text as effective_from, cost_rate, currency, note, created_by, created_at
         from op.person_cost_rates where person_id = $1 order by effective_from desc`,
      [personId],
    ).then((rows) => rows.map((row) => ({ ...row, cost_rate: Number(row.cost_rate) })));
  }

  /**
   * Every rate of everyone who logged time on this account in the window,
   * keyed the way a time entry names a person.
   *
   * Rates from before the window are wanted too: the one in force on the
   * first day of March may have been set in January, and leaving it out
   * would report that month as having no cost at all.
   */
  forAccountWindow(tx: Tx, accountId: string, from: string, to: string): Promise<CostRateView[]> {
    return this.many<{ person_id: string; effective_from: string; cost_rate: string; currency: string }>(
      tx,
      `select p.user_id::text as person_id, r.effective_from::text as effective_from, r.cost_rate, r.currency
         from op.person_cost_rates r
         join op.people p on p.id = r.person_id
        where p.user_id is not null
          and r.effective_from <= $3
          and p.user_id::text in (
            select distinct e.person_id from acct.time_entries e
             where e.account_id = $1 and e.performed_on between $2 and $3
          )
        order by r.effective_from`,
      [accountId, from, to],
    ).then((rows) => rows.map((row) => ({ ...row, cost_rate: Number(row.cost_rate) })));
  }

  save(tx: Tx, personId: string, dto: SetCostRateDto, actor: string): Promise<CostRateRow> {
    return this.one<CostRateRow & { cost_rate: string }>(
      tx,
      'cost rate',
      `insert into op.person_cost_rates (person_id, effective_from, cost_rate, currency, note, created_by)
            values ($1, $2, $3, coalesce($4, 'USD'), coalesce($5, ''), $6)
       on conflict (person_id, effective_from)
         do update set cost_rate = excluded.cost_rate, currency = excluded.currency,
                       note = excluded.note, created_by = excluded.created_by
         returning id, person_id, effective_from::text as effective_from, cost_rate, currency, note, created_by, created_at`,
      [personId, dto.effective_from, dto.cost_rate, dto.currency ?? null, dto.note ?? null, actor],
    ).then((row) => ({ ...row, cost_rate: Number(row.cost_rate) }));
  }

  remove(tx: Tx, personId: string, id: string): Promise<void> {
    return tx
      .query('delete from op.person_cost_rates where id = $1 and person_id = $2', [id, personId])
      .then(() => undefined);
  }
}

@Injectable()
export class ProfitabilityService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly rates: CostRatesRepository,
    private readonly time: TimeRepository,
    private readonly audit: AuditService,
  ) {}

  costRates(principal: Principal, personId: string): Promise<CostRateRow[]> {
    return this.uow.operator((tx) => this.rates.ofPerson(tx, personId));
  }

  /**
   * Setting a cost rate is audited. It is a commercial fact about a person
   * that decides what every account they touch appears to be worth, so who
   * changed it and when is part of the record.
   */
  setCostRate(principal: Principal, ctx: RequestContext, personId: string, dto: SetCostRateDto): Promise<CostRateRow> {
    return this.uow.operator(async (tx) => {
      const before = (await this.rates.ofPerson(tx, personId)).find((row) => row.effective_from === dto.effective_from);
      const row = await this.rates.save(tx, personId, dto, principal.userId);
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'person_cost_rate',
          entityId: row.id,
          eventType: before ? 'updated' : 'created',
          oldValue: before ? { cost_rate: before.cost_rate, currency: before.currency } : {},
          newValue: {
            person_id: personId,
            effective_from: row.effective_from,
            cost_rate: row.cost_rate,
            currency: row.currency,
          },
        },
      ]);
      return row;
    });
  }

  removeCostRate(principal: Principal, ctx: RequestContext, personId: string, id: string): Promise<void> {
    return this.uow.operator(async (tx) => {
      const before = (await this.rates.ofPerson(tx, personId)).find((row) => row.id === id);
      await this.rates.remove(tx, personId, id);
      if (before)
        await this.audit.operator(tx, actorOf(principal), ctx, [
          {
            entityKind: 'person_cost_rate',
            entityId: id,
            eventType: 'deleted',
            oldValue: { effective_from: before.effective_from, cost_rate: before.cost_rate },
            newValue: {},
          },
        ]);
    });
  }

  /**
   * One account's margin over a window, from the finance lines billing
   * itself charges from, so the two can never disagree about revenue.
   */
  ofAccount(principal: Principal, accountId: string, query: ProfitabilityQueryDto): Promise<Profitability> {
    return this.uow.run(principal, async (tx) => {
      const [lines, costs] = await Promise.all([
        this.time.financeLines(tx, accountId, query.from, query.to),
        this.rates.forAccountWindow(tx, accountId, query.from, query.to),
      ]);
      return profitability(lines, costs);
    });
  }
}

@ApiTags('time')
@ApiBearerAuth()
@Controller()
export class ProfitabilityController {
  constructor(private readonly service: ProfitabilityService) {}

  @Get('people/:personId/cost-rates')
  @RequirePermission('finance:view-margin')
  costRates(@CurrentPrincipal() principal: Principal, @Param() params: PersonParam) {
    return this.service.costRates(principal, params.personId);
  }

  @Put('people/:personId/cost-rates')
  @RequirePermission('finance:manage-cost')
  setCostRate(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param() params: PersonParam,
    @Body() dto: SetCostRateDto,
  ) {
    return this.service.setCostRate(principal, ctx, params.personId, dto);
  }

  @Delete('people/:personId/cost-rates/:id')
  @HttpCode(204)
  @RequirePermission('finance:manage-cost')
  removeCostRate(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param() params: CostRateParam,
  ) {
    return this.service.removeCostRate(principal, ctx, params.personId, params.id);
  }

  @Get('accounts/:accountId/profitability')
  @RequirePermission('finance:view-margin')
  ofAccount(
    @CurrentPrincipal() principal: Principal,
    @Param('accountId') accountId: string,
    @Query() query: ProfitabilityQueryDto,
  ) {
    return this.service.ofAccount(principal, accountId, query);
  }
}

@Module({
  providers: [CostRatesRepository, ProfitabilityService, TimeRepository],
  controllers: [ProfitabilityController],
  exports: [ProfitabilityService],
})
export class ProfitabilityModule {}
