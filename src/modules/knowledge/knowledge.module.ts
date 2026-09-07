import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  Authenticated,
  CurrentPrincipal,
  RealmOf,
  RequestCtx,
  RequirePermission,
  type RequestContext,
} from '../../common/auth/decorators.js';
import { actorKindOf, type Principal } from '../../common/auth/principal.js';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import type { Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { checkGeneralization, type Finding } from '../../domain/knowledge/generalization-check.js';
import { AccountsRepository } from '../admin/accounts/accounts.repository.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import { TicketsRepository, ticketKey } from '../tickets/tickets.repository.js';
import {
  GLOBAL_ACCOUNT_ID,
  KnowledgeRepository,
  VERSION_SECTIONS,
  type ArticleRow,
  type VersionRow,
  type VersionSection,
} from './knowledge.repository.js';

/**
 * Solution Knowledge Base (02-modules/knowledge-base, P2.14 cut: draft,
 * review, publish, retire, visibility set, generalize with the identifier
 * checklist, retrieval v1, the resolution record, feedback; embeddings and
 * the Axel draft land with the AI module).
 */
export class SectionsDto implements Partial<Record<VersionSection, string>> {
  @IsOptional() @IsString() @MaxLength(20000) problem_statement?: string;
  @IsOptional() @IsString() @MaxLength(20000) environment?: string;
  @IsOptional() @IsString() @MaxLength(20000) symptoms?: string;
  @IsOptional() @IsString() @MaxLength(20000) cause?: string;
  @IsOptional() @IsString() @MaxLength(50000) steps?: string;
  @IsOptional() @IsString() @MaxLength(20000) verification?: string;
  @IsOptional() @IsString() @MaxLength(20000) rollback?: string;
  @IsOptional() @IsString() @MaxLength(20000) client_notes?: string;
}

export class CreateArticleDto extends SectionsDto {
  @IsUUID('4')
  account_id!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsIn(['solution', 'workaround', 'known_error', 'procedure', 'reference'])
  kind?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  categories?: string[];

  @IsOptional()
  @IsIn(['none', 'follow', 'request', 'auto'])
  self_service?: string;

  @IsOptional()
  @IsIn(['lt_15m', 'lt_1h', 'lt_4h', 'gt_4h'])
  effort_band?: string;
}

export class UpdateDraftDto extends SectionsDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  categories?: string[];

  @IsOptional()
  @IsIn(['none', 'follow', 'request', 'auto'])
  self_service?: string;

  @IsOptional()
  @IsIn(['lt_15m', 'lt_1h', 'lt_4h', 'gt_4h'])
  effort_band?: string;
}

export class RetireDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class VisibilityDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  account_ids!: string[];
}

export class FeedbackDto {
  @IsIn(['useful', 'not_useful', 'out_of_date', 'solved_it'])
  verdict!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;

  @IsOptional()
  @IsIn(['ticket_rail', 'portal_search', 'portal_kb', 'article_record'])
  context?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  context_ref?: string;
}

export class LinkSolutionDto {
  @IsUUID('4')
  article_id!: string;

  @IsOptional()
  @IsIn(['resolved_by', 'partially_resolved_by'])
  outcome?: 'resolved_by' | 'partially_resolved_by';
}

export class CandidateDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsBoolean()
  include_work_notes?: boolean;
}

