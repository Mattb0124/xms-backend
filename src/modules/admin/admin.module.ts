import { Module } from '@nestjs/common';
import { ClerkAdminClient } from '../../common/clerk/clerk-admin.js';
import { loadEnv } from '../../config/env.js';
import { AccountsController, AdminAccountsController } from './accounts/accounts.controller.js';
import { AccountsRepository } from './accounts/accounts.repository.js';
import { AccountsService } from './accounts/accounts.service.js';
import { BootstrapController, MeController } from './admin.controller.js';
import { BootstrapService } from './bootstrap.service.js';
import { AdminConfigController } from './config/config.controller.js';
import { ConfigRepository, ConfigService } from './config/config.service.js';
import { AdminUsersController, DirectoryController } from './users/users.controller.js';
import { UsersRepository } from './users/users.repository.js';
import { UsersService } from './users/users.service.js';

/**
 * Accounts & Administration (02-modules/accounts-and-administration).
 * Controller, service, repository and DTOs colocated per entity; the
 * configuration resolver is exported for the ticket module.
 */
@Module({
  controllers: [
    MeController,
    BootstrapController,
    AdminAccountsController,
    AccountsController,
    AdminUsersController,
    DirectoryController,
    AdminConfigController,
  ],
  providers: [
    AccountsRepository,
    AccountsService,
    UsersRepository,
    UsersService,
    ConfigRepository,
    ConfigService,
    BootstrapService,
    { provide: ClerkAdminClient, useFactory: (): ClerkAdminClient => new ClerkAdminClient(loadEnv().CLERK_SECRET_KEY) },
  ],
  exports: [ConfigService, AccountsRepository, UsersRepository, AccountsService, UsersService],
})
export class AdminModule {}
