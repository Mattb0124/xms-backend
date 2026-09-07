-- 0008 Email intake and outbound (Email Intake & Outbound technical section
-- 2; P1.6.3, P1.6.4, P2.18.1 cut) and the ticket email token used by the
-- thread matcher. Attachments rows already exist (0004); this adds the
-- quarantine link. The portal role has no grant on any table here.

-- Plus-address token per ticket (thread matcher precedence 1).
alter table acct.tickets add column email_token text;
create unique index ux_acct_tickets_email_token on acct.tickets (email_token) where email_token is not null;

create table acct.inbound_aliases (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  address citext not null,
  kind text not null default 'alias' check (kind in ('canonical', 'alias')),
  default_ticket_type text check (default_ticket_type in ('incident', 'service_request', 'change', 'problem', 'project_task')),
  state text not null default 'active' check (state in ('active', 'disabled_by_admin', 'disabled_by_loop_guard')),
  verification_token text,
  verified_at timestamptz,
  disabled_reason text,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_acct_inbound_aliases_address on acct.inbound_aliases (address);
create index ix_acct_inbound_aliases_account_state on acct.inbound_aliases (account_id, state);
create trigger trg_acct_inbound_aliases_updated before update on acct.inbound_aliases for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.inbound_aliases', false);

-- An alias must resolve to an account before any account row is written; the
-- worker resolves it through this operator-scoped lookup function (SECURITY
-- DEFINER, returns only the account id) because the worker has no binding yet.
create or replace function sys.account_for_alias(p_address text) returns uuid
language sql stable security definer set search_path = pg_catalog, acct, sys as $$
  select a.account_id from acct.inbound_aliases a where a.address = p_address and a.state = 'active' limit 1
$$;
revoke all on function sys.account_for_alias(text) from public;
grant execute on function sys.account_for_alias(text) to xms_worker, xms_app;

create table acct.sender_identities (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  address citext not null,
  display_name text not null default '',
  domain_kind text not null default 'xms' check (domain_kind in ('xms', 'client')),
  dkim_status text not null default 'pending' check (dkim_status in ('pending', 'verified', 'failed')),
  dkim_tokens text[] not null default '{}',
  is_default boolean not null default false,
  branding jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_acct_sender_identities_address on acct.sender_identities (account_id, address);
create unique index ux_acct_sender_identities_default on acct.sender_identities (account_id) where is_default;
create trigger trg_acct_sender_identities_updated before update on acct.sender_identities for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.sender_identities', false);

create table acct.inbound_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  alias_id uuid not null references acct.inbound_aliases (id),
  raw_s3_key text not null,
  message_id text not null,
  in_reply_to text,
  "references" text[] not null default '{}',
  plus_token text,
  from_address citext not null,
  from_name text not null default '',
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  subject text not null default '',
  received_at timestamptz not null,
  sender_resolution text not null check (sender_resolution in ('known_contact', 'known_internal', 'portal_user', 'unknown')),
  contact_id uuid references acct.contacts (id),
  user_id text,
  loop_score integer not null default 0,
  loop_signals text[] not null default '{}',
  disposition text not null check (disposition in ('created', 'appended', 'quarantined', 'suppressed', 'rejected')),
  suppression_reason text,
  matched_by text check (matched_by in ('plus_token', 'in_reply_to', 'references', 'subject_key')),
  ticket_id uuid references acct.tickets (id) on delete set null,
  comment_id uuid references acct.comments (id) on delete set null,
  stripped_body_text text not null default '',
  attachment_count integer not null default 0,
  size_bytes integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index ux_acct_inbound_messages_message_id on acct.inbound_messages (account_id, message_id);
create index ix_acct_inbound_messages_ticket on acct.inbound_messages (ticket_id) where ticket_id is not null;
create index ix_acct_inbound_messages_sender_window on acct.inbound_messages (account_id, from_address, received_at desc);
create index ix_acct_inbound_messages_subject_burst on acct.inbound_messages (account_id, alias_id, subject, received_at desc);
create trigger trg_acct_inbound_messages_append_only before update or delete on acct.inbound_messages
  for each row execute function sys.raise_append_only();
select sys.apply_account_isolation('acct.inbound_messages', false);

create table acct.outbound_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ticket_id uuid references acct.tickets (id) on delete set null,
  kind text not null check (kind in ('acknowledgement', 'public_comment', 'resolved', 'closed', 'quarantine_digest', 'report_pack', 'notification', 'test')),
  template_version text not null,
  message_id text not null,
  in_reply_to text,
  "references" text[] not null default '{}',
  from_identity_id uuid references acct.sender_identities (id),
  from_address text not null,
  to_addresses text[] not null,
  cc_addresses text[] not null default '{}',
  subject text not null,
  rendered_s3_key text not null,
  outbox_id bigint,
  created_at timestamptz not null default now()
);
create unique index ux_acct_outbound_messages_message_id on acct.outbound_messages (message_id);
create unique index ux_acct_outbound_messages_outbox on acct.outbound_messages (outbox_id) where outbox_id is not null;
create index ix_acct_outbound_messages_ticket on acct.outbound_messages (ticket_id, created_at desc) where ticket_id is not null;
create trigger trg_acct_outbound_messages_append_only before update or delete on acct.outbound_messages
  for each row execute function sys.raise_append_only();
select sys.apply_account_isolation('acct.outbound_messages', false);

create table acct.outbound_deliveries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  outbound_message_id uuid not null references acct.outbound_messages (id) on delete cascade,
  provider_message_id text,
  state text not null default 'queued' check (state in ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed')),
  state_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb,
  version integer not null default 1
);
create unique index ux_acct_outbound_deliveries_message on acct.outbound_deliveries (outbound_message_id);
create index ix_acct_outbound_deliveries_provider on acct.outbound_deliveries (provider_message_id) where provider_message_id is not null;
create index ix_acct_outbound_deliveries_state on acct.outbound_deliveries (account_id, state) where state in ('queued', 'bounced', 'complained', 'failed');
select sys.apply_account_isolation('acct.outbound_deliveries', false);

create table acct.suppressed_addresses (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  address citext not null,
  reason text not null check (reason in ('bounce_hard', 'complaint', 'manual')),
  source_delivery_id uuid references acct.outbound_deliveries (id) on delete set null,
  created_at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_by text
);
create index ix_acct_suppressed_addresses_live on acct.suppressed_addresses (account_id, address) where cleared_at is null;
select sys.apply_account_isolation('acct.suppressed_addresses', false);

create table acct.quarantine_items (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  inbound_message_id uuid not null references acct.inbound_messages (id),
  reason text not null check (reason in ('unknown_sender', 'suspicious_content', 'scan_quarantined', 'unsupported_content')),
  state text not null default 'open' check (state in ('open', 'decided', 'expired')),
  decision text check (decision in ('create_contact_and_ticket', 'create_ticket_once', 'discard', 'mark_spam')),
  decided_by text,
  decided_at timestamptz,
  resulting_ticket_id uuid references acct.tickets (id) on delete set null,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_acct_quarantine_open on acct.quarantine_items (inbound_message_id) where state = 'open';
create index ix_acct_quarantine_account_open on acct.quarantine_items (account_id, created_at) where state = 'open';
select sys.apply_account_isolation('acct.quarantine_items', false);
