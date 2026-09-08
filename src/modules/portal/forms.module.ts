import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { defaultFormDefinition, definitionProblems, type FormDefinition } from '../../domain/portal/form-schema.js';

/**
 * Per-account request forms (CP-03; Client Portal functional 5.4 step 3,
 * technical 2.2, 2.6 and 2.7). An operator authors a form per account and
 * ticket type, edits it as a draft, and publishes it; the portal is served
 * the published version and nothing else, and a request keeps the version it
 * was submitted against.
 *
 * Authoring is configuration, so it sits under `admin:config` beside the
 * catalogs and the account overrides. The portal's own read and the
 * submission gate live in portal.module.ts, which imports this module's
 * repository; the rules both sides run are the one file in
 * `src/domain/portal/form-schema.ts`.
 */
export const FORM_TICKET_TYPES = ['incident', 'service_request', 'change'] as const;
export type FormTicketType = (typeof FORM_TICKET_TYPES)[number];

export interface TicketFormRow {
  id: string;
  account_id: string;
  ticket_type: FormTicketType;
  name: string;
  description: string;
  current_version_id: string | null;
  is_active: boolean;
  client_visible: boolean;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface TicketFormVersionRow {
  id: string;
  account_id: string;
  form_id: string;
  version_no: number;
  definition: FormDefinition;
  published_at: string | null;
  published_by: string | null;
  created_at: string;
}

@Injectable()
export class FormsRepository extends RepositoryBase {
  forAccount(tx: Tx, accountId: string): Promise<TicketFormRow[]> {
    return this.many<TicketFormRow>(
      tx,
      'select * from acct.ticket_forms where account_id = $1 order by ticket_type, name',
      [accountId],
    );
  }

  byId(tx: Tx, accountId: string, id: string): Promise<TicketFormRow> {
    return this.one<TicketFormRow>(
      tx,
      'ticket_form',
      'select * from acct.ticket_forms where id = $1 and account_id = $2',
      [id, accountId],
    );
  }

  /**
   * The form a client is offered for a type: active, visible to clients, and
   * carrying a published current version. Read on the portal role, so the
   * row-level policies decide it a second time.
   */
  publishedFor(
    tx: Tx,
    accountId: string,
    type: FormTicketType,
  ): Promise<(TicketFormRow & { definition: FormDefinition; version_id: string; version_no: number }) | undefined> {
    return this.maybeOne(
      tx,
      `select f.*, v.id as version_id, v.version_no, v.definition
         from acct.ticket_forms f
         join acct.ticket_form_versions v on v.id = f.current_version_id and v.published_at is not null
        where f.account_id = $1 and f.ticket_type = $2 and f.is_active and f.client_visible`,
      [accountId, type],
    );
  }

  /** Every form a client may be offered, with its published definition. */
  publishedForAccount(
    tx: Tx,
    accountId: string,
  ): Promise<(TicketFormRow & { definition: FormDefinition; version_id: string; version_no: number })[]> {
    return this.many(
      tx,
      `select f.*, v.id as version_id, v.version_no, v.definition
         from acct.ticket_forms f
         join acct.ticket_form_versions v on v.id = f.current_version_id and v.published_at is not null
        where f.account_id = $1 and f.is_active and f.client_visible
        order by f.ticket_type`,
      [accountId],
    );
  }

  versionsOf(tx: Tx, formId: string): Promise<TicketFormVersionRow[]> {
    return this.many<TicketFormVersionRow>(
      tx,
      'select * from acct.ticket_form_versions where form_id = $1 order by version_no',
      [formId],
    );
  }

  versionById(tx: Tx, formId: string, id: string): Promise<TicketFormVersionRow> {
    return this.one<TicketFormVersionRow>(
      tx,
      'ticket_form_version',
      'select * from acct.ticket_form_versions where id = $1 and form_id = $2',
      [id, formId],
    );
  }

  insertForm(
    tx: Tx,
    input: {
      accountId: string;
      ticketType: FormTicketType;
      name: string;
      description: string;
      clientVisible: boolean;
    },
  ): Promise<TicketFormRow> {
    return this.one<TicketFormRow>(
      tx,
      'ticket_form',
      `insert into acct.ticket_forms (account_id, ticket_type, name, description, client_visible)
       values ($1, $2, $3, $4, $5) returning *`,
      [input.accountId, input.ticketType, input.name, input.description, input.clientVisible],
    );
  }