export interface ArticleView extends ArticleRow {
  draft: VersionRow | null;
  published: VersionRow | null;
  versions: {
    id: string;
    version_no: number;
    published_at: string | null;
    authored_name: string;
    created_at: string;
  }[];
  visibility: { visible_account_id: string; granted_by: string; granted_at: string }[];
  feedback: Record<string, number>;
}

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly knowledge: KnowledgeRepository,
    private readonly tickets: TicketsRepository,
    private readonly accounts: AccountsRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  list(
    principal: Principal,
    query: { status?: string; kind?: string; category?: string; account_id?: string; q?: string; limit?: number },
  ) {
    return this.uow.run(principal, (tx) =>
      this.knowledge.list(
        tx,
        {
          status: query.status ? query.status.split(',').filter(Boolean) : undefined,
          kind: query.kind,
          category: query.category,
          accountId: query.account_id,
          q: query.q,
        },
        Math.min(query.limit ?? 50, 100),
      ),
    );
  }

  get(principal: Principal, idOrKey: string): Promise<ArticleView> {
    return this.uow.run(principal, async (tx) => this.view(tx, await this.load(tx, idOrKey)));
  }

  create(principal: Principal, ctx: RequestContext, dto: CreateArticleDto): Promise<ArticleView> {
    if (!principal.accountIds.includes(dto.account_id))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
    return this.uow.run(principal, async (tx) => {
      const article = await this.knowledge.insert(tx, {
        accountId: dto.account_id,
        title: dto.title,
        kind: dto.kind ?? 'solution',
        categories: dto.categories ?? [],
        ownerId: principal.userId,
        ownerName: principal.displayName,
        selfService: dto.self_service,
        effortBand: dto.effort_band,
      });
      await this.knowledge.insertVersion(tx, {
        accountId: article.account_id,
        articleId: article.id,
        versionNo: 1,
        sections: dto,
        authoredBy: principal.userId,
        authoredName: principal.displayName,
      });
      await this.audit.account(tx, article.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'article',
          entityId: article.id,
          eventType: 'created',
          newValue: { key: article.display_key, title: article.title },
        },
      ]);
      return this.view(tx, article);
    });
  }

  /** Draft article from a ticket (5.2): title and problem statement from the ticket; work notes optionally as the steps seed. */
  createCandidate(
    principal: Principal,
    ctx: RequestContext,
    key: string,
    dto: CandidateDto,
    bound?: Tx,
  ): Promise<ArticleView> {
    const work = async (tx: Tx): Promise<ArticleView> => {
      const ticket = await this.loadTicket(tx, key);
      const notes = dto.include_work_notes ? await this.tickets.workNotesOf(tx, ticket.id) : [];
      const article = await this.knowledge.insert(tx, {
        accountId: ticket.account_id,
        title: dto.title ?? ticket.short_description,
        kind: 'solution',
        categories: ticket.category ? [ticket.category] : [],
        ownerId: principal.userId,
        ownerName: principal.displayName,
        sourceTicketId: ticket.id,
      });
      const version = await this.knowledge.insertVersion(tx, {
        accountId: ticket.account_id,
        articleId: article.id,
        versionNo: 1,
        sections: {
          problem_statement: ticket.description ?? ticket.short_description,
          steps: notes.map((note) => note.body).join('\n\n'),
          cause: ticket.resolution_notes ?? '',
        },
        authoredBy: principal.userId,
        authoredName: principal.displayName,
      });
      await this.knowledge.insertSolution(tx, {
        accountId: ticket.account_id,
        ticketId: ticket.id,
        articleId: article.id,
        versionId: version.id,
        outcome: 'created_from',
        actorKind: actorKindOf(principal),
        actorId: principal.userId,
        actorName: principal.displayName,
      });
      await this.audit.account(tx, ticket.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'article',
          entityId: article.id,
          ticketId: ticket.id,
          eventType: 'created',
          newValue: { key: article.display_key, from_ticket: ticketKey(ticket.number) },
        },
      ]);
      return this.view(tx, article);
    };
    return bound ? work(bound) : this.uow.run(principal, work);
  }

  updateDraft(principal: Principal, ctx: RequestContext, idOrKey: string, dto: UpdateDraftDto): Promise<ArticleView> {
    return this.uow.run(principal, async (tx) => {
      const article = await this.lockOwned(tx, principal, idOrKey);
      if (article.status === 'retired') throw new ConflictException({ code: 'article_retired' });
      let draft = await this.knowledge.draftOf(tx, article.id);
      if (!draft) {
        // A published article gets a new draft version for the next publish.
        draft = await this.knowledge.insertVersion(tx, {
          accountId: article.account_id,
          articleId: article.id,
          versionNo: await this.knowledge.nextVersionNo(tx, article.id),
          sections: {},
          authoredBy: principal.userId,
          authoredName: principal.displayName,
        });
        const published = article.published_version_id
          ? await this.knowledge.versionById(tx, article.published_version_id)
          : undefined;
        if (published) {
          const carried: Partial<Record<VersionSection, string>> = {};
          for (const section of VERSION_SECTIONS) carried[section] = published[section];
          draft = await this.knowledge.replaceDraft(tx, draft.id, carried, principal.userId, principal.displayName);
        }
      }
      const sections: Partial<Record<VersionSection, string>> = {};
      for (const section of VERSION_SECTIONS) if (dto[section] !== undefined) sections[section] = dto[section];
      await this.knowledge.replaceDraft(tx, draft.id, sections, principal.userId, principal.displayName);
      const assignments: Record<string, unknown> = {};
      for (const field of ['title', 'categories', 'self_service', 'effort_band'] as const)
        if (dto[field] !== undefined) assignments[field] = dto[field];
      if (article.status === 'in_review') assignments.status = 'draft';
      const after = await this.knowledge.update(tx, article.id, dto.version, assignments);
      await this.audit.account(tx, article.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'article',
          entityId: article.id,
          eventType: 'updated',
          field: 'draft',
          newValue: { sections: Object.keys(sections), ...assignments },
        },
      ]);
      return this.view(tx, after);
    });
  }

  submit(principal: Principal, ctx: RequestContext, idOrKey: string, version: number): Promise<ArticleView> {
    return this.uow.run(principal, async (tx) => {
      const article = await this.lockOwned(tx, principal, idOrKey);
      if (article.status !== 'draft')
        throw new ConflictException({ code: 'invalid_transition', from: article.status, to: 'in_review' });
      const after = await this.knowledge.update(tx, article.id, version, { status: 'in_review' });
      await this.audit.account(tx, article.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'article',
          entityId: article.id,
          eventType: 'updated',
          field: 'status',
          oldValue: 'draft',
          newValue: 'in_review',
        },
      ]);
      return this.view(tx, after);
    });
  }

  publish(principal: Principal, ctx: RequestContext, idOrKey: string, version: number): Promise<ArticleView> {
    return this.uow.run(principal, async (tx) => {
      const article = await this.lockOwned(tx, principal, idOrKey);
      if (article.status === 'retired') throw new ConflictException({ code: 'article_retired' });
      const draft = await this.knowledge.draftOf(tx, article.id);
      if (!draft) throw new ConflictException({ code: 'nothing_to_publish' });
      if (draft.authored_by === principal.userId && !principal.permissions.has('admin:config'))
        throw new ConflictException({ code: 'reviewer_must_differ' });
      if (!draft.problem_statement.trim() || !draft.steps.trim())
        throw new ConflictException({
          code: 'missing_requirements',
          items: ['problem_statement', 'steps'].filter((section) => !draft[section as VersionSection].trim()),
        });
      if (article.is_global) {
        const findings = await this.findings(tx, article, draft);
        if (findings.length > 0) throw new ConflictException({ code: 'generalization_findings', findings });
      }
      const published = await this.knowledge.publishVersion(tx, draft.id);
      const after = await this.knowledge.update(tx, article.id, version, {
        status: 'published',
        published_version_id: published.id,
        reviewer_user_id: principal.userId,
        reviewer_name: principal.displayName,
        last_verified_at: new Date(),
        search_text: `${published.problem_statement}\n${published.symptoms}`,
      });
      await this.audit.account(tx, article.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'article',
          entityId: article.id,
          eventType: 'article.published',
          field: 'status',
          oldValue: article.status,
          newValue: 'published',
        },
      ]);
      await this.outbox.write(tx, {
        accountId: article.account_id,
        aggregate: 'article',
        aggregateId: article.id,
        eventType: 'article.published',
        correlationId: ctx.requestId,
        payload: { version_id: published.id, is_global: article.is_global },
      });
      return this.view(tx, after);
    });
  }

  retire(principal: Principal, ctx: RequestContext, idOrKey: string, dto: RetireDto): Promise<ArticleView> {
    return this.uow.run(principal, async (tx) => {
      const article = await this.lockOwned(tx, principal, idOrKey);
      const after = await this.knowledge.update(tx, article.id, dto.version, {
        status: 'retired',
        retired_at: new Date(),
        retired_reason: dto.reason,
      });
      await this.audit.account(tx, article.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'article',
          entityId: article.id,
          eventType: 'updated',
          field: 'status',
          oldValue: article.status,
          newValue: 'retired',
        },
      ]);
      await this.outbox.write(tx, {
        accountId: article.account_id,
        aggregate: 'article',
        aggregateId: article.id,
        eventType: 'article.retired',
        correlationId: ctx.requestId,
        payload: { reason: dto.reason },
      });
      return this.view(tx, after);
    });
  }

  replaceVisibility(
    principal: Principal,
    ctx: RequestContext,
    idOrKey: string,
    dto: VisibilityDto,
  ): Promise<ArticleView> {
    return this.uow.run(principal, async (tx) => {
      const article = await this.lockOwned(tx, principal, idOrKey);
      if (article.is_global) throw new ConflictException({ code: 'global_article' });
      const others = dto.account_ids.filter((id) => id !== article.account_id);
      for (const id of others) await this.accounts.byId(tx, id);
      const before = (await this.knowledge.visibilityOf(tx, article.id)).map((row) => row.visible_account_id);
      await this.knowledge.replaceVisibility(tx, article, others, principal.userId);
      await this.audit.account(tx, article.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'article',
          entityId: article.id,
          eventType: 'updated',
          field: 'visibility',
          oldValue: before,
          newValue: others,
        },
      ]);
      return this.view(tx, article);
    });
  }

  /** Creates the global copy under GLOBAL; returns the checklist findings instead when the text still carries identifiers. */
  generalize(
    principal: Principal,
    ctx: RequestContext,
    idOrKey: string,
    sections: Partial<Record<VersionSection, string>> = {},
  ): Promise<ArticleView | { findings: Finding[] }> {
    return this.uow.runWithAccounts(principal, [GLOBAL_ACCOUNT_ID], async (tx) => {
      const article = await this.load(tx, idOrKey);
      if (article.is_global) throw new ConflictException({ code: 'global_article' });
      const source = article.published_version_id
        ? await this.knowledge.versionById(tx, article.published_version_id)
        : await this.knowledge.draftOf(tx, article.id);
      if (!source) throw new ConflictException({ code: 'nothing_to_generalize' });
      const text: Partial<Record<VersionSection, string>> = {};
      for (const section of VERSION_SECTIONS) text[section] = sections[section] ?? source[section];
      const findings = await this.findings(tx, article, text);
      if (findings.length > 0) return { findings };
      const copy = await this.knowledge.insert(tx, {
        accountId: GLOBAL_ACCOUNT_ID,
        title: article.title,
        kind: article.kind,
        categories: article.categories,
        ownerId: principal.userId,
        ownerName: principal.displayName,
        isGlobal: true,
        generalizedFromId: article.id,
        selfService: article.self_service,
        effortBand: article.effort_band,
      });
      await this.knowledge.insertVersion(tx, {
        accountId: GLOBAL_ACCOUNT_ID,
        articleId: copy.id,
        versionNo: 1,
        sections: text,
        authoredBy: principal.userId,
        authoredName: principal.displayName,
      });
      await this.audit.account(tx, GLOBAL_ACCOUNT_ID, actorOf(principal), ctx, [
        {
          entityKind: 'article',
          entityId: copy.id,
          eventType: 'created',
          newValue: { key: copy.display_key, generalized_from: article.display_key },
        },
      ]);
      return this.view(tx, copy);
    });
  }

  feedback(principal: Principal, ctx: RequestContext, idOrKey: string, dto: FeedbackDto): Promise<{ id: string }> {
    const work = async (tx: Tx) => {
      const article =
        principal.kind === 'portal'
          ? { ...(await this.knowledge.clientArticle(tx, idOrKey)), account_id: principal.accountIds[0] }
          : await this.load(tx, idOrKey);
      const [accountId] = principal.kind === 'portal' ? principal.accountIds : [article.account_id];
      const row = await this.knowledge.insertFeedback(tx, {
        accountId: principal.kind === 'portal' ? accountId : article.account_id,
        articleId: article.id,
        versionId: article.published_version_id,
        verdict: dto.verdict,
        comment: dto.comment,
        principalKind: principal.kind === 'portal' ? 'portal' : 'internal',
        actorId: principal.userId,
        actorName: principal.displayName,
        context: dto.context ?? (principal.kind === 'portal' ? 'portal_kb' : 'article_record'),
        contextRef: dto.context_ref,
      });
      void ctx;
      return row;
    };
    return principal.kind === 'portal' ? this.uow.portalWrite(principal, work) : this.uow.run(principal, work);
  }

  search(principal: Principal, query: string, limit = 25) {
    return this.uow.run(principal, (tx) =>
      this.knowledge.search(tx, query, { publishedOnly: principal.kind === 'portal', limit: Math.min(limit, 100) }),
    );
  }

  /** The Solutions rail: matching articles plus similar resolved tickets, and the links already recorded. */
  rail(principal: Principal, key: string) {
    return this.uow.run(principal, async (tx) => {
      const ticket = await this.loadTicket(tx, key);
      const query = ticket.short_description;
      const articles = await this.knowledge.search(tx, query, { publishedOnly: true, limit: 8 });
      const similar = await this.knowledge.similarTickets(tx, query, ticket.id, 8);
      const linked = await this.knowledge.solutionsOf(tx, ticket.id);
      return { articles, similar_tickets: similar.map((row) => ({ ...row, key: ticketKey(row.number) })), linked };
    });
  }

  linkSolution(principal: Principal, ctx: RequestContext, key: string, dto: LinkSolutionDto, bound?: Tx) {
    const work = async (tx: Tx) => {
      const ticket = await this.loadTicket(tx, key);
      const article = await this.knowledge.byId(tx, dto.article_id);
      if (article.status !== 'published' || !article.published_version_id)
        throw new ConflictException({ code: 'article_not_published' });
      const link = await this.knowledge.insertSolution(tx, {
        accountId: ticket.account_id,
        ticketId: ticket.id,
        articleId: article.id,
        versionId: article.published_version_id,
        outcome: dto.outcome ?? 'resolved_by',
        actorKind: actorKindOf(principal),
        actorId: principal.userId,
        actorName: principal.displayName,
      });
      await this.audit.account(tx, ticket.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'ticket',
          entityId: ticket.id,
          ticketId: ticket.id,
          eventType: 'ticket.updated',
          field: 'solution',
          newValue: { article: article.display_key, outcome: dto.outcome ?? 'resolved_by' },
        },
      ]);
      return { id: link.id, article: { id: article.id, key: article.display_key, title: article.title } };
    };
    return bound ? work(bound) : this.uow.run(principal, work);
  }

  // Portal ------------------------------------------------------------------

  portalSearch(principal: Principal, query: string) {
    return this.uow.run(principal, async (tx) => {
      const hits = query.trim() ? await this.knowledge.search(tx, query, { publishedOnly: true, limit: 20 }) : [];
      return hits.map((hit) => ({
        id: hit.id,
        key: hit.display_key,
        title: hit.title,
        kind: hit.kind,
        categories: hit.categories,
        self_service: hit.self_service,
      }));
    });
  }

  portalArticle(principal: Principal, idOrKey: string) {
    return this.uow.run(principal, async (tx) => {
      const article = await this.knowledge.clientArticle(tx, idOrKey);
      const version = article.published_version_id
        ? await this.knowledge.clientVersion(tx, article.published_version_id)
        : undefined;
      // The portal renders client notes only (technical 2.2).
      return {
        id: article.id,
        key: article.display_key,
        title: article.title,
        kind: article.kind,
        categories: article.categories,
        self_service: article.self_service,
        client_notes: version?.client_notes ?? '',
        published_at: version?.published_at ?? null,
      };
    });
  }

  // Helpers -------------------------------------------------------------------

  private async view(tx: Tx, article: ArticleRow): Promise<ArticleView> {
    const versions = await this.knowledge.versionsOf(tx, article.id);
    const visibility = await this.knowledge.visibilityOf(tx, article.id);
    const feedback = await this.knowledge.feedbackSummary(tx, article.id);
    return {
      ...article,
      draft: versions.find((version) => version.published_at === null) ?? null,
      published: versions.find((version) => version.id === article.published_version_id) ?? null,
      versions: versions.map((version) => ({
        id: version.id,
        version_no: version.version_no,
        published_at: version.published_at,
        authored_name: version.authored_name,
        created_at: version.created_at,
      })),
      visibility,
      feedback: Object.fromEntries(feedback.map((row) => [row.verdict, row.n])),
    };
  }

  private load(tx: Tx, idOrKey: string): Promise<ArticleRow> {
    return /^KB\d{6,}$/i.test(idOrKey)
      ? this.knowledge.byKey(tx, idOrKey.toUpperCase())
      : this.knowledge.byId(tx, idOrKey);
  }

  private async lockOwned(tx: Tx, principal: Principal, idOrKey: string): Promise<ArticleRow> {
    const article = await this.load(tx, idOrKey);
    if (!principal.accountIds.includes(article.account_id)) throw new ForbiddenException({ code: 'not_owner_account' });
    return this.knowledge.lock(tx, article.id);
  }

  private loadTicket(tx: Tx, key: string) {
    const number = key.match(/^CS(\d{7,})$/i) ? String(Number(key.slice(2))) : undefined;
    return number ? this.tickets.byNumber(tx, number) : this.tickets.byId(tx, key);
  }

  private async findings(
    tx: Tx,
    article: ArticleRow,
    sections: Partial<Record<VersionSection, string>>,
  ): Promise<Finding[]> {
    const sourceAccountId = article.is_global
      ? article.generalized_from_id
        ? (await this.knowledge.byId(tx, article.generalized_from_id).catch(() => undefined))?.account_id
        : undefined
      : article.account_id;
    if (!sourceAccountId) return [];
    const account = await this.accounts.byId(tx, sourceAccountId);
    const contacts = await this.knowledge.contactsForCheck(tx, sourceAccountId);
    const hosts = await this.knowledge.hostnamesForCheck(tx, sourceAccountId);
    const text: Record<string, string> = {};
    for (const section of VERSION_SECTIONS) text[section] = sections[section] ?? '';
    return checkGeneralization(text, {
      accountNames: [account.name, account.legal_name ?? ''].filter(Boolean),
      contactNames: contacts.map((contact) => contact.display_name),
      contactEmails: contacts.map((contact) => contact.email),
      hostnames: hosts.map((host) => host.name),
    });
  }
}

