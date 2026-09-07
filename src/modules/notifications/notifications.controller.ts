import { Controller, Get, Injectable, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Authenticated, CurrentPrincipal, RealmOf } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { NotificationsRepository } from './notifications.repository.js';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly notifications: NotificationsRepository,
  ) {}

  feed(principal: Principal, before?: string, limit = 50) {
    return this.uow.run(principal, (tx) => this.notifications.feed(tx, principal.userId, before, Math.min(limit, 200)));
  }

  async unreadCount(principal: Principal): Promise<{ count: number }> {
    return { count: await this.uow.run(principal, (tx) => this.notifications.unreadCount(tx, principal.userId)) };
  }

  markRead(principal: Principal, id: string) {
    return this.uow.run(principal, (tx) => this.notifications.markRead(tx, principal.userId, id));
  }

  async markAllRead(principal: Principal): Promise<{ updated: number }> {
    return { updated: await this.uow.run(principal, (tx) => this.notifications.markAllRead(tx, principal.userId)) };
  }
}

/** The feed is per recipient across the principal's accounts; both realms read their own rows only. */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
@RealmOf('any')
@Authenticated()
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  feed(@CurrentPrincipal() principal: Principal, @Query('before') before?: string, @Query('limit') limit?: string) {
    return this.service.feed(principal, before, limit ? Number(limit) : undefined);
  }

  @Get('unread-count')
  unreadCount(@CurrentPrincipal() principal: Principal) {
    return this.service.unreadCount(principal);
  }

  @Post('read-all')
  readAll(@CurrentPrincipal() principal: Principal) {
    return this.service.markAllRead(principal);
  }

  @Patch(':id/read')
  read(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.markRead(principal, id);
  }
}
