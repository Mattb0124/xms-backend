import { z } from 'zod';
import type { Permission } from '../contracts/permissions.js';
import type { RequestContext } from '../common/auth/decorators.js';
import type { Principal } from '../common/auth/principal.js';

import type { AiCapability } from '../contracts/ai.js';
import type { SuggestionService } from '../modules/ai/suggestion.service.js';
import type { KnowledgeService } from '../modules/knowledge/knowledge.module.js';
import type { ReportingService } from '../modules/reporting/reporting.service.js';
import type { TicketsService } from '../modules/tickets/tickets.service.js';
import type { TimeService } from '../modules/time/time.module.js';

/**
 * The tool catalog (AI Integration §4).
 *
 * A tool is a name, a permission, a shape and a body. It is NOT a second way
 * into the data: every body calls the same service an HTTP route calls, with
 * the principal the guard resolved, so the account binding, the audit writes
 * and the row-level policies are the ones the rest of the product already has.
 * Nothing here builds SQL, and nothing here takes an account id from the
 * caller: an agent that asked for another account's ticket would be answered
 * by the same `not_found` a browser gets, from the same policy.
 *
 * `permission` is declared per tool for the same reason a route declares one:
 * so the set can be read off in one place and asserted in a test, rather than
 * inferred from whichever service each body happens to call.
 *
 * Every tool speaks in ticket KEYS, never ids. An agent reads CS1000008 in a
 * thread; it has no way to know a uuid, and a tool that demanded one would
 * push the agent into a lookup it should not have to make.
 */
export interface McpTool<TShape extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The permission the caller must hold, mirroring the route that serves the same data. */
  readonly permission: Permission;
  /**
   * True where the tool changes something. A write tool says so in the
   * catalog rather than being recognised by its name, so the assertion that
   * the only direct writes are the two the specification allows can be made
   * against the data rather than against a naming convention.
   */
  readonly writes?: boolean;
  readonly input: TShape;
  run(
    principal: Principal,
    args: z.objectOutputType<TShape, z.ZodTypeAny>,
    ctx: RequestContext,
  ): Promise<unknown>;
}

export interface ToolDeps {
  readonly tickets: TicketsService;
  readonly knowledge: KnowledgeService;
  readonly time: TimeService;
  readonly suggestions: SuggestionService;
  readonly reporting: ReportingService;
}

/** The ticket key an agent will have read in a thread, not a uuid. */
const ticketKey = z.string().min(3).max(32).describe('The ticket key, for example CS1000008');

/**
 * A proposal names the ticket by key; `propose` needs the id. Resolving it
 * here through the same read the tools use means the caller is checked against
 * the ticket before anything is written, and by the policy rather than by us.
 */
async function idOfTicket(deps: ToolDeps, principal: Principal, key: string): Promise<string> {
  return (await ticketOf(deps, principal, key)).id;
}

/**
 * The ticket behind a key, and with it the account and contract it belongs
 * to. This is why no tool takes an account id: the agent names something it
 * can actually see, the read is checked by the policy, and the ids come from
 * the row rather than from the caller. An agent that named an account it may
 * not see would be refused here, on the ticket, before anything downstream
 * was asked.
 */
async function ticketOf(
  deps: ToolDeps,
  principal: Principal,
  key: string,
): Promise<{ id: string; account_id: string; contract_id: string }> {
  return (await deps.tickets.get(principal, key)) as { id: string; account_id: string; contract_id: string };
}

/**
 * One `propose_*` tool. Each writes an AISuggestion through the same service
 * `POST /v1/ai/proposals` uses, so a proposal is a suggestion a human decides
 * on and never a mutation of the ticket (AI Integration §4, AI-08).
 */
function proposal(
  deps: ToolDeps,
  name: string,
  capability: AiCapability,
  title: string,
  description: string,
  payload: z.ZodRawShape,
): McpTool {
  return {
    name,
    title,
    description: `${description} Nothing is applied: this writes a suggestion for a person to accept, edit or reject.`,
    permission: 'ai:use',
    input: { key: ticketKey, ...payload },
    run: async (principal, args, ctx) => {
      const { key, ...rest } = args as { key: string } & Record<string, unknown>;
      return deps.suggestions.propose(principal, ctx, {
        capability,
        target_kind: 'ticket',
        target_id: await idOfTicket(deps, principal, key),
        payload: rest,
      });
    },
  };
}

