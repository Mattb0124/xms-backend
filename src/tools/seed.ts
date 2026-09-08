import type { INestApplicationContext } from '@nestjs/common';
import { SYSTEM_ACTOR, AuditService } from '../common/audit/audit.service.js';
import type { Principal } from '../common/auth/principal.js';
import { GLOBAL_ACCOUNT_ID } from '../common/auth/principal.repository.js';
import type { RequestContext } from '../common/auth/decorators.js';
import { loadEnv } from '../config/env.js';
import { expandPermissions, OPERATOR_PERMISSIONS, type Permission } from '../contracts/permissions.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { AiSettingsService } from '../modules/ai/ai-settings.service.js';
import { ConnectorsService } from '../modules/connectors/connectors.service.js';
import { CapacityService } from '../modules/capacity/capacity.module.js';
import { RosterService } from '../modules/roster/roster.module.js';
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
  readonly connectorsCreated: number;
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

const SEED_FIELD_MAP = [
  { external: 'short_description', xms: 'short_description', direction: 'both' },
  { external: 'description', xms: 'description', direction: 'both' },
  { external: 'contact.email', xms: 'requester_email', direction: 'in' },
  { external: 'contact', xms: 'requester_name', direction: 'in' },
  { external: 'number', xms: 'client_reference', direction: 'in' },
  {
    external: 'impact',
    xms: 'impact',
    direction: 'in',
    transform: { kind: 'lookup', values: { '1': 'high', '2': 'medium', '3': 'low' }, fallback: 'medium' },
  },
  {
    external: 'urgency',
    xms: 'urgency',
    direction: 'in',
    transform: { kind: 'lookup', values: { '1': 'high', '2': 'medium', '3': 'low' }, fallback: 'medium' },
  },
  { external: 'category', xms: 'category', direction: 'both' },
];

const SEED_STATE_MAP = {
  incident: {
    inbound: {
      '1': 'new',
      '10': 'in_progress',
      '18': 'awaiting_client',
      '6': 'resolved',
      '3': 'closed',
      '7': 'cancelled',
    },
    outbound: {
      new: '1',
      assigned: '1',
      in_progress: '10',
      awaiting_client: '18',
      awaiting_third_party: '18',
      resolved: '6',
      closed: '3',
      cancelled: '7',
    },
    accept_inbound: ['cancelled', 'in_progress', 'awaiting_client'],
    fallback: { '1': 'new', '18': 'awaiting_client' },
  },
};

/** The skills matrix reads a catalog and a level per person; four levels, one meaning each. */
const SKILLS = [
  { kind: 'technology', code: 'onestream', name: 'OneStream platform' },
  { kind: 'technology', code: 'sql', name: 'SQL and data loads' },
  { kind: 'technology', code: 'networking', name: 'Networking and VPN' },
  { kind: 'process', code: 'financial_close', name: 'Financial close' },
  { kind: 'process', code: 'incident_management', name: 'Incident management' },
  { kind: 'account', code: 'brookfield_estate', name: 'Brookfield estate' },
] as const;

/** Levels per role, so the matrix reads as a team rather than as noise. */
const SKILL_LEVELS: Record<string, readonly (readonly [string, number])[]> = {
  Consultant: [
    ['onestream', 3],
    ['sql', 3],
    ['financial_close', 2],
    ['incident_management', 3],
  ],
  Dispatcher: [
    ['incident_management', 4],
    ['networking', 2],
  ],
  'Account Owner': [
    ['financial_close', 3],
    ['brookfield_estate', 4],
    ['incident_management', 2],
  ],
  Finance: [['financial_close', 4]],
};

