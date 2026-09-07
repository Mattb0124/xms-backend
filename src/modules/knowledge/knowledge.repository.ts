import { Injectable } from '@nestjs/common';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';

export const GLOBAL_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

export interface ArticleRow {
  id: string;
  account_id: string;
  display_key: string;
  kind: string;
  status: 'draft' | 'in_review' | 'published' | 'retired';
  is_global: boolean;
  title: string;
  categories: string[];
  self_service: string;
  effort_band: string | null;
  owner_user_id: string;
  owner_name: string;
  reviewer_user_id: string | null;
  reviewer_name: string | null;
  published_version_id: string | null;
  last_verified_at: string | null;
  retired_at: string | null;
  retired_reason: string | null;
  source_ticket_id: string | null;
  generalized_from_id: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export const VERSION_SECTIONS = [
  'problem_statement',
  'environment',
  'symptoms',
  'cause',
  'steps',
  'verification',
  'rollback',
  'client_notes',
] as const;
export type VersionSection = (typeof VERSION_SECTIONS)[number];

export interface VersionRow extends Record<VersionSection, string> {
  id: string;
  account_id: string;
  article_id: string;
  version_no: number;
  ci_snapshot: unknown[];
  authored_by: string;
  authored_name: string;
  published_at: string | null;
  ai_suggestion_id: string | null;
  created_at: string;
}

export interface SearchHit {
  id: string;
  display_key: string;
  title: string;
  kind: string;
  status: string;
  is_global: boolean;
  account_id: string;
  categories: string[];
  self_service: string;
  rank: number;
}

/** Articles, versions, visibility, resolution links, feedback (Solution Knowledge Base technical 2). */
@Injectable()
export class KnowledgeRepository extends RepositoryBase {
  byId(tx: Tx, id: string): Promise<ArticleRow> {
    return this.one<ArticleRow>(tx, 'article', 'select * from acct.solution_articles where id = $1', [id]);
  }

  byKey(tx: Tx, key: string): Promise<ArticleRow> {
    return this.one<ArticleRow>(tx, 'article', 'select * from acct.solution_articles where display_key = $1', [key]);
  }

  /** The client-facing article columns only (portal column grants). */
  clientArticle(
    tx: Tx,
    idOrKey: string,
  ): Promise<
    Pick<ArticleRow, 'id' | 'display_key' | 'title' | 'kind' | 'categories' | 'self_service' | 'published_version_id'>
  > {
    const byKey = /^KBd{6,}$/i.test(idOrKey);
    return this.one(
      tx,
      'article',
      `select id, display_key, title, kind, categories, self_service, published_version_id from acct.solution_articles where ${byKey ? 'display_key' : 'id'} = $1`,
      [byKey ? idOrKey.toUpperCase() : idOrKey],
    );
  }

  lock(tx: Tx, id: string): Promise<ArticleRow> {
    return this.one<ArticleRow>(tx, 'article', 'select * from acct.solution_articles where id = $1 for update', [id]);
  }

  list(
    tx: Tx,
    filters: { status?: string[]; kind?: string; category?: string; accountId?: string; q?: string; global?: boolean },
    limit: number,
  ): Promise<ArticleRow[]> {
    const values: unknown[] = [limit];
    const where: string[] = [];
    if (filters.status?.length) {
      values.push(filters.status);
      where.push(`status = any ($${values.length}::text[])`);
    }
    if (filters.kind) {
      values.push(filters.kind);
      where.push(`kind = $${values.length}`);
    }
    if (filters.category) {
      values.push(filters.category);
      where.push(`$${values.length} = any (categories)`);
    }
    if (filters.accountId) {
      values.push(filters.accountId);
      where.push(`account_id = $${values.length}`);
    }
    if (filters.global !== undefined) {
      values.push(filters.global);
      where.push(`is_global = $${values.length}`);
    }
    if (filters.q) {
      values.push(filters.q);
      where.push(
        `(search_vector @@ plainto_tsquery('english', $${values.length}) or display_key ilike '%' || $${values.length} || '%')`,
      );
    }
    const clause = where.length > 0 ? `where ${where.join(' and ')}` : '';
    return this.many<ArticleRow>(
      tx,
      `select * from acct.solution_articles ${clause} order by updated_at desc limit $1`,
      values,
    );
  }

  insert(
    tx: Tx,
    input: {
      accountId: string;
      title: string;
      kind: string;
      categories: string[];
      ownerId: string;
      ownerName: string;
      sourceTicketId?: string | null;
      isGlobal?: boolean;
      generalizedFromId?: string | null;
      selfService?: string;
      effortBand?: string | null;
    },
  ): Promise<ArticleRow> {
    return this.one<ArticleRow>(
      tx,
      'article',
      `insert into acct.solution_articles (account_id, title, kind, categories, owner_user_id, owner_name, source_ticket_id, is_global, generalized_from_id, self_service, effort_band)
       values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, false), $9, coalesce($10, 'none'), $11) returning *`,
      [
        input.accountId,
        input.title,
        input.kind,
        input.categories,
        input.ownerId,
        input.ownerName,
        input.sourceTicketId ?? null,
        input.isGlobal,
        input.generalizedFromId ?? null,
        input.selfService,
        input.effortBand ?? null,
      ],
    );
  }

