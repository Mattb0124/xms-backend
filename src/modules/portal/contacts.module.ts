import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';

/**
 * The account's contacts as the operator administers them (Client Portal
 * technical 2.1). The list exists so the flags can be set on a named
 * person: `executive_sponsor` is the flag the quarterly relationship
 * survey addresses (functional 5.7), `billing_contact` and `csat_recipient`
 * are the other two the specification names. The vocabulary is closed here
 * and again in the column's check constraint (migration 0032), so a typo
 * cannot silently drop someone from every future survey.
 */
export const CONTACT_FLAGS = ['executive_sponsor', 'billing_contact', 'csat_recipient'] as const;
export type ContactFlag = (typeof CONTACT_FLAGS)[number];

export interface ContactRecord {
  id: string;
  account_id: string;
  email: string;
  display_name: string;
  portal_user_id: string | null;
  status: string;
  flags: string[];
  created_at: string;
  updated_at: string;
  version: number;
}

@Injectable()
export class ContactsRepository extends RepositoryBase {
  list(tx: Tx, accountId: string, q: string | undefined, limit: number): Promise<ContactRecord[]> {
    return this.many<ContactRecord>(
      tx,
      `select id, account_id, email::text as email, display_name, portal_user_id, status, flags, created_at, updated_at, version
         from acct.contacts
        where account_id = $1 and ($2::text is null or email::text ilike '%' || $2 || '%' or display_name ilike '%' || $2 || '%')
        order by email limit $3`,
      [accountId, q ?? null, limit],
    );
  }

  byId(tx: Tx, id: string): Promise<ContactRecord> {
    return this.one<ContactRecord>(
      tx,
      'contact',
      `select id, account_id, email::text as email, display_name, portal_user_id, status, flags, created_at, updated_at, version
         from acct.contacts where id = $1`,
      [id],
    );
  }

  setFlags(tx: Tx, id: string, version: number, flags: string[]): Promise<ContactRecord> {
    return this.updateVersioned<ContactRecord>(tx, 'contact', 'acct.contacts', id, version, { flags });
  }
}

export class ListContactsQueryDto {
  @IsOptional() @IsString() @MaxLength(120) q?: string;
  @IsOptional() @IsInt() limit?: number;
}

export class SetContactFlagsDto {
  @IsInt() version!: number;
  @IsArray() @ArrayUnique() @IsIn(CONTACT_FLAGS, { each: true }) flags!: ContactFlag[];
}

@Injectable()
export class ContactsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly contacts: ContactsRepository,
    private readonly audit: AuditService,
  ) {}

  list(principal: Principal, accountId: string, query: ListContactsQueryDto) {
    return this.uow.run(principal, (tx) =>
      this.contacts.list(tx, accountId, query.q, Math.min(Number(query.limit ?? 200), 500)),
    );
  }

  /** Replaces the flag set; the audit records what it was and what it became. */
  async setFlags(
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    id: string,
    dto: SetContactFlagsDto,
  ): Promise<ContactRecord> {
    return this.uow.run(principal, async (tx) => {
      const before = await this.contacts.byId(tx, id);
      // The account in the path is the one the record must belong to, so a
      // contact of another granted account cannot be reached through it.
      if (before.account_id !== accountId) throw new NotFoundException({ code: 'not_found', entity: 'contact' });
      const after = await this.contacts.setFlags(tx, id, dto.version, [...new Set(dto.flags)]);
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'contact',
          entityId: id,
          eventType: 'updated',
          field: 'flags',
          oldValue: before.flags,
          newValue: after.flags,
        },
      ]);
      return after;
    });
  }
}

/** Thin: DTO in, one service call, result out. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/accounts/:accountId/contacts')
@RequirePermission('admin:accounts')
export class AdminContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query() query: ListContactsQueryDto,
  ) {
    return this.contacts.list(principal, accountId, query);
  }

  @Patch(':id/flags')
  setFlags(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetContactFlagsDto,
  ) {
    return this.contacts.setFlags(principal, ctx, accountId, id, dto);
  }
}

@Module({
  providers: [ContactsRepository, ContactsService],
  exports: [ContactsRepository, ContactsService],
})
export class ContactsCoreModule {}

@Module({
  imports: [ContactsCoreModule],
  controllers: [AdminContactsController],
  exports: [ContactsCoreModule],
})
export class ContactsModule {}
