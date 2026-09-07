import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'xms:isPublic';

/**
 * Opt a route out of the composed guard. Every use must carry a reason so the
 * route-and-permission snapshot (P1.3.5) can list it, and the security review
 * can see why. Health endpoints are the only expected users in Phase 1.
 */
export const Public = (reason = 'health'): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, reason);
