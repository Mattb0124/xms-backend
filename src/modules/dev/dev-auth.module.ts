import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';
import { RequestCtx, type RequestContext } from '../../common/auth/decorators.js';
import { Public } from '../../common/auth/public.decorator.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import { loadEnv } from '../../config/env.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { mintDevToken } from './dev-token.js';

/**
 * Sign in as a seeded user without a credential, on a developer's own machine
 * and nowhere else.
 *
 * This mints an authentication token for any named user with nothing to prove
 * it is them. That is an authentication bypass, deliberately, so it is fenced
 * three ways and none of the three leans on the others:
 *
 *   1. `src/config/env.ts` refuses to boot at all when `AUTH_DEV_SECRET` is
 *      set and NODE_ENV is production. The dev token path cannot exist in a
 *      production process.
 *   2. These routes answer 404 when `AUTH_DEV_SECRET` is absent, so a
 *      non-production environment that has not opted in serves nothing.
 *   3. They refuse when NODE_ENV is production regardless, which is only
 *      reachable if guard 1 is ever weakened.
 *
 * Every mint writes a security event, so a token handed out this way is as
 * visible in the audit stream as any other sign-in.
 *
 * The browser half needs no guard of its own beyond the one it has:
 * `frontend/lib/auth/dev-mode.ts` throws at build time if the dev sign-in is
 * enabled for any deploy target but `local` (security review finding 27).
 */
export class DevSignInDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

/** A person the sign-in page can offer, and what signing in as them gets you. */
export interface DevUserRow {
  email: string;
  display_name: string;
  kind: 'internal' | 'portal' | 'service';
  status: string;
  account_key: string | null;
  account_name: string | null;
  roles: string[];
}

@Injectable()
export class DevUsersRepository extends RepositoryBase {
  /**
   * Everyone who can be signed in as, with the role names that explain what
   * the choice is for. Service principals are left out: they authenticate
   * with an API key and have no desk to land on.
   */
  list(tx: Tx): Promise<DevUserRow[]> {
    return this.many<DevUserRow>(
      tx,
      `select u.email,
              coalesce(nullif(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email) as display_name,
              u.kind,
              u.status,
              a.key as account_key,
              a.name as account_name,
              coalesce(array_agg(distinct r.name) filter (where r.name is not null), '{}') as roles
         from op.users u
         left join op.accounts a on a.id = u.account_id
         left join op.role_assignments ra on ra.user_id = u.id
         left join op.roles r on r.id = ra.role_id and r.status = 'active'
        where u.kind <> 'service' and u.status <> 'deactivated'
        group by u.email, u.first_name, u.last_name, u.kind, u.status, a.key, a.name
        order by u.kind desc, a.key nulls first, u.email`,
    );
  }

  byEmail(tx: Tx, email: string): Promise<DevUserRow | undefined> {
    return this.maybeOne<DevUserRow>(
      tx,
      `select u.email,
              coalesce(nullif(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email) as display_name,
              u.kind,
              u.status,
              a.key as account_key,
              a.name as account_name,
              '{}'::text[] as roles
         from op.users u
         left join op.accounts a on a.id = u.account_id
        where lower(u.email) = lower($1) and u.kind <> 'service' and u.status <> 'deactivated'`,
      [email],
    );
  }
}

@ApiTags('dev')
@Controller('dev')
export class DevAuthController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly users: DevUsersRepository,
    private readonly security: SecurityEventsService,
  ) {}

  /** The dev secret, or nothing at all when this must not work here. */
  private secret(): string {
    const env = loadEnv();
    if (env.NODE_ENV === 'production' || !env.AUTH_DEV_SECRET) {
      // 404 rather than 403: an environment where this is switched off should
      // not advertise that the route was ever there.
      throw new NotFoundException({ code: 'not_found' });
    }
    return env.AUTH_DEV_SECRET;
  }

  @Get('users')
  @Public('Local development sign-in: lists the seeded users to pick from. Refuses without AUTH_DEV_SECRET.')
  listUsers(): Promise<DevUserRow[]> {
    this.secret();
    return this.uow.operator((tx) => this.users.list(tx));
  }

  @Post('sign-in')
  @Public('Local development sign-in: mints a token for a seeded user. Refuses without AUTH_DEV_SECRET.')
  async signIn(@Body() dto: DevSignInDto, @RequestCtx() ctx: RequestContext): Promise<{ token: string }> {
    const secret = this.secret();
    const user = await this.uow.operator((tx) => this.users.byEmail(tx, dto.email));
    if (!user) throw new BadRequestException({ code: 'unknown_user', email: dto.email });
    // A portal token is refused unless its org names the user's own account
    // (auth.guard `orgMatchesAccount`), so the server derives it rather than
    // letting the caller guess and get a confusing 401.
    if (user.kind === 'portal' && !user.account_key) {
      throw new BadRequestException({ code: 'portal_user_without_account', email: dto.email });
    }
    const token = await mintDevToken({
      secret,
      email: user.email,
      org: user.kind === 'portal' ? `acct-${user.account_key!.toLowerCase()}` : 'hackett',
    });
    // Handing out a token is a sign-in, and it is recorded as one.
    await this.security.write({
      type: 'auth.signin.success',
      outcome: 'success',
      actorKind: user.kind === 'portal' ? 'portal_user' : 'user',
      actorId: user.email,
      actorName: user.display_name,
      requestId: ctx.requestId,
      attrs: { route: 'POST /v1/dev/sign-in', devSignIn: true, kind: user.kind },
    });
    return { token };
  }
}
