import { Module } from '@nestjs/common';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import { AdminCoreModule } from '../admin/admin.module.js';
import { ContractsCoreModule } from '../contracts/contracts.module.js';
import { CalendarsCoreModule } from '../calendars/calendars.module.js';
import { NotificationsController, NotificationsService } from '../notifications/notifications.controller.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import { CatalogsController } from './catalogs.controller.js';
import { TicketsController } from './tickets.controller.js';
import { TicketsRepository } from './tickets.repository.js';
import { TicketsService } from './tickets.service.js';
import { RoutingCoreModule } from './routing.module.js';
import { ViewsController, ViewsRepository, ViewsService } from './views.js';
import { TimeRepository } from '../time/time.repository.js';
import { KnowledgeRepository } from '../knowledge/knowledge.repository.js';

/** Providers only, shared by the API and the worker (the worker never mounts controllers). */
@Module({
  imports: [AdminCoreModule, ContractsCoreModule, CalendarsCoreModule, RoutingCoreModule],
  providers: [
    TicketsRepository,
    TicketsService,
    NotificationsRepository,
    NotificationsService,
    OutboxService,
    ViewsRepository,
    ViewsService,
    TimeRepository,
    KnowledgeRepository,
  ],
  exports: [
    TicketsService,
    TicketsRepository,
    NotificationsRepository,
    NotificationsService,
    OutboxService,
    ViewsService,
    TimeRepository,
    KnowledgeRepository,
    AdminCoreModule,
    ContractsCoreModule,
    RoutingCoreModule,
  ],
})
export class TicketsCoreModule {}

/** Ticket Management (02-modules/ticket-management) with its notification feed and saved views. */
@Module({
  imports: [TicketsCoreModule],
  controllers: [TicketsController, NotificationsController, ViewsController, CatalogsController],
  exports: [TicketsCoreModule],
})
export class TicketsModule {}
