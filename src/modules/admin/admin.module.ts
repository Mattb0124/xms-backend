import { Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ClerkAdminClient } from '../../common/clerk/clerk-admin.js';
import { loadEnv } from '../../config/env.js';
import { AccountsController, AdminAccountsController } from './accounts/accounts.controller.js';
import { AccountsRepository } from './accounts/accounts.repository.js';
import { AccountsService } from './accounts/accounts.service.js';
import { BootstrapController, MeController } from './admin.controller.js';
import { BootstrapService } from './bootstrap.service.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { AccountConfigController, AdminConfigController } from './config/config.controller.js';
import { ConfigRepository, ConfigService } from './config/config.service.js';
import { AdminUsersController, DirectoryController } from './users/users.controller.js';
import { UsersRepository } from './users/users.repository.js';
import { UsersService } from './users/users.service.js';

/**
 * Accounts & Administration (02-modules/accounts-and-administration).
 * Controller, service, repository and DTOs colocated per entity; the
 * configuration resolver is exported for the ticket module.
 */
/** Providers only, shared by the API and the worker; no controllers. */
@Module({
  providers: [
    AccountsRepository,
    AccountsService,
    UsersRepository,
    UsersService,
    ConfigRepository,
    ConfigService,
    { provide: ClerkAdminClient, useFactory: (): ClerkAdminClient => new ClerkAdminClient(loadEnv().CLERK_SECRET_KEY) },
  ],
  exports: [
    AccountsRepository,
    AccountsService,
    UsersRepository,
    UsersService,
    ConfigRepository,
    ConfigService,
    ClerkAdminClient,
  ],
})
export class AdminCoreModule {}

@Module({
  imports: [AdminCoreModule],
  controllers: [
    MeController,
    BootstrapController,
    AdminAccountsController,
    AccountsController,
    AdminUsersController,
    DirectoryController,
    AdminConfigController,
    AccountConfigController,
  ],
  providers: [BootstrapService],
  exports: [AdminCoreModule],
})
export class AdminModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminModule.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly bootstrap: BootstrapService,
  ) {}

  /**
   * Reconcile the system roles every time the application starts.
   *
   * Doing it inside the bootstrap route was no use: that route throws
   * `already_bootstrapped` on a system that has an administrator, and the
   * throw rolls the reconciliation back with it, so a permission added to a
   * bundle in code never reached anybody.
   *
   * It is additive and idempotent, so both the API and the worker may run it
   * and a second run finds nothing to do. A race between them shows up as a
   * version conflict on the role row; the other process has already made the
   * change, so it is logged and left rather than retried.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const changed = await this.uow.operator((tx) => this.bootstrap.ensureSystemRoles(tx));
      if (changed.length > 0) this.logger.log(`system roles reconciled: ${changed.join('; ')}`);
    } catch (error) {
      this.logger.warn(`system roles were not reconciled: ${(error as Error).message}`);
    }
  }
}