export function buildTools(deps: ToolDeps): McpTool[] {
  const confidence = z
    .number()
    .min(0)
    .max(1)
    .describe('How sure you are, 0 to 1. Below the account threshold the suggestion is withheld rather than shown.');

  return [
    // ---------------------------------------------------------------- reads
    {
      name: 'get_ticket',
      title: 'Get a ticket',
      description:
        'One ticket by its key, for example CS1000008: state, priority, account, requester, assignee, contract position and service levels.',
      permission: 'tickets:view',
      input: { key: ticketKey },
      run: (principal, args) => deps.tickets.get(principal, args.key),
    },
    {
      name: 'list_tickets',
      title: 'List tickets',
      description:
        'Tickets the caller may see, newest first. Free text searches the summary and description. Use this to find a ticket when the key is not known.',
      permission: 'tickets:view',
      input: {
        q: z.string().max(200).optional().describe('Free text over the summary and description'),
        open: z.boolean().optional().describe('Only tickets that are not resolved or closed'),
        mine: z.boolean().optional().describe('Only tickets assigned to the caller'),
        limit: z.number().int().min(1).max(50).optional().describe('How many to return, at most 50'),
      },
      run: (principal, args) =>
        deps.tickets.list(principal, {
          ...(args.q ? { q: args.q } : {}),
          ...(args.open === undefined ? {} : { open: args.open }),
          ...(args.mine === undefined ? {} : { mine: args.mine }),
          limit: args.limit ?? 20,
        }),
    },
    {
      name: 'get_ticket_thread',
      title: 'Read a ticket thread',
      description:
        'Everything said on a ticket: the client-visible conversation, the internal work notes, and the activity timeline of what changed and when.',
      permission: 'tickets:view',
      input: { key: ticketKey },
      run: async (principal, args) => {
        const [comments, workNotes, timeline] = await Promise.all([
          deps.tickets.comments(principal, args.key),
          deps.tickets.workNotes(principal, args.key),
          deps.tickets.timeline(principal, args.key),
        ]);
        return { comments, work_notes: workNotes, timeline };
      },
    },
    {
      name: 'search_solutions',
      title: 'Search the knowledge base',
      description:
        'Published solution articles matching the words given, ranked. Covers the accounts the caller may see plus the global library.',
      permission: 'tickets:view',
      input: {
        q: z.string().min(2).max(200).describe('What to search for'),
        limit: z.number().int().min(1).max(25).optional().describe('How many to return, at most 25'),
      },
      run: (principal, args) => deps.knowledge.search(principal, args.q, args.limit ?? 10),
    },
    {
      name: 'get_article',
      title: 'Read a solution article',
      description: 'One knowledge article by its key, for example KB100001, with its sections and its visibility.',
      permission: 'tickets:view',
      input: { key: z.string().min(3).max(32).describe('The article key, for example KB100001') },
      run: (principal, args) => deps.knowledge.get(principal, args.key),
    },
    {
      name: 'find_similar_tickets',
      title: 'Find what resolved tickets like this one',
      description:
        'For one ticket: the matching solution articles, the similar tickets already resolved, and the resolutions recorded on them. Use before drafting a reply.',
      permission: 'tickets:view',
      input: { key: ticketKey },
      run: (principal, args) => deps.knowledge.rail(principal, args.key),
    },
    {
      name: 'get_unlogged_time',
      title: 'Find time not yet logged',
      description:
        "The caller's own working days against the time they have logged, so a nudge can name the days that are short.",
      permission: 'time:log',
      input: {
        from: z.string().length(10).optional().describe('First day, as YYYY-MM-DD. Defaults to six days ago.'),
        to: z.string().length(10).optional().describe('Last day, as YYYY-MM-DD. Defaults to today.'),
      },
      run: (principal, args) => {
        const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
        return deps.time.unlogged(principal, args.from ?? day(-6), args.to ?? day(0));
      },
    },

    {
      name: 'get_contract_position',
      title: 'Get the contract position behind a ticket',
      description:
        'For the account and contract a ticket belongs to: hours consumed against hours available, the burn rate, the thresholds fired and the forecast. Use for burn anomalies and for a report narrative.',
      permission: 'tickets:view',
      input: { key: ticketKey },
      run: async (principal, args) => {
        const ticket = await ticketOf(deps, principal, args.key);
        return deps.time.contractPosition(principal, ticket.account_id, ticket.contract_id);
      },
    },
    {
      name: 'get_period_metrics',
      title: 'Get the measures for a period',
      description:
        'The operations dashboard for the last few days: volumes, service levels, outcomes, backlog by age and the notable tickets. Portfolio-wide.',
      permission: 'reports:view-portfolio',
      input: { days: z.number().int().min(1).max(90).optional().describe('How many days back, at most 90. Defaults to 7.') },
      run: (principal, args) => deps.reporting.operations(principal, args.days ?? 7),
    },
    {
      name: 'get_account_metrics',
      title: 'Get the measures for the account a ticket belongs to',
      description:
        'The same measures as the period ones, narrowed to the account of the ticket given. Named by ticket rather than by account, because a key is what an agent has.',
      permission: 'tickets:view',
      input: {
        key: ticketKey,
        days: z.number().int().min(1).max(90).optional().describe('How many days back, at most 90. Defaults to 7.'),
      },
      run: async (principal, args) => {
        const ticket = await ticketOf(deps, principal, args.key);
        return deps.reporting.account(principal, ticket.account_id, args.days ?? 7, false);
      },
    },

    // --------------------------------------------------------------- writes
    //
    // The only two direct writes the specification allows (AI Integration §4).
    // Everything else an agent wants to change goes through a `propose_*`.
    {
      name: 'add_work_note',
      title: 'Add an internal work note',
      description:
        'Writes an internal note on a ticket. Never client-visible. The note is recorded as written by AI on behalf of the caller.',
      permission: 'tickets:work',
      writes: true,
      input: {
        key: ticketKey,
        body: z.string().min(1).max(50_000).describe('The note, in plain words'),
      },
      // `authorKind: 'ai'` is the whole of AI-10 on this path: an AI act has
      // to be distinguishable from a person's in the record, and the default
      // on this service is 'user'. Without it the note lands looking like the
      // caller typed it, which is exactly the confusion the requirement names.
      run: (principal, args, ctx) =>
        deps.tickets.addWorkNote(principal, ctx, args.key, { body: args.body }, undefined, {
          authorKind: 'ai',
          authorName: `Axel (for ${principal.displayName})`,
        }),
    },

    {
      name: 'create_article_draft',
      title: 'Draft a solution article',
      description:
        'Writes a DRAFT knowledge article for the account of the ticket given, from what resolved it. A draft is not published and is not visible to a client: a person reviews and publishes it.',
      permission: 'kb:author',
      writes: true,
      input: {
        key: ticketKey.describe('The ticket this was learned from; its account is the one the article is filed under'),
        title: z.string().min(3).max(200).describe('What the article is called'),
        kind: z
          .string()
          .max(20)
          .optional()
          .describe('One of solution, workaround, known_error, procedure, reference'),
        problem_statement: z.string().max(20_000).optional().describe('What goes wrong'),
        environment: z.string().max(20_000).optional().describe('Where it happens'),
        symptoms: z.string().max(20_000).optional().describe('What the reporter sees'),
        cause: z.string().max(20_000).optional().describe('Why it happens'),
        steps: z.string().max(50_000).optional().describe('What to do about it'),
        verification: z.string().max(20_000).optional().describe('How to tell it worked'),
        rollback: z.string().max(20_000).optional().describe('How to undo it'),
        client_notes: z.string().max(20_000).optional().describe('What a client may be told'),
      },
      run: async (principal, args, ctx) => {
        const { key, ...article } = args as { key: string } & Record<string, unknown>;
        // The account comes from the ticket, never from the caller, and the
        // read is checked by the policy first. An agent that named an account
        // it may not see could not get this far.
        const ticket = await ticketOf(deps, principal, key);
        return deps.knowledge.create(principal, ctx, {
          account_id: ticket.account_id,
          ...article,
        } as Parameters<KnowledgeService['create']>[2]);
      },
    },

    // ------------------------------------------------------------ proposals
    proposal(deps, 'propose_classification', 'classify', 'Propose a category', 'Suggests the ticket type and category.', {
      type: z.string().max(40).describe('The ticket type'),
      category: z.string().max(80).describe('The category'),
      confidence,
      reason: z.string().max(2000).describe('Why, in one or two sentences'),
    }),
    proposal(deps, 'propose_priority', 'prioritise', 'Propose a priority', 'Suggests impact and urgency, from which priority is derived.', {
      impact: z.string().max(20).describe('The impact level'),
      urgency: z.string().max(20).describe('The urgency level'),
      confidence,
      reason: z.string().max(2000).describe('Why, in one or two sentences'),
    }),
    proposal(deps, 'propose_duplicate', 'duplicate', 'Propose a duplicate', 'Suggests that this ticket duplicates another.', {
      duplicate_of_key: ticketKey.describe('The key of the ticket this one duplicates'),
      confidence,
      reason: z.string().max(2000).describe('What makes them the same'),
    }),
    proposal(deps, 'propose_summary', 'summarise', 'Propose a summary', 'Suggests a summary of the thread so far.', {
      summary: z.string().max(8000).describe('The summary'),
      confidence,
    }),
    proposal(deps, 'propose_reply', 'draft_reply', 'Propose a reply', 'Drafts a reply to the requester.', {
      body: z.string().max(20_000).describe('The drafted reply'),
      confidence,
    }),
  ];
}
