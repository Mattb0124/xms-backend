import { Module } from '@nestjs/common';
import { DevAuthController, DevUsersRepository } from './dev-auth.module.js';

/**
 * The local development sign-in (AIBL-331). The controller is always
 * registered so the route snapshot is the same everywhere; it answers 404
 * unless `AUTH_DEV_SECRET` is set and NODE_ENV is not production, and the
 * environment contract refuses to boot a production process that has that
 * secret at all.
 */
@Module({
  controllers: [DevAuthController],
  providers: [DevUsersRepository],
})
export class DevModule {}
