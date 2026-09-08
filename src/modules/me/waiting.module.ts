import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, RequirePermission } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { weekBounds } from '../../domain/time/unlogged.js';
import { TimeCoreModule, TimeService } from '../time/time.module.js';

/**
 * "Waiting on me" (User Experience 3.1 and section 8): the My work rail
 * counts the things the signed-in person must act on, each with the link
 * that opens them. Every count is one query bound to the principal, run
 * inside the principal's own unit of work so row-level security scopes it
 * to the accounts they are granted; nothing here takes an account from the
 * request.
 *
 * The counts overlap on purpose: a low satisfaction score is also an unread
 * notification. The rail names both because they are two different actions.
 *
 * Every link is an address the internal web application registers
 * (`frontend/lib/routes.ts`), written in that application's own URL grammar
 * (`frontend/lib/tickets/queue-views.ts` for the Queue, `?tab=` for the
 * account records). The rail used to answer a URL space of its own
 * invention (`/queue`, `/timesheet`, `/reports/runs` with no run named,
 * where the application serves `/reports/runs/[id]`), which the browser
 * had to translate before it could follow anything; nothing here invents an
 * address any more, and a row whose action has no screen carries no link
 * rather than a broken one.
 */

/**
 * The states of a ticket that is not waiting on its assignee: paused on
 * someone else (`awaiting_client`, `awaiting_third_party`, `blocked`),
 * already resolved (`resolved`, `fulfilled`, `completed`, `done`), or
 * finished (`closed`, `cancelled`, `rejected`). The vocabulary is the union
 * of the seeded machines' paused, resolved and terminal states
 * (config/seeds/state-machines.json); an account that adds a state adds an
 * active one, which is waiting on me by default and so counts.
 */
export const NOT_WAITING_ON_ASSIGNEE = [
  'awaiting_client',
  'awaiting_third_party',
  'blocked',
  'resolved',
  'fulfilled',
  'completed',
  'done',
  'closed',
  'cancelled',
  'rejected',
] as const;

/** A run a reviewer has still to look at (acct.report_runs status vocabulary). */
const REVIEWABLE_RUN_STATES = ['ready_for_review', 'awaiting_review'] as const;

export interface WaitingItem {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  /** Where the application opens this row; absent when the desk has no screen for it. */
  readonly link?: string;
}

/** A count and, where the row opens one record, the account that record belongs to. */
interface CountWithAccount {
  readonly count: number;
  readonly account_id: string | null;
}

/**
 * A count that can open the record itself: the newest run waiting, the
 * account it belongs to, and how many accounts are waiting in all, which is
 * what decides whether one record is the answer or a list is.
 */
interface CountWithNewestRun extends CountWithAccount {
  readonly run_id: string | null;
  readonly accounts: number;
}

export interface WaitingOnMe {
  readonly items: WaitingItem[];
  readonly as_of: string;
}

@Injectable()
export class WaitingRepository extends RepositoryBase {
  /** Tickets assigned to me in a state that is waiting on my action. */
  ticketsAssigned(tx: Tx, userId: string): Promise<number> {
    return this.scalar(
      tx,
      `select count(*)::int as count from acct.tickets
        where assignee_id = $1 and state <> all ($2::text[])`,
      [userId, [...NOT_WAITING_ON_ASSIGNEE]],
    );
  }

  /**
   * Out-of-scope flags waiting for a decision on an account I own
   * (acct.tickets.out_of_scope, 0004; `tickets:approve-scope` is the
   * permission that acts on them). The account owner is the approver the
   * data model names: op.accounts.owner_user_id.
   */
  scopeApprovals(tx: Tx, userId: string): Promise<number> {
    return this.scalar(
      tx,
      `select count(*)::int as count from acct.tickets t
        where t.out_of_scope = 'flagged'
          and t.account_id in (select id from op.accounts where owner_user_id = $1)`,
      [userId],
    );
  }

  /** Articles I authored that are sitting in review. */
  articlesInReview(tx: Tx, userId: string): Promise<number> {
    return this.scalar(
      tx,
      `select count(*)::int as count from acct.solution_articles
        where status = 'in_review' and owner_user_id = $1`,
      [userId],
    );
  }

