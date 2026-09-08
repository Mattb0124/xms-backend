import { Body, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';

/**
 * Assignment group routing defaults (TM-08; Accounts & Administration
 * functional 5.4 and 5.6). An account says which group takes which kind of
 * work; a ticket created without a group is dispatched by the most specific
 * rule that matches, and a ticket created with one keeps what the caller
 * asked for. Nothing here reassigns an existing ticket: a default is a
 * starting point, not a rule the desk cannot override.
 *
 * The whole set is reconciled with one PUT, the same shape as group
 * membership, so a rule cannot be half-saved and the audit row carries the
 * before and after of the set rather than a row at a time.
 */
export const ROUTABLE_TYPES = ['incident', 'service_request', 'change', 'problem', 'project_task'] as const;
export type RoutableType = (typeof ROUTABLE_TYPES)[number];

export interface RoutingRuleRow {
  id: string;
  account_id: string;
  ticket_type: RoutableType;
  category: string | null;
  group_id: string;
  created_at: string;
  updated_at: string;
  version: number;
}

@Injectable()
export class RoutingRepository extends RepositoryBase {
  forAccount(tx: Tx, accountId: string): Promise<(RoutingRuleRow & { group_name: string })[]> {
    return this.many<RoutingRuleRow & { group_name: string }>(
      tx,
      `select r.*, g.name as group_name
         from acct.group_routing_rules r
         join op.assignment_groups g on g.id = r.group_id
        where r.account_id = $1
        order by r.ticket_type, coalesce(r.category, '')`,
      [accountId],
    );
  }

  /**
   * The group an account routes this work to: the rule naming the category
   * wins over the rule for the type as a whole, and a retired group routes
   * nothing (the rule stays, so restoring the group restores the routing).
   */
  async resolve(tx: Tx, accountId: string, type: string, category: string | null): Promise<string | null> {
    const rows = await this.many<{ group_id: string; category: string | null }>(
      tx,
      `select r.group_id, r.category
         from acct.group_routing_rules r
         join op.assignment_groups g on g.id = r.group_id and g.status = 'active'
        where r.account_id = $1 and r.ticket_type = $2 and (r.category is null or r.category = $3)
        order by (r.category is null)`,
      [accountId, type, category],
    );
    return rows[0]?.group_id ?? null;
  }

  async replace(
    tx: Tx,
    accountId: string,
    rules: readonly { ticket_type: RoutableType; category: string | null; group_id: string }[],
  ): Promise<void> {
    await tx.query('delete from acct.group_routing_rules where account_id = $1', [accountId]);
    for (const rule of rules) {
      await tx.query(
        'insert into acct.group_routing_rules (account_id, ticket_type, category, group_id) values ($1, $2, $3, $4)',
        [accountId, rule.ticket_type, rule.category, rule.group_id],
      );
    }
  }
}

export class RoutingRuleDto {
  @IsIn(ROUTABLE_TYPES) ticket_type!: RoutableType;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) category?: string | null;

  @IsUUID('4') group_id!: string;
}

export class ReplaceRoutingRulesDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RoutingRuleDto)
  rules!: RoutingRuleDto[];
}

@Injectable()
export class RoutingService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly routing: RoutingRepository,
    private readonly audit: AuditService,
  ) {}

  list(principal: Principal, accountId: string): Promise<RoutingRuleRow[]> {
    return this.uow.run(principal, (tx) => this.routing.forAccount(tx, accountId));
  }

  replace(
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    dto: ReplaceRoutingRulesDto,
  ): Promise<RoutingRuleRow[]> {
    const rules = dto.rules.map((rule) => ({
      ticket_type: rule.ticket_type,
      category: rule.category?.trim() ? rule.category.trim() : null,
      group_id: rule.group_id,
    }));
    return this.uow.run(principal, async (tx) => {
      const before = await this.routing.forAccount(tx, accountId);
      await this.routing.replace(tx, accountId, rules);
      const after = await this.routing.forAccount(tx, accountId);
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'group_routing',
          entityId: accountId,
          eventType: 'updated',
          field: 'rules',
          oldValue: before.map(summary),
          newValue: after.map(summary),
        },
      ]);
      return after;
    });
  }
}

function summary(rule: RoutingRuleRow): Record<string, unknown> {
  return { ticket_type: rule.ticket_type, category: rule.category, group_id: rule.group_id };
}

/**
 * Reading the defaults is part of seeing the desk (the New ticket form shows
 * which group work will land in); changing them is configuration, which is
 * `admin:config` like every other catalog.
 */
@ApiTags('tickets')
@ApiBearerAuth()
@Controller('accounts/:accountId/routing-rules')
export class RoutingController {
  constructor(private readonly routing: RoutingService) {}

  @Get()
  @RequirePermission('tickets:view')
  list(@CurrentPrincipal() principal: Principal, @Param('accountId', ParseUUIDPipe) accountId: string) {
    return this.routing.list(principal, accountId);
  }

  @Put()
  @RequirePermission('admin:config')
  replace(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: ReplaceRoutingRulesDto,
  ) {
    return this.routing.replace(principal, ctx, accountId, dto);
  }
}

@Module({
  providers: [RoutingRepository, RoutingService],
  exports: [RoutingRepository, RoutingService],
})
export class RoutingCoreModule {}

@Module({
  imports: [RoutingCoreModule],
  controllers: [RoutingController],
  exports: [RoutingCoreModule],
})
export class RoutingModule {}
