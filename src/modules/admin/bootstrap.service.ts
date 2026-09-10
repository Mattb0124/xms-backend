import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '../../common/auth/decorators.js';
import { TokenRejectedError, TokenVerifiers } from '../../common/auth/token-verifier.js';
import { SYSTEM_ACTOR, AuditService } from '../../common/audit/audit.service.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import { loadEnv } from '../../config/env.js';
import { SYSTEM_ROLES } from '../../contracts/permissions.js';
import type { Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { ConfigService } from './config/config.service.js';
import { UsersRepository } from './users/users.repository.js';

/**
 * First administrator (Accounts & Administration technical 3.3, P1.3.7).
 * `POST /v1/bootstrap` is public in the guard's sense but gated here: the
 * bearer must verify, its email must be in BOOTSTRAP_ADMIN_EMAILS, and the
 * administrator set must be empty. It seeds the system roles and the
 * configuration defaults, creates the user, assigns Administrator, and
 * writes auth.bootstrap.completed. Idempotent once an administrator exists
 * (409), so it cannot be replayed to add a second one.
 */
@Injectable()
export class BootstrapService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly users: UsersRepository,
    private readonly verifiers: TokenVerifiers,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Seeds the system roles when missing and reconciles the ones already
   * there; safe to call on every boot.
   *
   * Creating only was not enough. A permission added to a bundle in code
   * never reached a database that had already been bootstrapped, so a new
   * capability shipped with nobody able to reach it: the key existed, every
   * route declared it, and no role carried it.
   *
   * Reconciliation is additive on purpose. An administrator may edit a
   * system role's permissions (only its name and its retirement are fixed),
   * so a narrowed role is a deliberate act and setting the list back to the
   * catalog's would silently undo it on the next boot. Adding what the
   * catalog says the role should have, and never taking anything away, gets
   * a new capability to the roles meant to hold it while leaving an
   * operator's own decisions standing. A permission dropped from a bundle in
   * code therefore has to be revoked by hand, which is the trade this makes.
   */
  async ensureSystemRoles(tx: Tx): Promise<string[]> {
    const changed: string[] = [];
    for (const catalog of ['operator', 'portal'] as const) {
      for (const [name, permissions] of Object.entries(SYSTEM_ROLES[catalog])) {
        const existing = await this.users.roleByName(tx, catalog, name);
        if (!existing) {
          await this.users.insertRole(tx, {
            catalog,
            name,
            permissions: [...permissions],
            is_system: true,
            description: `System role: ${name}`,
          });
          changed.push(`${catalog}:${name}`);
          continue;
        }
        const missing = permissions.filter((key) => !existing.permissions.includes(key));
        if (missing.length === 0) continue;
        await this.users.updateRole(tx, existing.id, existing.version, {
          permissions: [...existing.permissions, ...missing],
        });
        changed.push(`${catalog}:${name} +${missing.join(',')}`);
      }
    }
    return changed;
  }

  async bootstrap(bearer: string | undefined, ctx: RequestContext): Promise<{ userId: string; email: string }> {
    if (!bearer) throw new UnauthorizedException({ code: 'unauthenticated' });
    let verified;
    try {
      verified = await this.verifiers.verify(bearer);
    } catch (error) {
      await this.security.write({
        type: 'auth.token.rejected',
        outcome: 'denied',
        actorKind: 'anonymous',
        requestId: ctx.requestId,
        attrs: { route: 'POST /v1/bootstrap', reason: error instanceof TokenRejectedError ? error.reason : 'garbage' },
      });
      throw new UnauthorizedException({ code: 'invalid_token' });
    }
    // The allowlisted email is not enough on its own: a token from any
    // organisation in the Clerk instance, a portal `acct-*` one included,
    // must not become the first administrator.
    if (
      (verified.type === 'clerk' || verified.type === 'clerk_agents') &&
      verified.orgSlug !== loadEnv().CLERK_INTERNAL_ORG_SLUG
    ) {
      await this.security.write({
        type: 'auth.signin.failed',
        outcome: 'denied',
        actorKind: 'anonymous',
        actorId: verified.subject,
        requestId: ctx.requestId,
        attrs: { route: 'POST /v1/bootstrap', reason: 'wrong_organisation' },
      });
      throw new UnauthorizedException({ code: 'wrong_organisation' });
    }
    const email = verified.email?.toLowerCase();
    const allowed = loadEnv().BOOTSTRAP_ADMIN_EMAILS.map((item) => item.toLowerCase());
    if (!email || !allowed.includes(email)) {
      await this.security.write({
        type: 'authz.permission.denied',
        outcome: 'denied',
        actorKind: 'anonymous',
        actorId: verified.subject,
        requestId: ctx.requestId,
        attrs: { route: 'POST /v1/bootstrap', reason: 'not_bootstrap_email' },
      });
      throw new UnauthorizedException({ code: 'not_allowed' });
    }
    await this.config.ensureDefaults();
    return this.uow.operator(async (tx) => {
      await this.ensureSystemRoles(tx);
      const admins = await this.users.administrators(tx);
      if (admins.length > 0) throw new ConflictException({ code: 'already_bootstrapped' });
      const existing = await this.users.byEmail(tx, email);
      const user =
        existing ??
        (await this.users.insert(tx, {
          kind: 'internal',
          email,
          clerk_user_id: verified.subject,
          status: 'active',
          first_name: 'Administrator',
        }));
      if (!existing) {
        // nothing more
      } else if (!existing.clerk_user_id) {
        await tx.query(`update op.users set clerk_user_id = $2, status = 'active' where id = $1`, [
          existing.id,
          verified.subject,
        ]);
      }
      const administrator = (await this.users.roleByName(tx, 'operator', 'Administrator'))!;
      await this.users.replaceAssignments(tx, user.id, [{ roleId: administrator.id, accountId: null }]);
      await this.audit.operator(tx, SYSTEM_ACTOR, ctx, [
        { entityKind: 'user', entityId: user.id, eventType: 'created', newValue: { email, bootstrap: true } },
      ]);
      await this.security.write(
        {
          type: 'auth.bootstrap.completed',
          outcome: 'success',
          actorKind: 'user',
          actorId: user.id,
          actorName: email,
          principalKind: 'internal',
          requestId: ctx.requestId,
          entityKind: 'user',
          entityId: user.id,
          attrs: { email },
        },
        tx,
      );
      return { userId: user.id, email };
    });
  }
}
