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
  readonly link: string;
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
   */
  reportReviews(tx: Tx, userId: string): Promise<number> {
    return this.scalar(
      tx,
      `select count(*)::int as count from acct.report_runs r
        where r.status = any ($2::text[])
          and (r.reviewer_id = $1
               or (r.reviewer_id is null and r.account_id in (select id from op.accounts where owner_user_id = $1)))`,
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
  csatLowScores(tx: Tx, userId: string): Promise<number> {
    return this.scalar(
      tx,
      `select count(*)::int as count from acct.notifications
        where recipient_id = $1 and read_at is null and type = 'csat.low_score'`,
      [userId],
    );
  }

  private async scalar(tx: Tx, text: string, values: unknown[]): Promise<number> {
    const rows = await this.many<{ count: number }>(tx, text, values);
    return rows[0]?.count ?? 0;
  }
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
          link: '/queue?view=my-tickets',
        },
        {
          key: 'scope_approvals',
          label: 'Out-of-scope flags to approve',
          count: counts.scope_approvals,
          link: '/queue?view=awaiting-approval',
        },
        {
          key: 'articles_in_review',
          label: 'My articles in review',
          count: counts.articles_in_review,
          link: '/knowledge?status=in_review&owner=me',
        },
        {
          key: 'report_reviews',
          label: 'Report packs to review',
          count: counts.report_reviews,
          link: '/reports/runs?status=awaiting_review',
        },
        {
          key: 'unread_notifications',
          label: 'Unread notifications',
          count: counts.unread_notifications,
          link: '/notifications',
        },
        {
          key: 'pending_time',
          label: 'Days this week with unlogged time',
          count: pendingDays,
          link: `/timesheet?week=${week.from}`,
        },
        {
          key: 'csat_low_scores',
          label: 'Low satisfaction scores to answer',
          count: counts.csat_low_scores,
          link: '/notifications?type=csat.low_score',
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