  update(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<ArticleRow> {
    return this.updateVersioned<ArticleRow>(tx, 'article', 'acct.solution_articles', id, version, assignments);
  }

  // Versions ----------------------------------------------------------------

  versionsOf(tx: Tx, articleId: string): Promise<VersionRow[]> {
    return this.many<VersionRow>(
      tx,
      'select * from acct.article_versions where article_id = $1 order by version_no desc',
      [articleId],
    );
  }

  versionById(tx: Tx, id: string): Promise<VersionRow> {
    return this.one<VersionRow>(tx, 'article_version', 'select * from acct.article_versions where id = $1', [id]);
  }

  /** The client-facing columns only (the portal role holds column grants on these alone). */
  clientVersion(
    tx: Tx,
    id: string,
  ): Promise<{ id: string; version_no: number; client_notes: string; published_at: string | null } | undefined> {
    return this.maybeOne(
      tx,
      'select id, version_no, client_notes, published_at from acct.article_versions where id = $1',
      [id],
    );
  }

  draftOf(tx: Tx, articleId: string): Promise<VersionRow | undefined> {
    return this.maybeOne<VersionRow>(
      tx,
      'select * from acct.article_versions where article_id = $1 and published_at is null order by version_no desc limit 1',
      [articleId],
    );
  }

  async nextVersionNo(tx: Tx, articleId: string): Promise<number> {
    const row = await this.maybeOne<{ next: number }>(
      tx,
      'select coalesce(max(version_no), 0) + 1 as next from acct.article_versions where article_id = $1',
      [articleId],
    );
    return row?.next ?? 1;
  }

  insertVersion(
    tx: Tx,
    input: {
      accountId: string;
      articleId: string;
      versionNo: number;
      sections: Partial<Record<VersionSection, string>>;
      authoredBy: string;
      authoredName: string;
      aiSuggestionId?: string | null;
    },
  ): Promise<VersionRow> {
    return this.one<VersionRow>(
      tx,
      'article_version',
      `insert into acct.article_versions (account_id, article_id, version_no, problem_statement, environment, symptoms, cause, steps, verification, rollback, client_notes, authored_by, authored_name, ai_suggestion_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning *`,
      [
        input.accountId,
        input.articleId,
        input.versionNo,
        input.sections.problem_statement ?? '',
        input.sections.environment ?? '',
        input.sections.symptoms ?? '',
        input.sections.cause ?? '',
        input.sections.steps ?? '',
        input.sections.verification ?? '',
        input.sections.rollback ?? '',
        input.sections.client_notes ?? '',
        input.authoredBy,
        input.authoredName,
        input.aiSuggestionId ?? null,
      ],
    );
  }

  /** Replaces the unpublished draft text in place (the row is not yet frozen). */
  replaceDraft(
    tx: Tx,
    id: string,
    sections: Partial<Record<VersionSection, string>>,
    authoredBy: string,
    authoredName: string,
  ): Promise<VersionRow> {
    const keys = VERSION_SECTIONS.filter((section) => sections[section] !== undefined);
    const sets = keys.map((section, index) => `${section} = $${index + 4}`).join(', ');
    return this.one<VersionRow>(
      tx,
      'article_version',
      `update acct.article_versions set ${sets ? `${sets}, ` : ''}authored_by = $2, authored_name = $3 where id = $1 and published_at is null returning *`,
      [id, authoredBy, authoredName, ...keys.map((section) => sections[section])],
    );
  }

  async publishVersion(tx: Tx, id: string): Promise<VersionRow> {
    return this.one<VersionRow>(
      tx,
      'article_version',
      'update acct.article_versions set published_at = now() where id = $1 and published_at is null returning *',
      [id],
    );
  }

  // Visibility --------------------------------------------------------------

  visibilityOf(
    tx: Tx,
    articleId: string,
  ): Promise<{ visible_account_id: string; granted_by: string; granted_at: string }[]> {
    return this.many(
      tx,
      'select visible_account_id, granted_by, granted_at from acct.article_visibility where article_id = $1 order by granted_at',
      [articleId],
    );
  }

  async replaceVisibility(tx: Tx, article: ArticleRow, accountIds: string[], grantedBy: string): Promise<void> {
    await tx.query('delete from acct.article_visibility where article_id = $1', [article.id]);
    for (const accountId of accountIds) {
      await tx.query(
        'insert into acct.article_visibility (article_id, account_id, visible_account_id, granted_by) values ($1, $2, $3, $4)',
        [article.id, article.account_id, accountId, grantedBy],
      );
    }
  }

  // Resolution links and feedback --------------------------------------------

  insertSolution(
    tx: Tx,
    input: {
      accountId: string;
      ticketId: string;
      articleId: string;
      versionId: string;
      outcome: string;
      actorKind: string;
      actorId: string;
      actorName: string;
    },
  ): Promise<{ id: string }> {
    return this.one<{ id: string }>(
      tx,
      'ticket_solution',
      `insert into acct.ticket_solutions (account_id, ticket_id, article_id, article_version_id, outcome, actor_kind, actor_id, actor_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        input.accountId,
        input.ticketId,
        input.articleId,
        input.versionId,
        input.outcome,
        input.actorKind,
        input.actorId,
        input.actorName,
      ],
    );
  }

  solutionsOf(
    tx: Tx,
    ticketId: string,
  ): Promise<
    {
      id: string;
      article_id: string;
      article_version_id: string;
      outcome: string;
      actor_name: string;
      created_at: string;
      display_key: string;
      title: string;
    }[]
  > {
    return this.many(
      tx,
      `select s.id, s.article_id, s.article_version_id, s.outcome, s.actor_name, s.created_at, a.display_key, a.title
         from acct.ticket_solutions s join acct.solution_articles a on a.id = s.article_id
        where s.ticket_id = $1 order by s.created_at`,
      [ticketId],
    );
  }

  insertFeedback(
    tx: Tx,
    input: {
      accountId: string;
      articleId: string;
      versionId: string | null;
      verdict: string;
      comment?: string | null;
      principalKind: string;
      actorId: string;
      actorName: string;
      context: string;
      contextRef?: string | null;
    },
  ): Promise<{ id: string }> {
    return this.one<{ id: string }>(
      tx,
      'article_feedback',
      `insert into acct.article_feedback (account_id, article_id, article_version_id, verdict, comment, principal_kind, actor_id, actor_name, context, context_ref)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [
        input.accountId,
        input.articleId,
        input.versionId,
        input.verdict,
        input.comment ?? null,
        input.principalKind,
        input.actorId,
        input.actorName,
        input.context,
        input.contextRef ?? null,
      ],
    );
  }

  feedbackSummary(tx: Tx, articleId: string): Promise<{ verdict: string; n: number }[]> {
    return this.many(
      tx,
      'select verdict, count(*)::int as n from acct.article_feedback where article_id = $1 group by verdict',
      [articleId],
    );
  }

  // Retrieval v1: full text plus trigram on the key, ranked; RLS filters visibility.
  search(tx: Tx, query: string, options: { publishedOnly: boolean; limit: number }): Promise<SearchHit[]> {
    const values: unknown[] = [query, options.limit];
    const status = options.publishedOnly ? `and status = 'published'` : `and status <> 'retired'`;
    return this.many<SearchHit>(
      tx,
      `select id, display_key, title, kind, status, is_global, account_id, categories, self_service,
              (ts_rank(search_vector, plainto_tsquery('english', $1)) + case when display_key ilike '%' || $1 || '%' then 1 else 0 end)::float as rank
         from acct.solution_articles
        where (search_vector @@ plainto_tsquery('english', $1) or display_key ilike '%' || $1 || '%') ${status}
        order by rank desc, updated_at desc limit $2`,
      values,
    );
  }

  /** Resolved tickets whose text matches, with their linked article (the "similar tickets" half of the rail). */
  similarTickets(
    tx: Tx,
    query: string,
    excludeTicketId: string,
    limit: number,
  ): Promise<
    {
      id: string;
      number: string;
      short_description: string;
      resolution_code: string | null;
      article_key: string | null;
      article_title: string | null;
      rank: number;
    }[]
  > {
    return this.many(
      tx,
      `select t.id, t.number::text as number, t.short_description, t.resolution_code, a.display_key as article_key, a.title as article_title,
              ts_rank(t.search, plainto_tsquery('english', $1))::float as rank
         from acct.tickets t
         left join lateral (
           select art.display_key, art.title from acct.ticket_solutions s join acct.solution_articles art on art.id = s.article_id
            where s.ticket_id = t.id order by s.created_at desc limit 1
         ) a on true
        where t.id <> $2 and t.resolved_at is not null and t.search @@ plainto_tsquery('english', $1)
        order by rank desc, t.resolved_at desc limit $3`,
      [query, excludeTicketId, limit],
    );
  }

  contactsForCheck(tx: Tx, accountId: string): Promise<{ display_name: string; email: string }[]> {
    return this.many(tx, 'select display_name, email from acct.contacts where account_id = $1', [accountId]);
  }

  hostnamesForCheck(tx: Tx, accountId: string): Promise<{ name: string }[]> {
    return this.many(
      tx,
      `select name from acct.configuration_items where account_id = $1 and ci_type in ('server', 'environment', 'integration')`,
      [accountId],
    );
  }
}
