import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, RequirePermission } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { ConfigService } from '../admin/config/config.service.js';

/**
 * Read-only catalogs for the desk (resolution codes, activity types,
 * billable classes, the state machine of a type) resolved for one granted
 * account so a consultant never needs admin:config to fill a form.
 */
@ApiTags('tickets')
@ApiBearerAuth()
@Controller('catalogs')
@RequirePermission('tickets:view')
export class CatalogsController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async catalogs(@CurrentPrincipal() principal: Principal, @Query('account_id') accountId?: string) {
    const scope = accountId && principal.accountIds.includes(accountId) ? accountId : undefined;
    return this.uow.run(principal, async (tx) => {
      const resolutionCodes = await this.config.resolve<{ items: unknown[] }>(tx, 'resolution_codes', '*', scope);
      const activityTypes = await this.config.resolve<{ items: unknown[] }>(tx, 'activity_types', '*', scope);
      const billableClasses = await this.config.resolve<{ items: unknown[] }>(tx, 'billable_classes', '*', scope);
      return {
        resolution_codes: resolutionCodes.body.items,
        activity_types: activityTypes.body.items,
        billable_classes: billableClasses.body.items,
      };
    });
  }

  @Get('state-machine')
  async stateMachine(
    @CurrentPrincipal() principal: Principal,
    @Query('type') type: string,
    @Query('account_id') accountId?: string,
  ) {
    const scope = accountId && principal.accountIds.includes(accountId) ? accountId : undefined;
    return this.uow.run(principal, async (tx) => (await this.config.stateMachine(tx, type, scope)).machine.body);
  }
}
