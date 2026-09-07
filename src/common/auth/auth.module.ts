import { Global, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule, ModuleRef } from '@nestjs/core';
import { loadEnv } from '../../config/env.js';
import { SecurityEventsService } from '../events/security-events.service.js';
import { AUTH_GUARD_OPTIONS, AuthGuard, type AuthGuardOptions } from './auth.guard.js';
import { PrincipalRepository } from './principal.repository.js';
import { collectRouteTable, undeclaredRoutes } from './route-table.js';
import { TokenVerifiers } from './token-verifier.js';

/**
 * Wires the composed guard globally and refuses to boot when any route has
 * neither a permission nor a public reason (Security & Tenancy 3).
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    PrincipalRepository,
    SecurityEventsService,
    {
      provide: TokenVerifiers,
      useFactory: (): TokenVerifiers => {
        const env = loadEnv();
        return new TokenVerifiers({
          clerk: env.CLERK_ISSUER
            ? {
                issuer: env.CLERK_ISSUER,
                jwksUrl: env.CLERK_JWKS_URL,
                authorizedParties: env.CLERK_AUTHORIZED_PARTIES,
                agentsAudience: env.CLERK_AGENTS_AUDIENCE,
              }
            : undefined,
          harnessSessionSecret: env.HARNESS_SESSION_SECRET,
          devSecret: env.AUTH_DEV_SECRET,
        });
      },
    },
    {
      provide: AUTH_GUARD_OPTIONS,
      useFactory: (): AuthGuardOptions => ({
        internalOrgSlug: loadEnv().CLERK_INTERNAL_ORG_SLUG,
      }),
    },
    AuthGuard,
    { provide: APP_GUARD, useExisting: AuthGuard },
  ],
  exports: [PrincipalRepository, SecurityEventsService, TokenVerifiers, AuthGuard],
})
export class AuthModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthModule.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  onApplicationBootstrap(): void {
    const table = collectRouteTable(this.moduleRef);
    const missing = undeclaredRoutes(table);
    if (missing.length > 0) {
      const list = missing
        .map((entry) => `${entry.method} ${entry.path} (${entry.controller}.${entry.handler})`)
        .join(', ');
      throw new Error(`Routes without a permission or @Public(reason): ${list}`);
    }
    this.logger.log(`${table.length} routes declared with a permission or a public reason`);
  }
}
