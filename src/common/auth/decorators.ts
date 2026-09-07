import {
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import type { Permission } from '../../contracts/permissions.js';
import type { Principal } from './principal.js';

export const PERMISSION_KEY = 'xms:permission';
export const REALM_KEY = 'xms:realm';
export const AXEL_ROUTE_KEY = 'xms:axelRoute';

/**
 * Realms (Security & Tenancy 2.2): internal routes accept internal, API
 * client and harness principals; portal routes accept portal principals
 * only. A route is internal unless its controller says otherwise; a portal
 * token on an internal route is a 403 before any lookup.
 */
export type Realm = 'internal' | 'portal';

/** Declares the permission a route requires. Every non-public route must carry one. */
export const RequirePermission = (
  permission: Permission,
): MethodDecorator & ClassDecorator => SetMetadata(PERMISSION_KEY, permission);

/** Marks a route as authenticated with no specific permission (for example `/me`). */
export const Authenticated = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, 'authenticated');

export const RealmOf = (realm: Realm): MethodDecorator & ClassDecorator =>
  SetMetadata(REALM_KEY, realm);

/** Only these routes accept the long-lived Clerk `agents` token (Security 2.1). */
export const AxelRoute = (): MethodDecorator & ClassDecorator =>
  SetMetadata(AXEL_ROUTE_KEY, true);

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, context: ExecutionContext): Principal => {
    const request = context
      .switchToHttp()
      .getRequest<{ principal?: Principal }>();
    if (!request.principal)
      throw new Error('No principal on request; is the route guarded?');
    return request.principal;
  },
);

export interface RequestContext {
  readonly requestId: string;
  readonly ipHash?: string;
  readonly userAgentFamily?: string;
}

export const RequestCtx = createParamDecorator(
  (_: unknown, context: ExecutionContext): RequestContext => {
    const request = context
      .switchToHttp()
      .getRequest<{ requestContext?: RequestContext }>();
    return request.requestContext ?? { requestId: 'unknown' };
  },
);
