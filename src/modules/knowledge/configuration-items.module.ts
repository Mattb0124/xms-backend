import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { MaxJsonSize } from '../../common/validation/max-json-size.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';

/**
 * The lightweight configuration item register (TM-19; Knowledge Base
 * functional 5.8, technical 2.6). The table has existed since migration
 * 0007 and two readers already depend on it: the change-conflict rule
 * (`conflictsOnItem`) and the generalization checklist, which scrubs an
 * article of the account's own hostnames. What was missing was a way to
 * put anything in it, and the check that a configuration item a client
 * names on a ticket belongs to that ticket's account.
 *
 * Nothing here needs a migration: migration 0007 already carries every
 * column the specification's table names (`ci_type`, `name`, `attributes`,
 * `owner_contact_id`, `external_ref`, `status`) with forced row-level
 * security and the per-account unique name.
 *
 * Reading sits under `tickets:view` because the New ticket form and the
 * ticket record show the picker to everyone who works tickets; writing
 * sits under `admin:config`, which is where the other per-account
 * vocabularies (catalogs, calendars, routing rules) already live. The
 * portal-side "account admins may add items" of functional 5.8 is not
 * built: no portal screen asks for it yet, and a write path into the
 * operator's own environment register is not one to open speculatively.
 */
export const CI_TYPES = ['environment', 'application', 'module', 'integration', 'server', 'report', 'other'] as const;
export type CiType = (typeof CI_TYPES)[number];

export const CI_STATUSES = ['active', 'retired'] as const;
export type CiStatus = (typeof CI_STATUSES)[number];

export interface ConfigurationItemRow {
  id: string;
  account_id: string;
  ci_type: CiType;
  name: string;
  attributes: Record<string, unknown>;
  owner_contact_id: string | null;
  external_ref: string | null;
  status: CiStatus;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface ConfigurationItemTicket {
  id: string;
  key: string;
  type: string;
  state: string;
  priority: string;
  short_description: string;
  created_at: string;
  closed_at: string | null;
}

@Injectable()
export class ConfigurationItemsRepository extends RepositoryBase {
  byId(tx: Tx, id: string): Promise<ConfigurationItemRow> {
    return this.one<ConfigurationItemRow>(
      tx,
      'configuration_item',
      'select * from acct.configuration_items where id = $1',
      [id],
    );
  }

  /**
   * The account's register, and the picker's search. `q` matches anywhere
   * in the name so "consol" finds "OneStream consolidation app"; the sort
   * puts active items first so a retired one never heads the picker.
   */
  search(
    tx: Tx,
    accountId: string,
    filters: { q?: string; ci_type?: CiType; status?: CiStatus; limit: number },
  ): Promise<ConfigurationItemRow[]> {
    return this.many<ConfigurationItemRow>(
      tx,
      `select * from acct.configuration_items
        where account_id = $1
          and ($2::text is null or name ilike '%' || $2 || '%')
          and ($3::text is null or ci_type = $3)
          and ($4::text is null or status = $4)
        order by (status = 'active') desc, ci_type, lower(name)
        limit $5`,
      [accountId, filters.q ?? null, filters.ci_type ?? null, filters.status ?? null, filters.limit],
    );
  }

  /** The item's own tickets: the open ones first, then the most recently closed. */
  ticketsOf(tx: Tx, id: string, limit: number): Promise<ConfigurationItemTicket[]> {
    return this.many<ConfigurationItemTicket>(
      tx,
      `select id, 'CS' || lpad(number::text, 7, '0') as key, type, state, priority, short_description,
              created_at, closed_at
         from acct.tickets
        where configuration_item_id = $1
        order by (closed_at is null) desc, coalesce(closed_at, created_at) desc
        limit $2`,
      [id, limit],
    );
  }

  /** Whether anything still names the item, so a delete cannot orphan a record. */
  async usage(tx: Tx, id: string): Promise<{ tickets: number; links: number }> {
    const tickets = await this.count(tx, 'select 1 from acct.tickets where configuration_item_id = $1', [id]);
    const links = await this.count(tx, 'select 1 from acct.ci_links where ci_id = $1', [id]);
    return { tickets, links };
  }

