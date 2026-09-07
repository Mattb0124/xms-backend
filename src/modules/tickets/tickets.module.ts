import { Module } from '@nestjs/common';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import { AdminModule } from '../admin/admin.module.js';
import { ContractsModule } from '../contracts/contracts.module.js';
import { NotificationsController, NotificationsService } from '../notifications/notifications.controller.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import { TicketsController } from './tickets.controller.js';
import { TicketsRepository } from './tickets.repository.js';
import { TicketsService } from './tickets.service.js';

/** Ticket Management (02-modules/ticket-management) with its notification feed. */
@Module({
  imports: [AdminModule, ContractsModule],
  controllers: [TicketsController, NotificationsController],
  providers: [TicketsRepository, TicketsService, NotificationsRepository, NotificationsService, OutboxService],
  exports: [TicketsService, TicketsRepository, NotificationsRepository, OutboxService],
})
export class TicketsModule {}
