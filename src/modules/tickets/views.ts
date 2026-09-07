import { Body, Controller, Delete, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import type { Principal } from '../../common/auth/principal.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { validate, type ConditionSet } from './conditions.js';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

/**
 * Saved views (Ticket Management technical 2.5, 4; P2.11.1). A view is a
 * condition set plus columns and sort, shared privately, with a group, or
 * with everyone on the account. Views are account-scoped rows; the Queue
 * lists the views visible to the principal across its accounts.
 */
export interface ViewDefinition {
  readonly conditions: ConditionSet;
  readonly columns?: string[];
  readonly sort?: 'updated_desc' | 'created_desc' | 'priority';
}

export interface ViewRow {
  id: string;
  account_id: string;
  owner_id: string;
  name: string;
  definition: ViewDefinition;
  share: 'private' | 'group' | 'account';
  share_ref: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

@Injectable()
export class ViewsRepository extends RepositoryBase {
  visible(tx: Tx, userId: string, groupIds: string[]): Promise<ViewRow[]> {
    return this.many<ViewRow>(
      tx,
      `select * from acct.saved_views where deleted_at is null
         and (owner_id = $1 or share = 'account' or (share = 'group' and share_ref = any ($2::text[])))
       order by name`,
      [userId, groupIds],
    );
  }

  byId(tx: Tx, id: string): Promise<ViewRow> {
    return this.one<ViewRow>(tx, 'view', 'select * from acct.saved_views where id = $1 and deleted_at is null', [id]);
  }

  insert(
    tx: Tx,
    input: {
      accountId: string;
      ownerId: string;
      name: string;
      definition: ViewDefinition;
      share: string;
      shareRef: string | null;
    },
  ): Promise<ViewRow> {
    return this.one<ViewRow>(
      tx,
      'view',
      `insert into acct.saved_views (account_id, owner_id, name, definition, share, share_ref) values ($1, $2, $3, $4, $5, $6) returning *`,
      [input.accountId, input.ownerId, input.name, JSON.stringify(input.definition), input.share, input.shareRef],
    );
  }

  update(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<ViewRow> {
    const serialised: Record<string, unknown> = { ...assignments };
    if (serialised.definition) serialised.definition = JSON.stringify(serialised.definition);
    return this.updateVersioned<ViewRow>(tx, 'view', 'acct.saved_views', id, version, serialised);
  }

  softDelete(tx: Tx, id: string): Promise<number> {
    return this.count(tx, 'update acct.saved_views set deleted_at = now() where id = $1 and deleted_at is null', [id]);
  }
}

export class CreateViewDto {
  @IsUUID('4')
  account_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsObject()
  definition!: ViewDefinition;

  @IsOptional()
  @IsIn(['private', 'group', 'account'])
  share?: 'private' | 'group' | 'account';

  @IsOptional()
  @IsUUID('4')
  share_ref?: string;
}

export class UpdateViewDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsObject()
  definition?: ViewDefinition;

  @IsOptional()
  @IsIn(['private', 'group', 'account'])
  share?: 'private' | 'group' | 'account';

  @IsOptional()
  @IsUUID('4')
  share_ref?: string | null;

  @IsOptional()
  @IsArray()
  columns?: string[];
}

@Injectable()
export class ViewsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly views: ViewsRepository,
    private readonly audit: AuditService,
  ) {}

  list(principal: Principal, groupIds: string[] = []): Promise<ViewRow[]> {
    return this.uow.run(principal, (tx) => this.views.visible(tx, principal.userId, groupIds));
  }

  get(principal: Principal, id: string): Promise<ViewRow> {
    return this.uow.run(principal, (tx) => this.views.byId(tx, id));
  }

  create(principal: Principal, ctx: RequestContext, dto: CreateViewDto): Promise<ViewRow> {
    this.assertDefinition(dto.definition);
    if (dto.share === 'group' && !dto.share_ref) throw new BadRequestException({ code: 'share_ref_required' });
    return this.uow.run(principal, async (tx) => {
      const view = await this.views.insert(tx, {
        accountId: dto.account_id,
        ownerId: principal.userId,
        name: dto.name,
        definition: dto.definition,
        share: dto.share ?? 'private',
        shareRef: dto.share === 'group' ? (dto.share_ref ?? null) : null,
      });
      await this.audit.account(tx, dto.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'saved_view',
          entityId: view.id,
          eventType: 'created',
          newValue: { name: view.name, share: view.share },
        },
      ]);
      return view;
    });
  }

  update(principal: Principal, ctx: RequestContext, id: string, dto: UpdateViewDto): Promise<ViewRow> {
    if (dto.definition) this.assertDefinition(dto.definition);
    return this.uow.run(principal, async (tx) => {
      const before = await this.views.byId(tx, id);
      if (before.owner_id !== principal.userId) throw new ForbiddenException({ code: 'not_owner' });
      const assignments: Record<string, unknown> = {};
      for (const field of ['name', 'definition', 'share', 'share_ref'] as const)
        if (dto[field] !== undefined) assignments[field] = dto[field];
      const after = await this.views.update(tx, id, dto.version, assignments);
      await this.audit.account(tx, before.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'saved_view',
          entityId: id,
          eventType: 'updated',
          oldValue: { name: before.name, share: before.share },
          newValue: { name: after.name, share: after.share },
        },
      ]);
      return after;
    });
  }

  remove(principal: Principal, ctx: RequestContext, id: string): Promise<void> {
    return this.uow.run(principal, async (tx) => {
      const before = await this.views.byId(tx, id);
      if (before.owner_id !== principal.userId && !principal.permissions.has('admin:config'))
        throw new ForbiddenException({ code: 'not_owner' });
      await this.views.softDelete(tx, id);
      await this.audit.account(tx, before.account_id, actorOf(principal), ctx, [
        { entityKind: 'saved_view', entityId: id, eventType: 'deleted', oldValue: { name: before.name } },
      ]);
    });
  }

  private assertDefinition(definition: ViewDefinition): void {
    const problems = validate(definition?.conditions);
    if (definition?.sort && !['updated_desc', 'created_desc', 'priority'].includes(definition.sort))
      problems.push('sort is not allowed');
    if (definition?.columns && (!Array.isArray(definition.columns) || definition.columns.length > 30))
      problems.push('columns must be a list of at most 30');
    if (problems.length > 0) throw new BadRequestException({ code: 'invalid_conditions', problems });
  }
}

@ApiTags('tickets')
@ApiBearerAuth()
@Controller('views')
@RequirePermission('tickets:view')
export class ViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get()
  list(@CurrentPrincipal() principal: Principal) {
    return this.views.list(principal);
  }

  @Post()
  create(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: CreateViewDto) {
    return this.views.create(principal, ctx, dto);
  }

  @Get(':id')
  get(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.views.get(principal, id);
  }

  @Patch(':id')
  update(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateViewDto,
  ) {
    return this.views.update(principal, ctx, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.views.remove(principal, ctx, id);
  }
}