/** Pipeline and project demand for the Demand screen, in the three months ahead. */
const DEMAND = [
  { source: 'project', account: 'BRK', role: 'consultant', hours: 120, monthOffset: 0, probability: 1 },
  { source: 'project', account: 'AUS', role: 'consultant', hours: 80, monthOffset: 0, probability: 1 },
  { source: 'project', account: 'BRK', role: 'consultant', hours: 90, monthOffset: 1, probability: 1 },
  { source: 'pipeline', prospect: 'Meridian Foods', role: 'consultant', hours: 160, monthOffset: 1, probability: 0.6 },
  { source: 'pipeline', prospect: 'Calder Energy', role: 'dispatcher', hours: 60, monthOffset: 2, probability: 0.3 },
  { source: 'pipeline', prospect: 'Meridian Foods', role: 'consultant', hours: 200, monthOffset: 2, probability: 0.6 },
] as const;

/** One rate card per account, the roles the roster actually uses. */
const RATES: Record<string, readonly { role: string; bill_rate: number }[]> = {
  BRK: [
    { role: 'consultant', bill_rate: 185 },
    { role: 'dispatcher', bill_rate: 120 },
    { role: 'account_owner', bill_rate: 240 },
    { role: 'finance', bill_rate: 140 },
  ],
  AUS: [
    { role: 'consultant', bill_rate: 210 },
    { role: 'dispatcher', bill_rate: 135 },
    { role: 'account_owner', bill_rate: 265 },
    { role: 'finance', bill_rate: 155 },
  ],
};