  /**
   * Report runs waiting for my review: the ones that name me as reviewer,
   * and the unclaimed ones on an account I own. `acct.report_schedules` has
   * no owner column, so account ownership is what "schedules I own" means
   * here; the day a schedule gains an owner this clause follows it.
   *
   * The newest waiting run comes back with the count, because the review
   * screen opens a run by id. Two runs written in the same statement carry
   * the same `created_at`, so the period breaks the tie and the answer is
   * the same one every time.
   */
  reportReviews(tx: Tx, userId: string): Promise<CountWithNewestRun> {
    return this.countWithNewestRun(
      tx,
      `with waiting as (
         select r.id, r.account_id, r.created_at, r.period_start from acct.report_runs r
          where r.status = any ($2::text[])
            and (r.reviewer_id = $1
                 or (r.reviewer_id is null and r.account_id in (select id from op.accounts where owner_user_id = $1)))
       )
       select count(*)::int as count,
              count(distinct account_id)::int as accounts,
              (select w.id from waiting w order by w.created_at desc, w.period_start desc limit 1) as run_id,
              (select w.account_id from waiting w order by w.created_at desc, w.period_start desc limit 1) as account_id
         from waiting`,
      [userId, [...REVIEWABLE_RUN_STATES]],
    );
  }

  unreadNotifications(tx: Tx, userId: string): Promise<number> {
    return this.scalar(
      tx,
      `select count(*)::int as count from acct.notifications where recipient_id = $1 and read_at is null`,
      [userId],
    );
  }

  /**
   * Low satisfaction scores still to answer. The CSAT module already routes
   * a low score to the account's contract managers as a `csat.low_score`
   * notification (TimeRepository.budgetRecipients), so an unread one of
   * those is exactly "a low score on my accounts that I must act on", with
   * no second definition of who the contract managers are.
   */
  csatLowScores(tx: Tx, userId: string): Promise<CountWithAccount> {
    return this.countWithAccount(
      tx,
      `select count(*)::int as count,
              (select n2.account_id from acct.notifications n2
                where n2.recipient_id = $1 and n2.read_at is null and n2.type = 'csat.low_score'
                order by n2.created_at desc limit 1) as account_id
         from acct.notifications n
        where n.recipient_id = $1 and n.read_at is null and n.type = 'csat.low_score'`,
      [userId],
    );
  }

  private async scalar(tx: Tx, text: string, values: unknown[]): Promise<number> {
    const rows = await this.many<{ count: number }>(tx, text, values);
    return rows[0]?.count ?? 0;
  }

  private async countWithAccount(tx: Tx, text: string, values: unknown[]): Promise<CountWithAccount> {
    const rows = await this.many<CountWithAccount>(tx, text, values);
    return { count: rows[0]?.count ?? 0, account_id: rows[0]?.account_id ?? null };
  }

  private async countWithNewestRun(tx: Tx, text: string, values: unknown[]): Promise<CountWithNewestRun> {
    const rows = await this.many<CountWithNewestRun>(tx, text, values);
    return {
      count: rows[0]?.count ?? 0,
      account_id: rows[0]?.account_id ?? null,
      run_id: rows[0]?.run_id ?? null,
      accounts: rows[0]?.accounts ?? 0,
    };
  }
}

/**
 * Where the Report packs row opens, in the web application's own URL
 * grammar (`frontend/lib/routes.ts` registers `/reports/runs/[id]`).
 * One run waiting on one account is a record, so the row opens it; runs on
 * several accounts are a list, so the row opens the Report packs tab of the
 * account the newest one belongs to; nothing waiting opens the packs
 * screen.
 */
export function linkForReportReviews(counts: CountWithNewestRun): string {
  if (!counts.run_id || !counts.account_id) return '/reports';
  if (counts.accounts > 1) return `/admin/accounts/${counts.account_id}?tab=reports`;
  return `/reports/runs/${counts.run_id}`;
}

