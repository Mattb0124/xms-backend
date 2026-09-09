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
import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
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
  /** As given: extensions and country codes are kept verbatim. */
  phone: string | null;
  job_title: string | null;
  time_zone: string | null;
  notes: string | null;
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
      `select id, account_id, email::text as email, display_name, phone, job_title, time_zone, notes,
              portal_user_id, status, flags, created_at, updated_at, version
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
      `select id, account_id, email::text as email, display_name, phone, job_title, time_zone, notes,
              portal_user_id, status, flags, created_at, updated_at, version
         from acct.contacts where id = $1`,
      [id],
    );
  }

  /**
   * The person behind the address. Only the fields named are touched, so a
   * form that carries three of them leaves the rest as they were, and the
   * version guards the row the way every other record's does.
   */
  update(
    tx: Tx,
    id: string,
    version: number,
    changes: { display_name?: string; phone?: string; job_title?: string; time_zone?: string; notes?: string },
  ): Promise<ContactRecord> {
    return this.one<ContactRecord>(
      tx,
      'contact',
      `update acct.contacts
          set display_name = coalesce($3, display_name),
              phone = coalesce($4, phone),
              job_title = coalesce($5, job_title),
              time_zone = coalesce($6, time_zone),
              notes = coalesce($7, notes),
              version = version + 1
        where id = $1 and version = $2
        returning id, account_id, email::text as email, display_name, phone, job_title, time_zone, notes,
                  portal_user_id, status, flags, created_at, updated_at, version`,
      [
        id,
        version,
        changes.display_name ?? null,
        changes.phone ?? null,
        changes.job_title ?? null,
        changes.time_zone ?? null,
        changes.notes ?? null,
      ],
    );
  }

  setFlags(tx: Tx, id: string, version: number, flags: string[]): Promise<ContactRecord> {
    return this.updateVersioned<ContactRecord>(tx, 'contact', 'acct.contacts', id, version, { flags });
  }
}

export class ListContactsQueryDto {
  @IsOptional() @IsString() @MaxLength(120) q?: string;

  // `enableImplicitConversion` is off, so without the transform any
  // `?limit=` value arrives as a string and 400s, which made the parameter
  // unusable rather than unbounded.
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
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
    if (!principal.accountIds.includes(accountId))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
    return this.uow.run(principal, (tx) => this.contacts.list(tx, accountId, query.q, query.limit ?? 200));
  }

  /**
   * One contact, for anyone who may see a case. The reader's grants decide
   * which: a contact of an account they do not hold answers as missing rather
   * than as refused, so the address itself gives nothing away.
   */
  async get(principal: Principal, id: string): Promise<ContactRecord> {
    return this.uow.run(principal, async (tx) => {
      const contact = await this.contacts.byId(tx, id);
      if (!principal.accountIds.includes(contact.account_id))
        throw new NotFoundException({ code: 'not_found', entity: 'contact' });
      return contact;
    });
  }

  /** The details a desk keeps on a person; the audit names each field that moved. */
  async update(
    principal: Principal,
    ctx: RequestContext,
    id: string,
    dto: {
      version: number;
      display_name?: string;
      phone?: string;
      job_title?: string;
      time_zone?: string;
      notes?: string;
    },
  ): Promise<ContactRecord> {
    return this.uow.run(principal, async (tx) => {
      const before = await this.contacts.byId(tx, id);
      if (!principal.accountIds.includes(before.account_id))
        throw new NotFoundException({ code: 'not_found', entity: 'contact' });
      const after = await this.contacts.update(tx, id, dto.version, dto);
      const fields = ['display_name', 'phone', 'job_title', 'time_zone', 'notes'] as const;
      await this.audit.account(
        tx,
        before.account_id,
        actorOf(principal),
        ctx,
        fields
          .filter((field) => before[field] !== after[field])
          .map((field) => ({
            entityKind: 'contact',
            entityId: id,
            eventType: 'updated' as const,
            field,
            oldValue: before[field],
            newValue: after[field],
          })),
      );
      return after;
    });
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

/**
 * One contact, read by anyone who may see a case (a consultant ringing about
 * one needs to know who they are calling), and edited by whoever administers
 * the account it belongs to.
 */
export class UpdateContactDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() @MaxLength(160) display_name?: string;
  @IsOptional() @IsString() @MaxLength(64) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) job_title?: string;
  @IsOptional() @IsString() @MaxLength(64) time_zone?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

@ApiTags('contacts')
@ApiBearerAuth()
@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get(':id')
  @RequirePermission('tickets:view')
  get(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.contacts.get(principal, id);
  }

  @Patch(':id')
  @RequirePermission('admin:accounts')
  update(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContactDto,
  ) {
    return this.contacts.update(principal, ctx, id, dto);
  }
}

@Module({
  providers: [ContactsRepository, ContactsService],
  exports: [ContactsRepository, ContactsService],
})
export class ContactsCoreModule {}

@Module({
  imports: [ContactsCoreModule],
  controllers: [AdminContactsController, ContactsController],
  exports: [ContactsCoreModule],
})
export class ContactsModule {}
