import { Controller, Get, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Authenticated, CurrentPrincipal, RequestCtx, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { Public } from '../../common/auth/public.decorator.js';
import { GLOBAL_ACCOUNT_ID } from '../../common/auth/principal.repository.js';
import { AccountsService } from './accounts/accounts.service.js';
import { BootstrapService } from './bootstrap.service.js';

/** `GET /v1/admin/me`: the principal the web shell gates on (display only; the API decides). */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
export class MeController {
  constructor(private readonly accounts: AccountsService) {}

  @Get('me')
  @Authenticated()
  async me(@CurrentPrincipal() principal: Principal) {
    const accounts = await this.accounts.granted(principal);
    return {
      principal: {
        kind: principal.kind,
        userId: principal.userId,
        email: principal.email,
        displayName: principal.displayName,
        accountIds: principal.accountIds.filter((id) => id !== GLOBAL_ACCOUNT_ID),
        permissions: [...principal.permissions].sort(),
      },
      accounts,
    };
  }
}

@ApiTags('bootstrap')
@Controller('bootstrap')
export class BootstrapController {
  constructor(private readonly bootstrap: BootstrapService) {}

  @Post()
  @Public('bootstrap: gated inside on the configured administrator emails and an empty administrator set')
  run(@Req() request: Request, @RequestCtx() ctx: RequestContext) {
    const header = request.header('authorization');
    const bearer = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
    return this.bootstrap.bootstrap(bearer, ctx);
  }
}
