-- 0004 Ticket core (Ticket Management technical section 2; Implementation
-- Plan P1.5.1) plus the two account-scoped anchors the ticket needs before
-- their own modules land: contacts (Client Portal) and contracts (Time,
-- Contracts & Budget, cut to the entitlement anchor per Thirty-Day Build
-- section 5). Every table follows the isolation block; the portal role is
-- granted only what the Client Portal may read.

-- ---------------------------------------------------------------------------
-- acct.contacts: people at the account (portal user or email-only)
-- ---------------------------------------------------------------------------
create table acct.contacts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  email citext not null,
  display_name text not null default '',
  portal_user_id uuid,
  status text not null default 'active' check (status in ('active', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_acct_contacts_email on acct.contacts (account_id, email);
create index ix_acct_contacts_email_trgm on acct.contacts using gin ((email::text) gin_trgm_ops);
create trigger trg_acct_contacts_updated before update on acct.contacts for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.contacts', true);

-- ---------------------------------------------------------------------------
-- acct.contracts: the entitlement anchor (cut: one active period modelled
-- on the contract itself; periods, rate cards and rollover land in month 2)
-- ---------------------------------------------------------------------------
create table acct.contracts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  key text not null,
  name text not null,
  model text not null check (model in ('retainer', 'prepaid_block', 'time_and_materials', 'fixed_fee')),
  status text not null default 'draft' check (status in ('draft', 'active', 'expired', 'closed')),
  currency char(3) not null default 'USD',
  period_cadence text not null default 'monthly' check (period_cadence in ('monthly', 'quarterly', 'annual', 'none')),
  period_starts_on date,
  period_ends_on date,
  period_hours numeric(10,2),
  sla_policy jsonb,
  default_calendar_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create sequence acct.contract_number_seq start 10001;
create unique index ux_acct_contracts_key on acct.contracts (key);
create index ix_acct_contracts_account on acct.contracts (account_id, status);
create trigger trg_acct_contracts_updated before update on acct.contracts for each row execute function sys.set_updated_at();
create constraint trigger trg_acct_contracts_require_audit after update on acct.contracts
  deferrable initially deferred for each row execute function sys.require_audit();
select sys.apply_account_isolation('acct.contracts', false);

-- ---------------------------------------------------------------------------
-- acct.tickets
-- ---------------------------------------------------------------------------
create sequence acct.ticket_number_seq start 1000001;

create table acct.tickets (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  number bigint not null default nextval('acct.ticket_number_seq'),
  type text not null check (type in ('incident', 'service_request', 'change', 'problem', 'project_task')),
  state text not null,
  state_machine_version_id uuid not null,
  short_description text not null check (char_length(short_description) between 1 and 300),
  description text,
  category text,
  impact text check (impact in ('high', 'medium', 'low')),
  urgency text check (urgency in ('high', 'medium', 'low')),
  priority text not null check (priority in ('p1', 'p2', 'p3', 'p4')),
  priority_overridden boolean not null default false,
  matrix_version_id uuid,
  source text not null check (source in ('portal', 'email', 'internal', 'api', 'sync', 'import')),
  requester_contact_id uuid references acct.contacts (id),
  group_id text,
  assignee_id text,
  assignee_name text,
  contract_id uuid not null references acct.contracts (id) on delete restrict,
  configuration_item_id uuid,
  ticket_group_id uuid,
  out_of_scope text not null default 'none' check (out_of_scope in ('none', 'flagged', 'approved', 'declined')),
  out_of_scope_detail jsonb,
  resolution_code text,
  resolution_notes text,
  solution_article_id uuid,
  solution_candidate boolean not null default false,
  time_exemption_reason text,
  external_refs jsonb not null default '{}'::jsonb,
  reopen_count integer not null default 0,
  first_response_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  cancelled_at timestamptz,
  sla_response_breached boolean not null default false,
  sla_resolution_breached boolean not null default false,
  search tsvector generated always as (
    setweight(to_tsvector('english', coalesce(short_description, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(category, '')), 'C')
  ) stored,
  created_by text not null,
  created_by_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_acct_tickets_number on acct.tickets (number);
create index ix_acct_tickets_open on acct.tickets (account_id, state, updated_at desc) where state not in ('closed', 'cancelled');
create index ix_acct_tickets_assignee_open on acct.tickets (assignee_id) where state not in ('closed', 'cancelled');
create index ix_acct_tickets_search on acct.tickets using gin (search);
create index ix_acct_tickets_number_trgm on acct.tickets using gin ((('CS' || lpad(number::text, 7, '0'))) gin_trgm_ops);
create index ix_acct_tickets_requester on acct.tickets (requester_contact_id);
create trigger trg_acct_tickets_updated before update on acct.tickets for each row execute function sys.set_updated_at();
create constraint trigger trg_acct_tickets_require_audit after update on acct.tickets
  deferrable initially deferred for each row execute function sys.require_audit();
select sys.apply_account_isolation('acct.tickets', true);

-- ---------------------------------------------------------------------------
-- SLA clocks (mutable) and pauses (append-only evidence)
-- ---------------------------------------------------------------------------
create table acct.sla_clocks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ticket_id uuid not null references acct.tickets (id) on delete cascade,
  kind text not null check (kind in ('response', 'resolution')),
  policy_ref text not null,
  calendar_id text not null default '24x7',
  target_minutes integer not null check (target_minutes > 0),
  started_at timestamptz not null,
  due_at timestamptz not null,
  paused_at timestamptz,
  paused_total_minutes integer not null default 0,
  met_at timestamptz,
  breached_at timestamptz,
  at_risk_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index ux_acct_sla_clocks_ticket_kind on acct.sla_clocks (ticket_id, kind);
create index ix_acct_sla_clocks_due_live on acct.sla_clocks (due_at) where met_at is null and breached_at is null and paused_at is null;
create trigger trg_acct_sla_clocks_updated before update on acct.sla_clocks for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.sla_clocks', false);

create table acct.sla_pauses (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ticket_id uuid not null references acct.tickets (id) on delete cascade,
  clock_id uuid references acct.sla_clocks (id) on delete cascade,
  reason text not null check (reason in ('awaiting_client', 'awaiting_third_party', 'scheduled_window', 'blocked')),
  note text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  excluded_minutes integer,
  started_by text not null,
  ended_by text,
  created_at timestamptz not null default now()
);
create index ix_acct_sla_pauses_ticket on acct.sla_pauses (ticket_id, started_at);
-- Append-only, except that ended_at, excluded_minutes and ended_by may move
-- from null to a value exactly once (Ticket Management technical 2.2).
create or replace function acct.sla_pauses_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'acct.sla_pauses is append-only' using errcode = 'restrict_violation';
  end if;
  if old.ended_at is not null then
    raise exception 'acct.sla_pauses row already ended' using errcode = 'restrict_violation';
  end if;
  if new.id <> old.id or new.account_id <> old.account_id or new.ticket_id <> old.ticket_id
     or new.reason <> old.reason or new.started_at <> old.started_at or new.started_by <> old.started_by
     or coalesce(new.note, '') <> coalesce(old.note, '') or coalesce(new.clock_id::text, '') <> coalesce(old.clock_id::text, '') then
    raise exception 'acct.sla_pauses only ended_at, excluded_minutes and ended_by may change' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger trg_acct_sla_pauses_guard before update or delete on acct.sla_pauses
  for each row execute function acct.sla_pauses_guard();
select sys.apply_account_isolation('acct.sla_pauses', false);

-- ---------------------------------------------------------------------------
-- Comments (public) and work notes (internal): separate tables by design
-- ---------------------------------------------------------------------------
create table acct.comments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ticket_id uuid not null references acct.tickets (id) on delete cascade,
  author_kind text not null check (author_kind in ('user', 'portal_user', 'system', 'ai')),
  author_id text not null,
  author_name text not null default '',
  body text not null check (char_length(body) between 1 and 50000),
  body_html text,
  source text not null check (source in ('internal', 'portal', 'email', 'sync', 'ai')),
  external_ref jsonb,
  is_first_response boolean not null default false,
  corrects_id uuid,
  search tsvector generated always as (to_tsvector('english', coalesce(body, ''))) stored,
  created_at timestamptz not null default now()
);
create index ix_acct_comments_ticket on acct.comments (ticket_id, created_at);
create index ix_acct_comments_search on acct.comments using gin (search);
select sys.apply_account_isolation('acct.comments', true);

create table acct.work_notes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ticket_id uuid not null references acct.tickets (id) on delete cascade,
  author_kind text not null check (author_kind in ('user', 'system', 'ai')),
  author_id text not null,
  author_name text not null default '',
  body text not null check (char_length(body) between 1 and 50000),
  body_html text,
  source text not null check (source in ('internal', 'email', 'sync', 'ai')),
  external_ref jsonb,
  corrects_id uuid,
  search tsvector generated always as (to_tsvector('english', coalesce(body, ''))) stored,
  created_at timestamptz not null default now()
);
create index ix_acct_work_notes_ticket on acct.work_notes (ticket_id, created_at);
create index ix_acct_work_notes_search on acct.work_notes using gin (search);
select sys.apply_account_isolation('acct.work_notes', false);

-- ---------------------------------------------------------------------------
-- Attachments with scan state (rows now; presign and scanning in P1.6.1)
-- ---------------------------------------------------------------------------
create table acct.attachments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ticket_id uuid not null references acct.tickets (id) on delete cascade,
  comment_id uuid references acct.comments (id) on delete set null,
  work_note_id uuid references acct.work_notes (id) on delete set null,
  file_name text not null,
  content_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  s3_key text not null,
  scan_state text not null default 'pending' check (scan_state in ('pending', 'clean', 'quarantined')),
  scan_detail jsonb,
  origin text not null check (origin in ('internal', 'portal', 'email', 'sync')),
  visibility text not null check (visibility in ('public', 'internal')),
  uploaded_by text not null,
  uploaded_by_name text not null default '',
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index ix_acct_attachments_ticket on acct.attachments (ticket_id, created_at);
select sys.apply_account_isolation('acct.attachments', true);
-- The portal policy above bounds to the account; the public projection view
-- below is the only place the portal reads attachments, and it filters on
-- visibility and scan state.

-- ---------------------------------------------------------------------------
-- Links, saved views, watchers, notifications
-- ---------------------------------------------------------------------------
create table acct.ticket_links (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  from_ticket_id uuid not null references acct.tickets (id) on delete cascade,
  to_ticket_id uuid not null references acct.tickets (id) on delete cascade,
  type text not null check (type in ('parent', 'related', 'duplicate', 'blocks')),
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint ck_ticket_links_distinct check (from_ticket_id <> to_ticket_id)
);
create unique index ux_acct_ticket_links on acct.ticket_links (from_ticket_id, to_ticket_id, type);
create index ix_acct_ticket_links_to on acct.ticket_links (to_ticket_id);
select sys.apply_account_isolation('acct.ticket_links', false);

create table acct.saved_views (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  owner_id text not null,
  name text not null,
  definition jsonb not null,
  share text not null default 'private' check (share in ('private', 'group', 'account')),
  share_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1
);
create index ix_acct_saved_views_owner on acct.saved_views (owner_id) where deleted_at is null;
create trigger trg_acct_saved_views_updated before update on acct.saved_views for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.saved_views', false);

create table acct.watchers (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ticket_id uuid not null references acct.tickets (id) on delete cascade,
  user_id text not null,
  source text not null check (source in ('creator', 'assignee', 'commenter', 'explicit', 'requester')),
  muted_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index ux_acct_watchers on acct.watchers (ticket_id, user_id);
create index ix_acct_watchers_user on acct.watchers (user_id);
select sys.apply_account_isolation('acct.watchers', false);

create table acct.notifications (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  recipient_id text not null,
  type text not null,
  title text not null,
  body text not null default '',
  target_kind text not null,
  target_id text not null,
  link text,
  collapse_key text,
  count integer not null default 1,
  read_at timestamptz,
  delivered_email_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ix_acct_notifications_recipient on acct.notifications (recipient_id, updated_at desc);
create unique index ux_acct_notifications_collapse on acct.notifications (recipient_id, collapse_key) where read_at is null and collapse_key is not null;
create trigger trg_acct_notifications_updated before update on acct.notifications for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.notifications', true);

-- ---------------------------------------------------------------------------
-- Portal read of state changes: column-limited select on the audit stream
-- with a policy restricted to ticket transitions, so the public timeline
-- view (SECURITY INVOKER) can include them without exposing anything else.
-- ---------------------------------------------------------------------------
grant select (id, account_id, ticket_id, entity_kind, entity_id, event_type, field, old_value, new_value, actor_name, created_at)
  on acct.audit_events to xms_portal;
create policy acct_isolation_portal on acct.audit_events to xms_portal
  using (account_id = sys.account_id() and event_type = 'ticket.transition');

create view acct.ticket_timeline_public with (security_invoker = true) as
  select c.account_id, c.ticket_id, 'comment'::text as kind, c.id as item_id, c.author_name as actor_name,
         c.body as body, null::text as file_name, null::text as from_state, null::text as to_state, c.created_at
    from acct.comments c
  union all
  select a.account_id, a.ticket_id, 'attachment', a.id, a.uploaded_by_name, null, a.file_name, null, null, a.created_at
    from acct.attachments a
   where a.visibility = 'public' and a.scan_state = 'clean' and a.deleted_at is null
  union all
  select e.account_id, e.ticket_id, 'state_change', e.id, e.actor_name, null, null,
         e.old_value #>> '{}', e.new_value #>> '{}', e.created_at
    from acct.audit_events e
   where e.event_type = 'ticket.transition' and e.field = 'state';
grant select on acct.ticket_timeline_public to xms_portal, xms_app, xms_worker;