  insert(
    tx: Tx,
    input: {
      accountId: string;
      ciType: CiType;
      name: string;
      attributes: Record<string, unknown>;
      ownerContactId: string | null;
      externalRef: string | null;
      status: CiStatus;
    },
  ): Promise<ConfigurationItemRow> {
    return this.one<ConfigurationItemRow>(
      tx,
      'configuration_item',
      `insert into acct.configuration_items
         (account_id, ci_type, name, attributes, owner_contact_id, external_ref, status)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7) returning *`,
      [
        input.accountId,
        input.ciType,
        input.name,
        JSON.stringify(input.attributes),
        input.ownerContactId,
        input.externalRef,
        input.status,
      ],
    );
  }

  update(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<ConfigurationItemRow> {
    const serialised: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(assignments))
      serialised[key] = key === 'attributes' ? JSON.stringify(value) : value;
    return this.updateVersioned<ConfigurationItemRow>(
      tx,
      'configuration_item',
      'acct.configuration_items',
      id,
      version,
      serialised,
    );
  }

  async remove(tx: Tx, id: string): Promise<void> {
    await tx.query('delete from acct.configuration_items where id = $1', [id]);
  }
}

export class CreateConfigurationItemDto {
  @IsIn(CI_TYPES) ci_type!: CiType;

  @IsString() @MinLength(1) @MaxLength(120) name!: string;

  @IsOptional() @IsObject() @MaxJsonSize(16 * 1024) attributes?: Record<string, unknown>;

  @IsOptional() @IsUUID('4') owner_contact_id?: string | null;

  @IsOptional() @IsString() @MaxLength(200) external_ref?: string | null;

  @IsOptional() @IsIn(CI_STATUSES) status?: CiStatus;
}

export class PatchConfigurationItemDto {
  @IsInt() @Min(1) version!: number;

  @IsOptional() @IsIn(CI_TYPES) ci_type?: CiType;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;

  @IsOptional() @IsObject() @MaxJsonSize(16 * 1024) attributes?: Record<string, unknown>;

  @IsOptional() @IsUUID('4') owner_contact_id?: string | null;

  @IsOptional() @IsString() @MaxLength(200) external_ref?: string | null;

  @IsOptional() @IsIn(CI_STATUSES) status?: CiStatus;
}

export class SearchConfigurationItemsQueryDto {
  @IsOptional() @IsString() @MaxLength(120) q?: string;

  @IsOptional() @IsIn(CI_TYPES) ci_type?: CiType;

