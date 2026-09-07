import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { isPermission, type Permission } from '../../contracts/permissions.js';
import { SecurityEventsService, type SecurityEvent } from '../events/security-events.service.js';
import { AXEL_ROUTE_KEY, PERMISSION_KEY, REALM_KEY, type Realm, type RequestContext } from './decorators.js';
import { actorKindOf, type Principal } from './principal.js';
import { API_KEY_PREFIX, PrincipalRepository, type UserRow } from './principal.repository.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { TokenRejectedError, TokenVerifiers, type VerifiedToken } from './token-verifier.js';

/**
 * The single guard (Security & Tenancy 2.2, 3). Order of checks for every
 * non-public route:
 *
 *   1. bearer present            else 401 auth.token.rejected
 *   2. token verified once       else 401 auth.token.rejected (reason)
 *   3. principal resolved        else 401 auth.signin.failed
 *   4. realm matches the route   else 403 authz.realm.denied
 *   5. permission held           else 403 authz.permission.denied
 *
 * Every denial writes one security event; the first request of a session
 * writes auth.signin.success. The principal is attached to the request for
 * `@CurrentPrincipal()`; nothing else on the request is identity.
 */
export interface AuthGuardOptions {
  readonly internalOrgSlug: string;
}

export const AUTH_GUARD_OPTIONS = 'AUTH_GUARD_OPTIONS';