const CSAT_ANSWERS = [
  { score: 5, comment: 'Fixed the same morning and explained what had changed.' },
  { score: 4, comment: 'Good work; the update could have come a little sooner.' },
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
  const connectors = app.get(ConnectorsService);
  const capacity = app.get(CapacityService);
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
    // The seed is a tool, not the worker: it acts as the administrator on
    // the accounts it is creating, so it binds them on the app role. The
    // worker role is deliberately narrower in the operator schema (0026).
    await uow.system([account.id], async (tx) => {
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
      // An account-scoped role assignment only counts where a grant row
      // exists, so without this every desk user but the bootstrap
      // administrator resolves to no accounts and no permissions
      // (REVIEW-frontend 2026-09-08 finding 5). Idempotent: replaceGrants
      // adds only what is missing.
      await users.replaceGrants(tx, user.id, allAccounts, 'seed');
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
      // The worker's AI intake runs as this principal and needs the same grants.
      await users.replaceGrants(tx, service.id, allAccounts, 'seed');
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
    const count = await uow.system([accountId], (tx) =>
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
    await uow.system([accountId], async (tx) => {
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

  // Roster from the directory: every internal user becomes a person with a default calendar --------
  const roster = app.get(RosterService);
  const imported = await roster.importFromDirectory(principal, ctx);
  if (imported.created > 0) log(`roster: ${imported.created} people imported from the directory`);

  // Skills, allocations and demand -------------------------------------------
  // Whole screens had nothing to show because these tables were empty
  // (REVIEW-frontend 2026-09-08 finding 6). Everything below is idempotent
  // and derived from the deterministic generator, so a second run adds
  // nothing and two environments look the same.
  const people = await roster.list(principal, {});
  const personByEmail = new Map(people.map((person) => [person.email.toLowerCase(), person]));
  const roleOf = new Map(TEAM.map((member) => [member.email, member.role as string]));

  const catalog = await roster.skillsCatalog(principal, true);
  for (const skill of SKILLS) {
    if (catalog.some((row) => row.code === skill.code)) continue;
    await roster.createSkill(principal, ctx, {
      kind: skill.kind,
      code: skill.code,
      name: skill.name,
      account_id: skill.code === 'brookfield_estate' ? accountIds.get('BRK') : undefined,
    } as never);
  }
  let skillsSet = 0;
  for (const member of TEAM) {
    const person = personByEmail.get(member.email);
    if (!person) continue;
    if ((await roster.personSkills(principal, person.id)).length > 0) continue;
    const levels = SKILL_LEVELS[roleOf.get(member.email) ?? ''] ?? [];
    if (levels.length === 0) continue;
    await roster.setSkills(principal, ctx, person.id, {
      skills: levels.map(([code, level]) => ({ code, level })),
    } as never);
    skillsSet += 1;
  }
  if (skillsSet > 0) log(`skills: catalog of ${SKILLS.length}, levels set for ${skillsSet} people`);

  const monthOf = (offset: number): string => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
  };
  const thisMonth = monthOf(0);
  const existingAllocations = await capacity.allocations(principal, { from: thisMonth, to: monthOf(2) });
  if ((existingAllocations as { cells?: unknown[] }).cells?.length === 0 || !('cells' in existingAllocations)) {
    const cells: { person_id: string; account_id: string; month: string; planned_minutes: number }[] = [];
    for (const member of TEAM) {
      const person = personByEmail.get(member.email);
      if (!person) continue;
      for (const [index, key] of ACCOUNTS.map((account) => account.key).entries()) {
        for (const offset of [0, 1]) {
          // Half a week per account per month for the first, a third for the
          // second, so the grid shows a split rather than a flat line.
          const hours = index === 0 ? 60 : 40;
          cells.push({
            person_id: person.id,
            account_id: accountIds.get(key)!,
            month: monthOf(offset),
            planned_minutes: (hours - offset * 10) * 60,
          });
        }
      }
    }
    if (cells.length > 0) {
      await capacity.putAllocations(principal, ctx, { cells } as never);
      log(`capacity: ${cells.length} allocation cells`);
    }
  }

  const currentDemand = await capacity.demand(principal, { from: thisMonth, to: monthOf(3) });
  if (((currentDemand as { rows?: unknown[] }).rows ?? []).length === 0) {
    for (const row of DEMAND) {
      await capacity.addDemand(principal, ctx, {
        source: row.source,
        account_id: 'account' in row ? accountIds.get(row.account)! : undefined,
        prospect_name: 'prospect' in row ? row.prospect : undefined,
        month: monthOf(row.monthOffset),
        hours: row.hours,
        probability: row.probability,
        role: row.role,
      } as never);
    }
    log(`demand: ${DEMAND.length} rows`);
  }

  // Rate cards, a billing period and satisfaction ----------------------------
  for (const seed of ACCOUNTS) {
    const accountId = accountIds.get(seed.key)!;
    if ((await time.rateCards(principal, accountId)).length === 0) {
      await time.createRateCard(principal, ctx, accountId, {
        effective_from: monthOf(-6),
        currency: seed.key === 'AUS' ? 'AUD' : 'GBP',
        note: 'Seeded standard rates',
        entries: RATES[seed.key],
      } as never);
      log(`account ${seed.key}: rate card from ${monthOf(-6)}`);
    }
    if ((await time.billingPeriods(principal, accountId)).length === 0) {
      const startsOn = monthOf(-1);
      const endsOn = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 0))
        .toISOString()
        .slice(0, 10);
      await time.createBillingPeriod(principal, ctx, accountId, { starts_on: startsOn, ends_on: endsOn } as never);
      log(`account ${seed.key}: billing period ${startsOn} to ${endsOn}`);
    }
  }

  // Two answered surveys per account so Satisfaction and the portal have
  // something to show. The link token is never needed here, so only its
  // hash is written, exactly as the service does.
  let surveysCreated = 0;
  for (const seed of ACCOUNTS) {
    const accountId = accountIds.get(seed.key)!;
    await uow.system([accountId], async (tx) => {
      const existing = await tx.query<{ n: number }>(
        'select count(*)::int as n from acct.csat_surveys where account_id = $1',
        [accountId],
      );
      if (Number(existing.rows[0].n) > 0) return;
      const closed = await tx.query<{ id: string; requester_contact_id: string | null }>(
        `select id, requester_contact_id from acct.tickets
          where account_id = $1 and state in ('closed', 'resolved') and requester_contact_id is not null
          order by number limit $2`,
        [accountId, CSAT_ANSWERS.length],
      );
      for (const [index, ticket] of closed.rows.entries()) {
        const answer = CSAT_ANSWERS[index];
        const survey = await tx.query<{ id: string }>(
          `insert into acct.csat_surveys (account_id, kind, ticket_id, contact_id, token_hash, status, sent_at, answered_at)
           values ($1, 'ticket_close', $2, $3, encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'answered',
                   now() - interval '5 days', now() - interval '4 days')
           on conflict do nothing returning id`,
          [accountId, ticket.id, ticket.requester_contact_id],
        );
        const surveyId = survey.rows[0]?.id;
        if (!surveyId) continue;
        await tx.query(
          `insert into acct.csat_responses (account_id, survey_id, answers, comment) values ($1, $2, $3, $4)`,
          [accountId, surveyId, JSON.stringify({ score: answer.score }), answer.comment],
        );
        surveysCreated += 1;
      }
    });
  }
  if (surveysCreated > 0) log(`satisfaction: ${surveysCreated} answered surveys`);

  // Published articles the client portal can actually find.
  let visibilityRows = 0;
  for (const seed of ACCOUNTS) {
    const accountId = accountIds.get(seed.key)!;
    for (const articleId of articleIds.get(seed.key) ?? []) {
      await uow.system([accountId], async (tx) => {
        const inserted = await tx.query(
          `insert into acct.article_visibility (article_id, account_id, visible_account_id, granted_by)
           values ($1, $2, $2, 'seed') on conflict do nothing`,
          [articleId, accountId],
        );
        visibilityRows += inserted.rowCount ?? 0;
      });
    }
  }
  if (visibilityRows > 0) log(`knowledge: ${visibilityRows} articles visible to their account portal`);

  // A ServiceNow instance against the local stand-in, when one is reachable ------
  let connectorsCreated = 0;
  if (process.env.SEED_SERVICENOW_URL) {
    const brkId = accountIds.get('BRK')!;
    const existing = await connectors.list(principal, brkId);
    if (existing.length === 0) {
      const instance = await connectors.create(principal, ctx, brkId, {
        name: 'Brookfield CSM (stand-in)',
        base_url: process.env.SEED_SERVICENOW_URL,
        auth_kind: 'basic',
        credential: { username: 'xms.integration', password: 'stand-in' },
        profile: 'csm',
        poll_interval_seconds: 30,
      });
      const fieldMap = await connectors.createMap(principal, ctx, 'field', instance.id, SEED_FIELD_MAP);
      await connectors.samples(principal, instance.id, fieldMap.id).catch(() => undefined);
      const fieldReport = await connectors.validateMap(principal, 'field', instance.id, fieldMap.id);
      if (fieldReport.ok) await connectors.activateMap(principal, ctx, 'field', instance.id, fieldMap.id);
      const stateMap = await connectors.createMap(principal, ctx, 'state', instance.id, SEED_STATE_MAP);
      const stateReport = await connectors.validateMap(principal, 'state', instance.id, stateMap.id);
      if (stateReport.ok) await connectors.activateMap(principal, ctx, 'state', instance.id, stateMap.id);
      if (fieldReport.ok) {
        const fresh = (await connectors.list(principal, brkId)).find((row) => row.id === instance.id)!;
        await connectors.update(principal, ctx, instance.id, { version: fresh.version, mode: 'ingest_only' });
      }
      connectorsCreated += 1;
      log(
        `connector ${instance.name} ${fieldReport.ok ? 'in ingest-only mode' : 'created; field map did not validate: ' + fieldReport.problems.join('; ')}`,
      );
    }
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
    connectorsCreated,
    elapsedMs: Date.now() - started,
  };
  log(
    `seed done in ${(summary.elapsedMs / 1000).toFixed(1)}s: ${ticketsCreated} tickets, ${articlesCreated} articles, ${usersCreated} users`,
  );
  return summary;
}