  updateForm(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<TicketFormRow> {
    return this.updateVersioned<TicketFormRow>(tx, 'ticket_form', 'acct.ticket_forms', id, version, assignments);
  }

  async nextVersionNo(tx: Tx, formId: string): Promise<number> {
    const row = await this.maybeOne<{ next: number }>(
      tx,
      'select coalesce(max(version_no), 0) + 1 as next from acct.ticket_form_versions where form_id = $1',
      [formId],
    );
    return row?.next ?? 1;
  }

  async insertVersion(
    tx: Tx,
    input: { accountId: string; formId: string; definition: FormDefinition },
  ): Promise<TicketFormVersionRow> {
    const versionNo = await this.nextVersionNo(tx, input.formId);
    return this.one<TicketFormVersionRow>(
      tx,
      'ticket_form_version',
      `insert into acct.ticket_form_versions (account_id, form_id, version_no, definition)
       values ($1, $2, $3, $4::jsonb) returning *`,
      [input.accountId, input.formId, versionNo, JSON.stringify(input.definition)],
    );
  }

  /** A draft is editable; the trigger refuses the same update on a published row. */
  updateDraft(tx: Tx, id: string, definition: FormDefinition): Promise<TicketFormVersionRow> {
    return this.one<TicketFormVersionRow>(
      tx,
      'ticket_form_version',
      `update acct.ticket_form_versions set definition = $2::jsonb
        where id = $1 and published_at is null returning *`,
      [id, JSON.stringify(definition)],
    );
  }

  publishVersion(tx: Tx, id: string, publishedBy: string): Promise<TicketFormVersionRow> {
    return this.one<TicketFormVersionRow>(
      tx,
      'ticket_form_version',
      `update acct.ticket_form_versions set published_at = now(), published_by = $2
        where id = $1 and published_at is null returning *`,
      [id, publishedBy],
    );
  }
}

export class CreateTicketFormDto {
  @IsIn(FORM_TICKET_TYPES) ticket_type!: FormTicketType;

  @IsString() @MinLength(1) @MaxLength(160) name!: string;

  @IsOptional() @IsString() @MaxLength(2000) description?: string;

  @IsOptional() @IsBoolean() client_visible?: boolean;

  /** The first draft. Omitted, the form starts from the default field list. */
  @IsOptional() @IsObject() definition?: Record<string, unknown>;
}

export class PatchTicketFormDto {
  @IsInt() @Min(1) version!: number;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) name?: string;

  @IsOptional() @IsString() @MaxLength(2000) description?: string;

  @IsOptional() @IsBoolean() client_visible?: boolean;

  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class FormDefinitionDto {
  @IsObject() definition!: Record<string, unknown>;
}

@Injectable()
export class FormsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly forms: FormsRepository,
    private readonly audit: AuditService,
  ) {}

  list(principal: Principal, accountId: string): Promise<unknown[]> {
    this.assertGranted(principal, accountId);
    return this.uow.run(principal, async (tx) => {
      const rows = await this.forms.forAccount(tx, accountId);
      const out = [];
      for (const row of rows) out.push({ ...row, versions: await this.forms.versionsOf(tx, row.id) });
      return out;
    });
  }

  get(principal: Principal, accountId: string, formId: string): Promise<unknown> {
    this.assertGranted(principal, accountId);
    return this.uow.run(principal, async (tx) => ({
      ...(await this.forms.byId(tx, accountId, formId)),
      versions: await this.forms.versionsOf(tx, formId),
    }));
  }