type GuardedRequest = Request & {
  principal?: Principal;
  requestContext?: RequestContext;
};

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly seenSessions = new Map<string, true>();

  constructor(
    private readonly reflector: Reflector,
    private readonly verifiers: TokenVerifiers,
    private readonly principals: PrincipalRepository,
    private readonly events: SecurityEventsService,
    @Inject(AUTH_GUARD_OPTIONS) private readonly options: AuthGuardOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<string | undefined>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const ctx = request.requestContext ?? { requestId: 'unknown' };
    const route = `${request.method} ${request.route?.path ?? request.path}`;
    const base = {
      requestId: ctx.requestId,
      ipHash: ctx.ipHash,
      userAgentFamily: ctx.userAgentFamily,
      attrs: { route },
    };

    const token = bearerOf(request);
    if (!token) {
      await this.deny({
        ...base,
        type: 'auth.token.rejected',
        actorKind: 'anonymous',
        attrs: { ...base.attrs, reason: 'missing' },
      });
      throw new UnauthorizedException({ code: 'unauthenticated' });
    }

    const axelRoute = Boolean(this.reflector.getAllAndOverride<boolean>(AXEL_ROUTE_KEY, targets));
    const principal = token.startsWith(API_KEY_PREFIX)
      ? await this.resolveApiClient(token, base)
      : await this.resolveToken(token, axelRoute, base);

    const realm = this.reflector.getAllAndOverride<Realm | undefined>(REALM_KEY, targets) ?? 'internal';
    const realmOk =
      realm === 'any' ? true : realm === 'portal' ? principal.kind === 'portal' : principal.kind !== 'portal';
    if (!realmOk) {
      await this.deny({
        ...base,
        ...actor(principal),
        type: 'authz.realm.denied',
        attrs: { ...base.attrs, realm },
      });
      throw new ForbiddenException({ code: 'wrong_realm' });
    }

    const required = this.reflector.getAllAndOverride<Permission | 'authenticated' | undefined>(
      PERMISSION_KEY,
      targets,
    );
    if (!required) {
      // The startup check makes this unreachable; kept as the fail-closed default.
      throw new InternalServerErrorException({
        code: 'route_without_permission',
        route,
      });
    }
    if (required !== 'authenticated' && !principal.permissions.has(required)) {
      await this.deny({
        ...base,
        ...actor(principal),
        type: 'authz.permission.denied',
        attrs: { ...base.attrs, permission: required },
      });
      throw new ForbiddenException({ code: 'forbidden', permission: required });
    }

    request.principal = principal;
    return true;
  }

  private async resolveToken(token: string, axelRoute: boolean, base: EventBase): Promise<Principal> {
    let verified: VerifiedToken;
    try {
      verified = await this.verifiers.verify(token);
    } catch (error) {
      const reason = error instanceof TokenRejectedError ? error.reason : 'garbage';
      await this.deny({
        ...base,
        type: 'auth.token.rejected',
        actorKind: 'anonymous',
        attrs: { ...base.attrs, reason },
      });
      throw new UnauthorizedException({ code: 'invalid_token' });
    }
    if (verified.type === 'clerk_agents' && !axelRoute) {
      await this.deny({
        ...base,
        type: 'auth.token.rejected',
        actorKind: 'anonymous',
        actorId: verified.subject,
        attrs: { ...base.attrs, reason: 'bad_audience' },
      });
      throw new UnauthorizedException({ code: 'invalid_token' });
    }

    const user = await this.findUser(verified);
    if (!user) {
      await this.deny({
        ...base,
        type: 'auth.signin.failed',
        actorKind: 'anonymous',
        actorId: verified.subject,
        attrs: {
          ...base.attrs,
          reason: 'unknown_user',
          tokenType: verified.type,
        },
      });
      throw new UnauthorizedException({ code: 'unknown_user' });
    }
    if (user.status === 'deactivated' || user.kind === 'service') {
      await this.deny({
        ...base,
        type: 'auth.signin.failed',
        actorKind: user.kind === 'portal' ? 'portal_user' : 'user',
        actorId: user.id,
        attrs: {
          ...base.attrs,
          reason: user.status === 'deactivated' ? 'deactivated' : 'service_user',
        },
      });
      throw new UnauthorizedException({ code: 'user_inactive' });
    }
    if (verified.type === 'clerk' || verified.type === 'clerk_agents') {
      const expectedOrg = user.kind === 'portal' ? undefined : this.options.internalOrgSlug;
      // Portal organisations are `acct-<key>`; the account check happens
      // through the user's own account_id, the org slug must at least be a
      // portal organisation and not the internal one.
      const orgOk =
        user.kind === 'portal'
          ? Boolean(verified.orgSlug && verified.orgSlug.startsWith('acct-'))
          : verified.orgSlug === expectedOrg;
      if (!orgOk) {
        await this.deny({
          ...base,
          type: 'auth.signin.failed',
          actorKind: user.kind === 'portal' ? 'portal_user' : 'user',
          actorId: user.id,
          attrs: { ...base.attrs, reason: 'wrong_organisation' },
        });
        throw new UnauthorizedException({ code: 'wrong_organisation' });
      }
    }

    const access = await this.principals.resolveAccess(user);
    const principal: Principal = {
      kind: verified.type === 'harness' ? 'harness' : user.kind === 'portal' ? 'portal' : 'internal',
      userId: user.id,
      email: user.email,
      displayName: `${user.first_name} ${user.last_name}`.trim() || user.email,
      accountIds: access.accountIds,
      permissions: access.permissions,
      sessionId: verified.sessionId,
      tokenType: verified.type,
    };
    await this.noteSession(principal, base);
    return principal;
  }

  private async findUser(verified: VerifiedToken): Promise<UserRow | undefined> {
    if (verified.type === 'harness') {
      return verified.email ? this.principals.findUserByEmail(verified.email) : undefined;
    }
    const byClerk = await this.principals.findUserByClerkId(verified.subject);
    if (byClerk) return byClerk;
    if (!verified.email) return undefined;
    // First sign-in of a pre-invited user: bind the Clerk subject by email.
    const byEmail = await this.principals.findUserByEmail(verified.email);
    if (!byEmail) return undefined;
    await this.principals.attachClerkId(byEmail.id, verified.subject);
    return {
      ...byEmail,
      status: byEmail.status === 'invited' ? 'active' : byEmail.status,
    };
  }

  private async resolveApiClient(token: string, base: EventBase): Promise<Principal> {
    const client = await this.principals.findApiClient(token);
    const expired = client?.expires_at ? new Date(client.expires_at).getTime() < Date.now() : false;
    if (!client || client.status !== 'active' || expired) {
      await this.deny({
        ...base,
        type: 'auth.apikey.rejected',
        actorKind: 'anonymous',
        attrs: {
          ...base.attrs,
          reason: !client ? 'unknown' : expired ? 'expired' : 'revoked',
          prefix: token.slice(0, 12),
        },
      });
      throw new UnauthorizedException({ code: 'invalid_api_key' });
    }
    const user = await this.principals.findUserById(client.service_user_id);
    if (!user) throw new UnauthorizedException({ code: 'invalid_api_key' });
    await this.principals.touchApiClient(client.id);
    const principal: Principal = {
      kind: 'api_client',
      userId: user.id,
      email: user.email,
      displayName: client.name,
      accountIds: client.accountIds,
      permissions: new Set(client.scopes.filter(isPermission)),
      sessionId: client.id,
      tokenType: 'api_key',
    };
    await this.events.write({
      ...base,
      ...actor(principal),
      type: 'auth.apikey.used',
      outcome: 'success',
      attrs: { ...base.attrs, apiClientId: client.id },
    });
    return principal;
  }

  private async noteSession(principal: Principal, base: EventBase): Promise<void> {
    const key = principal.sessionId ?? `${principal.userId}:${principal.tokenType}`;
    if (this.seenSessions.has(key)) return;
    if (this.seenSessions.size > 5000) {
      const oldest = this.seenSessions.keys().next().value;
      if (oldest) this.seenSessions.delete(oldest);
    }
    this.seenSessions.set(key, true);
    await this.principals.touchSignIn(principal.userId);
    await this.events.write({
      ...base,
      ...actor(principal),
      type: 'auth.signin.success',
      outcome: 'success',
      attrs: { ...base.attrs, tokenType: principal.tokenType },
    });
  }

  private async deny(event: Omit<SecurityEvent, 'outcome'>): Promise<void> {
    await this.events.write({ ...event, outcome: 'denied' });
  }
}

type EventBase = {
  requestId: string;
  ipHash?: string;
  userAgentFamily?: string;
  attrs: Record<string, unknown>;
};

function actor(
  principal: Principal,
): Pick<SecurityEvent, 'actorKind' | 'actorId' | 'actorName' | 'principalKind' | 'sessionId'> {
  return {
    actorKind: actorKindOf(principal),
    actorId: principal.userId,
    actorName: principal.displayName,
    principalKind: principal.kind,
    sessionId: principal.sessionId,
  };
}

function bearerOf(request: Request): string | undefined {
  const header = request.header('authorization');
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return undefined;
  return value.trim();
}
