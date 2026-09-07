-- 0023 CSAT (Client Portal functional 5.7, technical 2.3; CP-07 cut to the
-- ticket-close survey): one survey per closed ticket and requester with a
-- one-time link token, reminders and expiry, an append-only response, and
-- the suppression reasons the functional specification names.

create table acct.csat_surveys (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  kind text not null check (kind in ('ticket_close', 'quarterly')),
  ticket_id uuid references acct.tickets (id) on delete cascade,
  period text,
  contact_id uuid not null references acct.contacts (id),
  token_hash text not null,
  status text not null default 'sent' check (status in ('sent', 'reminded', 'answered', 'expired', 'suppressed')),
  sent_at timestamptz not null default now(),
  remind_at timestamptz,
  expires_at timestamptz,
  answered_at timestamptz,
  suppression_reason text check (suppression_reason is null or suppression_reason in ('cancelled', 'duplicate', 'too_fast', 'daily_cap')),
  created_at timestamptz not null default now(),
  constraint ck_acct_csat_surveys_subject check ((kind = 'ticket_close' and ticket_id is not null) or (kind = 'quarterly' and period is not null))
);
create index ix_acct_csat_surveys_due on acct.csat_surveys (status, remind_at) where status in ('sent', 'reminded');
create unique index ux_acct_csat_ticket_contact on acct.csat_surveys (ticket_id, contact_id) where kind = 'ticket_close';
create unique index ux_acct_csat_quarter_contact on acct.csat_surveys (period, contact_id) where kind = 'quarterly';
create index ix_acct_csat_surveys_contact on acct.csat_surveys (contact_id, status);
select sys.apply_account_isolation('acct.csat_surveys', true);
grant select, insert, update on acct.csat_surveys to xms_worker;

create table acct.csat_responses (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  survey_id uuid not null references acct.csat_surveys (id) on delete cascade,
  answers jsonb not null,
  comment text,
  anonymous boolean not null default false,
  created_at timestamptz not null default now(),
  constraint ux_acct_csat_responses_survey unique (survey_id)
);
create trigger trg_acct_csat_responses_append_only before update or delete on acct.csat_responses
  for each row execute function sys.raise_append_only();
select sys.apply_account_isolation('acct.csat_responses', false);
grant select on acct.csat_responses to xms_worker;

-- The survey link carries no session: the API finds the account to bind from the survey id alone.
create or replace function sys.csat_survey_account(p_survey uuid) returns uuid
language sql security definer stable as $$
  select account_id from acct.csat_surveys where id = p_survey
$$;
revoke all on function sys.csat_survey_account(uuid) from public;
grant execute on function sys.csat_survey_account(uuid) to xms_app;
