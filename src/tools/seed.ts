import type { INestApplicationContext } from '@nestjs/common';
import { SYSTEM_ACTOR, AuditService } from '../common/audit/audit.service.js';
import type { Principal } from '../common/auth/principal.js';
import { GLOBAL_ACCOUNT_ID } from '../common/auth/principal.repository.js';
import type { RequestContext } from '../common/auth/decorators.js';
import { loadEnv } from '../config/env.js';
import { expandPermissions, OPERATOR_PERMISSIONS, type Permission } from '../contracts/permissions.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { AiSettingsService } from '../modules/ai/ai-settings.service.js';
import { AccountsRepository } from '../modules/admin/accounts/accounts.repository.js';
import { BootstrapService } from '../modules/admin/bootstrap.service.js';
import { ConfigService } from '../modules/admin/config/config.service.js';
import { UsersRepository } from '../modules/admin/users/users.repository.js';
import { KnowledgeService } from '../modules/knowledge/knowledge.module.js';
import { TicketsService, type TicketView } from '../modules/tickets/tickets.service.js';
import type { TransitionDto } from '../modules/tickets/tickets.dto.js';
import { TimeService } from '../modules/time/time.module.js';

/**
 * The development and demo seed (P1.8.3, Test Strategy section 4): system
 * roles and defaults, administrators, an internal team across three groups,
 * a service user for Axel, two fictional accounts with contrasting calendars
 * and contracts of different models, portal users, published articles, and
 * tickets across every state with comments, work notes, time and backdated
 * clocks so the queue, SLA badges and dashboards have something to show.
 * Idempotent: a second run adds nothing. Deterministic: a seeded generator
 * drives every choice so two environments look the same.
 */
export interface SeedOptions {
  /** Tickets per account. */
  readonly ticketsPerAccount?: number;
  readonly log?: (line: string) => void;
}

export interface SeedSummary {
  readonly accounts: number;
  readonly users: number;
  readonly ticketsCreated: number;
  readonly articlesCreated: number;
  readonly elapsedMs: number;
}

const TEAM = [
  { email: 'ana.costa@example.test', first: 'Ana', last: 'Costa', role: 'Consultant', group: 'OneStream Technical' },
  { email: 'ben.okafor@example.test', first: 'Ben', last: 'Okafor', role: 'Consultant', group: 'OneStream Technical' },
  { email: 'chloe.martin@example.test', first: 'Chloe', last: 'Martin', role: 'Consultant', group: 'Infrastructure' },
  { email: 'dev.patel@example.test', first: 'Dev', last: 'Patel', role: 'Dispatcher', group: 'CSM' },
  { email: 'erin.walsh@example.test', first: 'Erin', last: 'Walsh', role: 'Account Owner', group: 'CSM' },
  { email: 'femi.adeyemi@example.test', first: 'Femi', last: 'Adeyemi', role: 'Finance', group: null },
] as const;

const ACCOUNTS = [
  { key: 'BRK', name: 'Brookfield', tz: 'Europe/London', model: 'retainer', hours: 40, domain: 'brookfield.test' },
  {
    key: 'AUS',
    name: 'Austral Mining',
    tz: 'Australia/Sydney',
    model: 'prepaid_block',
    hours: 120,
    domain: 'austral.test',
  },
] as const;

const PORTAL = [
  { first: 'Pat', last: 'Client', role: 'Requester' },
  { first: 'Sam', last: 'Owner', role: 'Account Admin' },
  { first: 'Robin', last: 'Reader', role: 'Read Only' },
] as const;

const SUBJECTS = [
  ['VPN drops every 20 minutes', 'Since the client update last week the tunnel resets; floor 3 mostly.'],
  ['Cannot log in to the finance portal', 'Password reset does not arrive; two users affected.'],
  ['Consolidation run fails at step 4', 'Error CE-4102 on the September close; screenshot attached to the email.'],
  ['New starter needs access to the reporting cube', 'Starting Monday; same profile as the team lead.'],
  ['Printer on floor 2 jams', 'Every third page; toner replaced yesterday.'],
  ['Data load from SAP is two hours late', 'The nightly extract did not land until 06:10.'],
  ['Dashboard shows wrong currency for APAC', 'AUD shown as USD on the regional view.'],
  ['Request: add cost centre hierarchy level', 'Finance wants a fourth level for the 2027 plan.'],
  ['Email notifications duplicated', 'Every ticket update arrives twice since Tuesday.'],
  ['Laptop will not boot after update', 'Blue screen on start; user is remote.'],
  ['Budget upload template rejected', 'Validation says column J is invalid; template unchanged.'],
  ['Slow report rendering on month end', 'The P&L takes four minutes; usually thirty seconds.'],
] as const;