  create(principal: Principal, ctx: RequestContext, accountId: string, dto: CreateTicketFormDto): Promise<unknown> {
    this.assertGranted(principal, accountId);
    const definition = (dto.definition as FormDefinition | undefined) ?? defaultFormDefinition(dto.ticket_type);
    assertDefinition(definition);
    return this.uow.run(principal, async (tx) => {
      const existing = await this.forms.forAccount(tx, accountId);
      if (existing.some((form) => form.is_active && form.ticket_type === dto.ticket_type))
        throw new ConflictException({ code: 'form_already_exists', ticket_type: dto.ticket_type });
      const form = await this.forms.insertForm(tx, {
        accountId,
        ticketType: dto.ticket_type,
        name: dto.name,
        description: dto.description ?? '',
        clientVisible: dto.client_visible ?? true,
      });
      const draft = await this.forms.insertVersion(tx, { accountId, formId: form.id, definition });
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'ticket_form',
          entityId: form.id,
          eventType: 'created',
          newValue: { ticket_type: form.ticket_type, name: form.name, version_no: draft.version_no },
        },
      ]);
      return { ...form, versions: [draft] };
    });
  }

  patch(
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    formId: string,
    dto: PatchTicketFormDto,
  ): Promise<unknown> {
    this.assertGranted(principal, accountId);
    return this.uow.run(principal, async (tx) => {
      const before = await this.forms.byId(tx, accountId, formId);
      const assignments: Record<string, unknown> = {};
      for (const key of ['name', 'description', 'client_visible', 'is_active'] as const)
        if (dto[key] !== undefined) assignments[key] = dto[key];
      const after = await this.forms.updateForm(tx, formId, dto.version, assignments);
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'ticket_form',
          entityId: formId,
          eventType: 'updated',
          oldValue: Object.fromEntries(
            Object.keys(assignments).map((key) => [key, before[key as keyof TicketFormRow]]),
          ),
          newValue: assignments,
        },
      ]);
      return { ...after, versions: await this.forms.versionsOf(tx, formId) };
    });
  }

  /** A new draft on top of whatever the form serves today; publishing is separate. */
  addVersion(
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    formId: string,
    dto: FormDefinitionDto,
  ): Promise<TicketFormVersionRow> {
    this.assertGranted(principal, accountId);
    const definition = dto.definition as unknown as FormDefinition;
    assertDefinition(definition);
    return this.uow.run(principal, async (tx) => {
      await this.forms.byId(tx, accountId, formId);
      const draft = await this.forms.insertVersion(tx, { accountId, formId, definition });
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'ticket_form',
          entityId: formId,
          eventType: 'updated',
          field: 'draft',
          newValue: { version_id: draft.id, version_no: draft.version_no },
        },
      ]);
      return draft;
    });
  }

  editVersion(
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    formId: string,
    versionId: string,
    dto: FormDefinitionDto,
  ): Promise<TicketFormVersionRow> {
    this.assertGranted(principal, accountId);
    const definition = dto.definition as unknown as FormDefinition;
    assertDefinition(definition);
    return this.uow.run(principal, async (tx) => {
      await this.forms.byId(tx, accountId, formId);
      const version = await this.forms.versionById(tx, formId, versionId);
      if (version.published_at)
        throw new ConflictException({ code: 'form_version_published', version_no: version.version_no });
      const saved = await this.forms.updateDraft(tx, versionId, definition);
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'ticket_form',
          entityId: formId,
          eventType: 'updated',
          field: 'draft',
          newValue: { version_id: saved.id, version_no: saved.version_no },
        },
      ]);
      return saved;
    });
  }

  /**
   * Publishing freezes the version and points the form at it. A request in
   * flight keeps the version it started with, because the ticket stores the
   * version id rather than the form id.
   */
  publish(
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    formId: string,
    versionId: string,
  ): Promise<unknown> {
    this.assertGranted(principal, accountId);
    return this.uow.run(principal, async (tx) => {
      const form = await this.forms.byId(tx, accountId, formId);
      const version = await this.forms.versionById(tx, formId, versionId);
      if (version.published_at)
        throw new ConflictException({ code: 'form_version_published', version_no: version.version_no });
      assertDefinition(version.definition);
      const published = await this.forms.publishVersion(tx, versionId, principal.userId);
      const after = await this.forms.updateForm(tx, formId, form.version, { current_version_id: versionId });
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'ticket_form',
          entityId: formId,
          eventType: 'updated',
          field: 'current_version_id',
          oldValue: form.current_version_id,
          newValue: versionId,
        },
      ]);
      return { ...after, published_version: published };
    });
  }

  private assertGranted(principal: Principal, accountId: string): void {
    if (!principal.accountIds.includes(accountId))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
  }
}

/** One worded refusal for a definition the server could not enforce. */
export function assertDefinition(definition: unknown): void {
  const problems = definitionProblems(definition);
  if (problems.length > 0) throw new BadRequestException({ code: 'invalid_form_definition', problems });
}

@ApiTags('portal')
@ApiBearerAuth()
@Controller('accounts/:accountId/forms')
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Get()
  @RequirePermission('admin:config')
  list(@CurrentPrincipal() principal: Principal, @Param('accountId', ParseUUIDPipe) accountId: string) {
    return this.forms.list(principal, accountId);
  }

  @Post()
  @RequirePermission('admin:config')
  create(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: CreateTicketFormDto,
  ) {
    return this.forms.create(principal, ctx, accountId, dto);
  }

  @Get(':formId')
  @RequirePermission('admin:config')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
  ) {
    return this.forms.get(principal, accountId, formId);
  }

  @Patch(':formId')
  @RequirePermission('admin:config')
  patch(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: PatchTicketFormDto,
  ) {
    return this.forms.patch(principal, ctx, accountId, formId, dto);
  }

  @Post(':formId/versions')
  @RequirePermission('admin:config')
  addVersion(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: FormDefinitionDto,
  ) {
    return this.forms.addVersion(principal, ctx, accountId, formId, dto);
  }

  @Put(':formId/versions/:versionId')
  @RequirePermission('admin:config')
  editVersion(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() dto: FormDefinitionDto,
  ) {
    return this.forms.editVersion(principal, ctx, accountId, formId, versionId, dto);
  }

  @Post(':formId/versions/:versionId/publish')
  @RequirePermission('admin:config')
  publish(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    return this.forms.publish(principal, ctx, accountId, formId, versionId);
  }
}

@Module({
  providers: [FormsRepository, FormsService],
  exports: [FormsRepository, FormsService],
})
export class FormsCoreModule {}

@Module({
  imports: [FormsCoreModule],
  controllers: [FormsController],
  exports: [FormsCoreModule],
})
export class FormsModule {}