  @IsOptional() @IsIn(CI_STATUSES) status?: CiStatus;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
}

const PATCH_FIELDS = ['ci_type', 'name', 'owner_contact_id', 'external_ref', 'status'] as const;
const SEARCH_LIMIT = 50;
const TICKETS_ON_RECORD = 20;

@Injectable()
export class ConfigurationItemsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly items: ConfigurationItemsRepository,
    private readonly audit: AuditService,
  ) {}

  search(
    principal: Principal,
    accountId: string,
    query: SearchConfigurationItemsQueryDto,
  ): Promise<ConfigurationItemRow[]> {
    this.assertGranted(principal, accountId);
    return this.uow.run(principal, (tx) =>
      this.items.search(tx, accountId, {
        q: query.q?.trim() || undefined,
        ci_type: query.ci_type,
        status: query.status,
        limit: Math.min(query.limit ?? SEARCH_LIMIT, 200),
      }),
    );
  }

  get(principal: Principal, id: string): Promise<ConfigurationItemRow & { tickets: ConfigurationItemTicket[] }> {
    return this.uow.run(principal, async (tx) => ({
      ...(await this.items.byId(tx, id)),
      tickets: await this.items.ticketsOf(tx, id, TICKETS_ON_RECORD),
    }));
  }

  create(
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    dto: CreateConfigurationItemDto,
  ): Promise<ConfigurationItemRow> {
    this.assertGranted(principal, accountId);
    return this.uow.run(principal, async (tx) => {
      if (dto.owner_contact_id) await this.assertContact(tx, accountId, dto.owner_contact_id);
      const item = await this.items.insert(tx, {
        accountId,
        ciType: dto.ci_type,
        name: dto.name.trim(),
        attributes: dto.attributes ?? {},
        ownerContactId: dto.owner_contact_id ?? null,
        externalRef: dto.external_ref ?? null,
        status: dto.status ?? 'active',
      });
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'configuration_item',
          entityId: item.id,
          eventType: 'created',
          newValue: { ci_type: item.ci_type, name: item.name, status: item.status },
        },
      ]);
      return item;
    });
  }

  patch(
    principal: Principal,
    ctx: RequestContext,
    id: string,
    dto: PatchConfigurationItemDto,
  ): Promise<ConfigurationItemRow> {
    return this.uow.run(principal, async (tx) => {
      const before = await this.items.byId(tx, id);
      if (dto.owner_contact_id) await this.assertContact(tx, before.account_id, dto.owner_contact_id);
      const assignments: Record<string, unknown> = {};
      for (const field of ['ci_type', 'owner_contact_id', 'external_ref', 'status'] as const)
        if (dto[field] !== undefined) assignments[field] = dto[field];
      if (dto.name !== undefined) assignments.name = dto.name.trim();
      if (dto.attributes !== undefined) assignments.attributes = dto.attributes;
      const after = await this.items.update(tx, id, dto.version, assignments);
      const changed = PATCH_FIELDS.filter((field) => before[field] !== after[field]);
      const attributesChanged = JSON.stringify(before.attributes) !== JSON.stringify(after.attributes);
      await this.audit.account(tx, before.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'configuration_item',
          entityId: id,
          eventType: 'updated',
          oldValue: {
            ...Object.fromEntries(changed.map((field) => [field, before[field]])),
            ...(attributesChanged ? { attributes: before.attributes } : {}),
          },
          newValue: {
            ...Object.fromEntries(changed.map((field) => [field, after[field]])),
            ...(attributesChanged ? { attributes: after.attributes } : {}),
          },
        },
      ]);
      return after;
    });
  }

  /**
   * A configuration item nothing names is deleted; one a ticket or an
   * article still names is refused, because the change-conflict rule and
   * the ticket record read it by id and a dangling reference would silently
   * stop refusing anything. Retiring it (`status: retired`) is how an item
   * that has history leaves service.
   */
  remove(principal: Principal, ctx: RequestContext, id: string): Promise<void> {
    return this.uow.run(principal, async (tx) => {
      const before = await this.items.byId(tx, id);
      const usage = await this.items.usage(tx, id);
      if (usage.tickets > 0 || usage.links > 0)
        throw new ConflictException({ code: 'configuration_item_in_use', ...usage });
      await this.audit.account(tx, before.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'configuration_item',
          entityId: id,
          eventType: 'deleted',
          oldValue: { ci_type: before.ci_type, name: before.name },
        },
      ]);
      await this.items.remove(tx, id);
    });
  }

  private assertGranted(principal: Principal, accountId: string): void {
    if (!principal.accountIds.includes(accountId))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
  }

  /** The owner is a contact of the same account; RLS hides anyone else's, so an invisible id is a 404. */
  private async assertContact(tx: Tx, accountId: string, contactId: string): Promise<void> {
    const found = await tx.query('select 1 from acct.contacts where id = $1 and account_id = $2', [
      contactId,
      accountId,
    ]);
    if (found.rowCount === 0) throw new NotFoundException({ code: 'not_found', entity: 'contact' });
  }
}

@ApiTags('knowledge')
@ApiBearerAuth()
@Controller('accounts/:accountId/configuration-items')
export class AccountConfigurationItemsController {
  constructor(private readonly items: ConfigurationItemsService) {}

  @Get()
  @RequirePermission('tickets:view')
  search(
    @CurrentPrincipal() principal: Principal,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query() query: SearchConfigurationItemsQueryDto,
  ) {
    return this.items.search(principal, accountId, query);
  }

  @Post()
  @RequirePermission('admin:config')
  create(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: CreateConfigurationItemDto,
  ) {
    return this.items.create(principal, ctx, accountId, dto);
  }
}

@ApiTags('knowledge')
@ApiBearerAuth()
@Controller('configuration-items')
export class ConfigurationItemsController {
  constructor(private readonly items: ConfigurationItemsService) {}

  @Get(':id')
  @RequirePermission('tickets:view')
  get(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.items.get(principal, id);
  }

  @Patch(':id')
  @RequirePermission('admin:config')
  patch(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchConfigurationItemDto,
  ) {
    return this.items.patch(principal, ctx, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('admin:config')
  remove(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.items.remove(principal, ctx, id);
  }
}

@Module({
  providers: [ConfigurationItemsRepository, ConfigurationItemsService],
  exports: [ConfigurationItemsRepository, ConfigurationItemsService],
})
export class ConfigurationItemsCoreModule {}

@Module({
  imports: [ConfigurationItemsCoreModule],
  controllers: [AccountConfigurationItemsController, ConfigurationItemsController],
  exports: [ConfigurationItemsCoreModule],
})
export class ConfigurationItemsModule {}