const CATEGORIES = ['Network / VPN', 'Access', 'Finance close', 'Reporting', 'Hardware', 'Integration'] as const;
const LEVELS = ['high', 'medium', 'low'] as const;
const ACTIVITIES = ['analysis', 'development', 'testing', 'client_meeting', 'documentation'] as const;

/** Mulberry32: small, seeded, good enough for demo data. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seedDev(app: INestApplicationContext, options: SeedOptions = {}): Promise<SeedSummary> {
  const started = Date.now();
  const log = options.log ?? ((line: string) => console.log(line));
  const perAccount = options.ticketsPerAccount ?? 100;
  const env = loadEnv();
  const uow = app.get(UnitOfWork);
  const users = app.get(UsersRepository);
  const accounts = app.get(AccountsRepository);
  const audit = app.get(AuditService);
  const bootstrap = app.get(BootstrapService);
  const config = app.get(ConfigService);
  const tickets = app.get(TicketsService);
  const time = app.get(TimeService);
  const knowledge = app.get(KnowledgeService);
  const aiSettings = app.get(AiSettingsService);
  const random = generator(20260907);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const between = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1));

  const createdConfig = await config.ensureDefaults();
  log(`configuration defaults: ${createdConfig.length} created`);

  // Roles, administrators, team, groups, service user ------------------------
  let usersCreated = 0;
  const team = new Map<string, string>();
  await uow.operator(async (tx) => {
    const roles = await bootstrap.ensureSystemRoles(tx);
    log(`system roles: ${roles.length} created`);
    const administrator = (await users.roleByName(tx, 'operator', 'Administrator'))!;
    for (const email of env.BOOTSTRAP_ADMIN_EMAILS) {
      const existing = await users.byEmail(tx, email);
      const user =
        existing ??
        (await users.insert(tx, {
          kind: 'internal',
          email,
          clerk_user_id: `dev_${email.replace(/[^a-z0-9]/gi, '_')}`,
          status: 'active',
          first_name: 'Dev',
          last_name: 'Administrator',
        }));
      if (!existing) usersCreated += 1;
      const assigned = await users.assignmentsOf(tx, user.id);
      if (!assigned.some((role) => role.role_id === administrator.id)) {
        await users.replaceAssignments(tx, user.id, [
          ...assigned.map((role) => ({ roleId: role.role_id, accountId: role.account_id })),
          { roleId: administrator.id, accountId: null },
        ]);
      }
      log(`administrator ${email} ready (${existing ? 'existing' : 'created'})`);
    }
    for (const name of ['CSM', 'OneStream Technical', 'Infrastructure']) {
      const exists = (await users.groups(tx)).some((group) => group.name === name);
      if (!exists) await users.insertGroup(tx, { name });
    }
  });

  // Accounts ------------------------------------------------------------------
  const accountIds = new Map<string, string>();
  for (const seed of ACCOUNTS) {
    const existing = await uow.operator((tx) => accounts.list(tx, { limit: 200 }));
    const found = existing.find((account) => account.key === seed.key);
    if (found) {
      accountIds.set(seed.key, found.id);
      continue;
    }
    const account = await uow.operator((tx) =>
      accounts.insert(tx, { key: seed.key, name: seed.name, default_time_zone: seed.tz }),
    );
    accountIds.set(seed.key, account.id);
    await uow.worker([account.id], async (tx) => {
      await accounts.insertSettings(tx, account.id);
      await audit.account(tx, account.id, SYSTEM_ACTOR, {}, [
        {
          entityKind: 'account',
          entityId: account.id,
          eventType: 'admin.account.created',
          newValue: { key: seed.key, seed: true },
        },
      ]);
      await tx.query(`update op.accounts set status = 'active' where id = $1`, [account.id]);
      const contract = await tx.query<{ id: string }>(
        `insert into acct.contracts (account_id, key, name, model, period_hours, status)
         values ($1, 'CT' || lpad(nextval('acct.contract_number_seq')::text, 5, '0'), $2, $3, $4, 'active') returning id`,
        [
          account.id,
          seed.model === 'retainer' ? 'Managed services retainer' : 'Prepaid support block',
          seed.model,
          seed.hours,
        ],
      );
      await tx.query(
        `insert into acct.contract_periods (account_id, contract_id, starts_on, ends_on, contracted_minutes)
         values ($1, $2, date_trunc('month', current_date)::date, (date_trunc('month', current_date) + interval '1 month - 1 day')::date, $3)`,
        [account.id, contract.rows[0].id, seed.hours * 60],
      );
    });
    log(`account ${seed.key} created`);
  }
  const allAccounts = [...accountIds.values()];

  // Team grants, groups, portal users, service user ---------------------------
  await uow.operator(async (tx) => {
    const groups = await users.groups(tx);
    const membership = new Map<string, string[]>();
    for (const member of TEAM) {
      const role = (await users.roleByName(tx, 'operator', member.role))!;
      const existing = await users.byEmail(tx, member.email);
      const user =
        existing ??
        (await users.insert(tx, {
          kind: 'internal',
          email: member.email,
          clerk_user_id: `dev_${member.email.replace(/[^a-z0-9]/gi, '_')}`,
          status: 'active',
          first_name: member.first,
          last_name: member.last,
        }));
      if (!existing) {
        usersCreated += 1;
        await users.replaceAssignments(
          tx,
          user.id,
          allAccounts.map((accountId) => ({ roleId: role.id, accountId })),
        );
      }
      team.set(member.email, user.id);
      if (member.group) membership.set(member.group, [...(membership.get(member.group) ?? []), user.id]);
    }
    for (const [name, memberIds] of membership) {
      const group = groups.find((candidate) => candidate.name === name);
      if (group) await users.replaceMembers(tx, group.id, memberIds);
    }
    const consultant = (await users.roleByName(tx, 'operator', 'Consultant'))!;
    if (!(await users.byEmail(tx, env.AI_SERVICE_USER_EMAIL))) {
      const service = await users.insert(tx, {
        kind: 'service',
        email: env.AI_SERVICE_USER_EMAIL,
        status: 'active',
        first_name: 'Axel',
        last_name: 'Service',
      });
      await users.replaceAssignments(
        tx,
        service.id,
        allAccounts.map((accountId) => ({ roleId: consultant.id, accountId })),
      );
      usersCreated += 1;
    }
    for (const seed of ACCOUNTS) {
      const accountId = accountIds.get(seed.key)!;
      for (const person of PORTAL) {
        const email = `${person.first.toLowerCase()}.${person.last.toLowerCase()}@${seed.domain}`;
        if (await users.byEmail(tx, email)) continue;
        const role = (await users.roleByName(tx, 'portal', person.role))!;
        const user = await users.insert(tx, {
          kind: 'portal',
          email,
          account_id: accountId,
          clerk_user_id: `dev_${email.replace(/[^a-z0-9]/gi, '_')}`,
          status: 'active',
          first_name: person.first,
          last_name: person.last,
        });
        await users.replaceAssignments(tx, user.id, [{ roleId: role.id, accountId }]);
        usersCreated += 1;
      }
    }
  });

  // The seeding identity: the first administrator, bound to every account.
  const adminRow = await uow.operator((tx) => users.byEmail(tx, env.BOOTSTRAP_ADMIN_EMAILS[0] ?? 'admin@example.test'));
  if (!adminRow) throw new Error('BOOTSTRAP_ADMIN_EMAILS must name at least one administrator');
  const principal: Principal = {
    kind: 'internal',
    userId: adminRow.id,
    email: adminRow.email,
    displayName: 'Dev Administrator',
    accountIds: [...allAccounts, GLOBAL_ACCOUNT_ID],
    permissions: expandPermissions(Object.keys(OPERATOR_PERMISSIONS) as Permission[]),
    tokenType: 'dev',
  };
  const ctx: RequestContext = { requestId: 'seed' };

  // Articles ------------------------------------------------------------------
  let articlesCreated = 0;
  const articleIds = new Map<string, string[]>();
  for (const seed of ACCOUNTS) {
    const accountId = accountIds.get(seed.key)!;
    const existing = await knowledge.list(principal, { account_id: accountId, limit: 50 } as never);
    const rows =
      (existing as { items?: { id: string; status: string }[] }).items ??
      (existing as { id: string; status: string }[]);
    if (rows.length > 0) {
      articleIds.set(
        seed.key,
        rows.filter((row) => row.status === 'published').map((row) => row.id),
      );
      continue;
    }
    const published: string[] = [];
    const drafts = [
      {
        title: 'VPN client reset loop after the 2.4 update',
        symptoms: 'Tunnel resets every 20 minutes.',
        cause: 'The 2.4.1 client caches the old gateway certificate.',
        steps: '1. Clear the client certificate store.\n2. Reconnect.\n3. Confirm the gateway fingerprint.',
        publish: true,
      },
      {
        title: 'Finance portal password reset emails not delivered',
        symptoms: 'Reset mail never arrives.',
        cause: 'The sender is not on the client allowlist.',
        steps: '1. Ask the client mail administrator to allowlist the sender.\n2. Resend the reset.',
        publish: true,
      },
      {
        title: 'Consolidation step 4 error CE-4102',
        symptoms: 'Close run stops at step 4.',
        cause: 'Unmapped entity in the September hierarchy.',
        steps: '1. Run the hierarchy check.\n2. Map the entity.\n3. Rerun the step.',
        publish: false,
      },
    ];
    for (const draft of drafts) {
      const article = await knowledge.create(principal, ctx, {
        account_id: accountId,
        title: draft.title,
        problem_statement: draft.symptoms,
        symptoms: draft.symptoms,
        cause: draft.cause,
        steps: draft.steps,
        verification: 'The requester confirms the fix.',
        categories: ['support'],
      } as never);
      articlesCreated += 1;
      if (draft.publish) {
        const submitted = await knowledge.submit(principal, ctx, article.id, article.version);
        const live = await knowledge.publish(principal, ctx, article.id, submitted.version);
        published.push(live.id);
      }
    }
    articleIds.set(seed.key, published);
  }

  // Tickets -------------------------------------------------------------------
  let ticketsCreated = 0;
  const consultants = TEAM.filter((member) => member.role === 'Consultant').map((member) => team.get(member.email)!);
  for (const seed of ACCOUNTS) {
    const accountId = accountIds.get(seed.key)!;
    const count = await uow.worker([accountId], (tx) =>
      tx.query<{ n: number }>(`select count(*)::int as n from acct.tickets where account_id = $1`, [accountId]),
    );
    const missing = perAccount - Number(count.rows[0].n);
    if (missing <= 0) continue;
    for (let index = 0; index < missing; index += 1) {
      const [subject, body] = pick(SUBJECTS);
      const roll = random();
      const type = roll < 0.6 ? 'incident' : roll < 0.85 ? 'service_request' : roll < 0.95 ? 'problem' : 'change';
      const requester = pick(PORTAL);
      const ticket = await tickets.create(principal, ctx, {
        account_id: accountId,
        type,
        short_description: `${subject}${index % 7 === 0 ? ' (again)' : ''}`,
        description: body,
        category: random() < 0.7 ? pick(CATEGORIES) : undefined,
        impact: pick(LEVELS),
        urgency: pick(LEVELS),
        requester_email: `${requester.first.toLowerCase()}.${requester.last.toLowerCase()}@${seed.domain}`,
        requester_name: `${requester.first} ${requester.last}`,
      });
      ticketsCreated += 1;
      const ageDays = between(0, 60);
      await drive(ticket, type, ageDays);
      await backdate(ticket.id, accountId, ageDays);
    }
    log(`account ${seed.key}: ${missing} tickets created`);
  }

  async function drive(ticket: TicketView, type: string, ageDays: number): Promise<void> {
    const target = random();
    const transition = async (view: TicketView, to: string, extra: Partial<TransitionDto> = {}): Promise<TicketView> =>
      (await tickets.transition(principal, ctx, view.id, {
        version: view.version,
        to,
        ...extra,
      } as TransitionDto)) as TicketView;
    let view = ticket;
    if (target < 0.15) return; // stays new
    const assignee = pick(consultants);
    view = (await tickets.patch(principal, ctx, view.id, {
      version: view.version,
      assignee_id: assignee,
    } as never)) as TicketView;
    if (random() < 0.6)
      await tickets.addWorkNote(principal, ctx, view.id, { body: 'Picked up; checking the recent changes first.' });
    if (type === 'problem') {
      view = await transition(view, 'investigating');
      return;
    }
    if (type === 'change') {
      view = await transition(view, 'assessment');
      return;
    }
    const working = type === 'incident' ? 'in_progress' : 'in_progress';
    view = await transition(view, type === 'service_request' ? 'triage' : 'assigned');
    if (target < 0.3) return; // assigned or triage
    view = await transition(view, working);
    if (random() < 0.5)
      await tickets.addComment(principal, ctx, view.id, {
        body: 'Thanks, we are looking at this now and will update you today.',
      });
    if (target < 0.55) return; // in progress
    if (target < 0.65) {
      view = await transition(view, 'awaiting_client', {
        pause_reason: 'awaiting_client',
        note: 'Waiting for the client to confirm the affected users',
      });
      return;
    }
    // Resolved or closed: time first, then the resolution record.
    const article = articleIds.get(ACCOUNTS.find((seed) => accountIds.get(seed.key) === view.account_id)!.key) ?? [];
    await time.logOnTicket(principal, ctx, view.id, {
      performed_on: new Date(Date.now() - Math.max(ageDays - 1, 0) * 86_400_000).toISOString().slice(0, 10),
      minutes: between(30, 240),
      activity_type: pick(ACTIVITIES),
      description: 'Investigation and fix',
    } as never);
    const useArticle = article.length > 0 && random() < 0.6;
    const done = type === 'incident' ? 'resolved' : 'fulfilled';
    view = await transition(view, done, {
      resolution: useArticle
        ? {
            code: 'fixed',
            notes: 'Applied the documented fix and confirmed with the requester.',
            solution_article_id: pick(article),
          }
        : {
            code: pick(['no_fault_found', 'user_guidance', 'workaround'] as const),
            notes: 'Guided the user; no further action needed.',
            solution_candidate: true,
          },
    } as Partial<TransitionDto>);
    if (target < 0.85) return; // resolved
    await transition(view, 'closed');
  }

  /** Shifts a ticket, its clocks and its messages into the past so the queue shows age and breaches. */
  async function backdate(ticketId: string, accountId: string, ageDays: number): Promise<void> {
    if (ageDays === 0) return;
    const shift = `${ageDays} days`;
    await uow.worker([accountId], async (tx) => {
      await audit.account(tx, accountId, SYSTEM_ACTOR, ctx, [
        {
          entityKind: 'ticket',
          entityId: ticketId,
          ticketId,
          eventType: 'ticket.updated',
          field: 'created_at',
          newValue: { seed_backdate_days: ageDays },
        },
      ]);
      await tx.query(
        `update acct.tickets set created_at = created_at - $2::interval, updated_at = updated_at - $2::interval,
                first_response_at = first_response_at - $2::interval, resolved_at = resolved_at - $2::interval, closed_at = closed_at - $2::interval
          where id = $1`,
        [ticketId, shift],
      );
      await tx.query(
        `update acct.sla_clocks set started_at = started_at - $2::interval, due_at = due_at - $2::interval, met_at = met_at - $2::interval where ticket_id = $1`,
        [ticketId, shift],
      );
      await tx.query(`update acct.comments set created_at = created_at - $2::interval where ticket_id = $1`, [
        ticketId,
        shift,
      ]);
      await tx.query(`update acct.work_notes set created_at = created_at - $2::interval where ticket_id = $1`, [
        ticketId,
        shift,
      ]);
    });
  }

  // AI switch on the first account ------------------------------------------
  const brk = accountIds.get('BRK')!;
  const current = await aiSettings.get(principal, brk);
  if (!current.enabled) {
    await aiSettings.update(principal, ctx, brk, {
      enabled: true,
      dpa_reference: 'DPA-SEED-BRK',
      version: current.version || undefined,
    });
    log('AI switch enabled on BRK');
  }

  const summary: SeedSummary = {
    accounts: allAccounts.length,
    users: usersCreated,
    ticketsCreated,
    articlesCreated,
    elapsedMs: Date.now() - started,
  };
  log(
    `seed done in ${(summary.elapsedMs / 1000).toFixed(1)}s: ${ticketsCreated} tickets, ${articlesCreated} articles, ${usersCreated} users`,
  );
  return summary;
}