@ApiTags('knowledge')
@ApiBearerAuth()
@Controller()
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get('articles')
  @RequirePermission('tickets:view')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query()
    query: { status?: string; kind?: string; category?: string; account_id?: string; q?: string; limit?: string },
  ) {
    return this.knowledge.list(principal, { ...query, limit: query.limit ? Number(query.limit) : undefined });
  }

  @Post('articles')
  @RequirePermission('kb:author')
  create(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: CreateArticleDto) {
    return this.knowledge.create(principal, ctx, dto);
  }

  @Get('articles/:key')
  @RequirePermission('tickets:view')
  get(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.knowledge.get(principal, key);
  }

  @Put('articles/:key/draft')
  @RequirePermission('kb:author')
  updateDraft(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: UpdateDraftDto,
  ) {
    return this.knowledge.updateDraft(principal, ctx, key, dto);
  }

  @Post('articles/:key/submit')
  @RequirePermission('kb:author')
  submit(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() body: { version: number },
  ) {
    if (!Number.isInteger(body?.version)) throw new BadRequestException({ code: 'version_required' });
    return this.knowledge.submit(principal, ctx, key, body.version);
  }

  @Post('articles/:key/publish')
  @RequirePermission('kb:publish')
  publish(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() body: { version: number },
  ) {
    if (!Number.isInteger(body?.version)) throw new BadRequestException({ code: 'version_required' });
    return this.knowledge.publish(principal, ctx, key, body.version);
  }

  @Post('articles/:key/retire')
  @RequirePermission('kb:publish')
  retire(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: RetireDto,
  ) {
    return this.knowledge.retire(principal, ctx, key, dto);
  }

  @Post('articles/:key/generalize')
  @RequirePermission('kb:publish')
  generalize(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: SectionsDto,
  ) {
    return this.knowledge.generalize(principal, ctx, key, dto);
  }

  @Put('articles/:key/visibility')
  @RequirePermission('kb:publish')
  visibility(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: VisibilityDto,
  ) {
    return this.knowledge.replaceVisibility(principal, ctx, key, dto);
  }

  @Post('articles/:key/feedback')
  @RequirePermission('tickets:view')
  feedback(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: FeedbackDto,
  ) {
    return this.knowledge.feedback(principal, ctx, key, dto);
  }

  @Get('search/solutions')
  @RequirePermission('tickets:view')
  search(@CurrentPrincipal() principal: Principal, @Query('q') q: string, @Query('limit') limit?: string) {
    return this.knowledge.search(principal, q ?? '', limit ? Number(limit) : undefined);
  }

  @Get('tickets/:key/solutions')
  @RequirePermission('tickets:view')
  rail(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.knowledge.rail(principal, key);
  }

  @Post('tickets/:key/solutions')
  @RequirePermission('tickets:resolve')
  link(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: LinkSolutionDto,
  ) {
    return this.knowledge.linkSolution(principal, ctx, key, dto);
  }

  @Post('tickets/:key/article-candidate')
  @RequirePermission('kb:author')
  candidate(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: CandidateDto,
  ) {
    return this.knowledge.createCandidate(principal, ctx, key, dto);
  }
}

@ApiTags('portal')
@ApiBearerAuth()
@Controller('portal/knowledge')
@RealmOf('portal')
export class PortalKnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  @RequirePermission('portal:kb')
  search(@CurrentPrincipal() principal: Principal, @Query('q') q?: string) {
    return this.knowledge.portalSearch(principal, q ?? '');
  }

  @Get(':key')
  @RequirePermission('portal:kb')
  article(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.knowledge.portalArticle(principal, key);
  }

  @Post(':key/feedback')
  @Authenticated()
  feedback(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: FeedbackDto,
  ) {
    return this.knowledge.feedback(principal, ctx, key, { ...dto, context: dto.context ?? 'portal_kb' });
  }
}

@Module({
  imports: [TicketsCoreModule],
  controllers: [KnowledgeController, PortalKnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