@Injectable()
export class WaitingService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly waiting: WaitingRepository,
    private readonly time: TimeService,
  ) {}

  async forMe(principal: Principal, on = new Date()): Promise<WaitingOnMe> {
    const today = on.toISOString().slice(0, 10);
    const counts = await this.uow.run(principal, async (tx) => ({
      tickets_assigned: await this.waiting.ticketsAssigned(tx, principal.userId),
      scope_approvals: await this.waiting.scopeApprovals(tx, principal.userId),
      articles_in_review: await this.waiting.articlesInReview(tx, principal.userId),
      report_reviews: await this.waiting.reportReviews(tx, principal.userId),
      unread_notifications: await this.waiting.unreadNotifications(tx, principal.userId),
      csat_low_scores: await this.waiting.csatLowScores(tx, principal.userId),
    }));
    // The pending-time count is the same number GET /v1/timesheets/me/unlogged
    // reports, so the rail and the timesheet can never disagree. The week
    // stops at today: a Friday not yet worked is not time anyone owes.
    const week = weekBounds(today);
    const unlogged = await this.time.unlogged(principal, week.from, today);
    const pendingDays = unlogged.days.filter((day) => day.unlogged_minutes > 0).length;

    return {
      as_of: today,
      items: [
        {
          key: 'tickets_assigned',
          label: 'Tickets assigned to me',
          count: counts.tickets_assigned,
          // The Queue's own system view for the signed-in person.
          link: '/tickets?view=mine',
        },
        {
          key: 'scope_approvals',
          label: 'Out-of-scope flags to approve',
          count: counts.scope_approvals,
          // The Queue filters on the flag now, so the row opens the
          // tickets it counts rather than the whole queue.
          link: '/tickets?out_of_scope=flagged',
        },
        {
          key: 'articles_in_review',
          label: 'My articles in review',
          count: counts.articles_in_review,
          // `in_review` is the article status vocabulary the Solutions
          // screen filters on; `review` alone matches no article.
          link: '/knowledge?status=in_review',
        },
        {
          key: 'report_reviews',
          label: 'Report packs to review',
          count: counts.report_reviews.count,
          // The review screen opens a run by id, so the row opens the
          // newest run waiting rather than a screen the reviewer must
          // search. Runs waiting on more than one account have no single
          // run to open, so those fall back to the Report packs tab of the
          // newest one's account; with none waiting the row points at the
          // report packs screen.
          link: linkForReportReviews(counts.report_reviews),
        },
        {
          key: 'unread_notifications',
          label: 'Unread notifications',
          count: counts.unread_notifications,
          // No link on purpose: notifications live in the shell's bell menu,
          // which is on every page, so there is no screen to open.
        },
        {
          key: 'pending_time',
          label: 'Days this week with unlogged time',
          count: pendingDays,
          // The timesheet opens on the current week, which is the week this
          // count is about; it takes no week parameter, so none is invented.
          link: '/time',
        },
        {
          key: 'csat_low_scores',
          label: 'Low satisfaction scores to answer',
          count: counts.csat_low_scores.count,
          // The Satisfaction tab of the account dashboard carries the scores
          // and the comments; the newest unread low score names the account.
          link: counts.csat_low_scores.account_id
            ? `/accounts/${counts.csat_low_scores.account_id}?tab=satisfaction`
            : '/accounts',
        },
      ],
    };
  }
}

/**
 * The rail is on every internal person's landing page, so it sits behind
 * the permission every internal person holds. Each count is already scoped
 * to the principal, so nothing here widens what they can see.
 */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class WaitingController {
  constructor(private readonly waiting: WaitingService) {}

  @Get('waiting')
  @RequirePermission('tickets:view')
  waitingOnMe(@CurrentPrincipal() principal: Principal): Promise<WaitingOnMe> {
    return this.waiting.forMe(principal);
  }
}

@Module({
  imports: [TimeCoreModule],
  providers: [WaitingRepository, WaitingService],
  exports: [WaitingService],
})
export class WaitingCoreModule {}

@Module({
  imports: [WaitingCoreModule],
  controllers: [WaitingController],
  exports: [WaitingCoreModule],
})
export class WaitingModule {}
