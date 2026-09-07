-- 0006 Time and consumption (Time, Contracts & Budget technical section 2,
-- cut per Thirty-Day Build section 5: entries with the activity taxonomy and
-- billable classes, adjustments as new rows, non-ticket buckets, billing
-- periods with the lock trigger, one contract period per contract).

create table acct.contract_periods (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  contract_id uuid not null references acct.contracts (id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  contracted_minutes integer not null default 0 check (contracted_minutes >= 0),
  carried_over_minutes integer not null default 0 check (carried_over_minutes >= 0),
  locked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint ck_contract_periods_order check (ends_on >= starts_on),
  constraint ex_contract_periods_overlap exclude using gist (contract_id with =, daterange(starts_on, ends_on, '[]') with &&)
);
create index ix_acct_contract_periods_contract on acct.contract_periods (contract_id, starts_on);
create trigger trg_acct_contract_periods_updated before update on acct.contract_periods for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.contract_periods', false);

create table acct.non_ticket_buckets (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  key text not null,
  label text not null,
  billable_class text not null,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_acct_non_ticket_buckets_key on acct.non_ticket_buckets (account_id, key);
create trigger trg_acct_non_ticket_buckets_updated before update on acct.non_ticket_buckets for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.non_ticket_buckets', false);

create table acct.billing_periods (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'open' check (status in ('open', 'submitted', 'approved', 'locked', 'exported')),
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint ck_billing_periods_order check (ends_on >= starts_on),
  constraint ex_billing_periods_overlap exclude using gist (account_id with =, daterange(starts_on, ends_on, '[]') with &&)
);
create trigger trg_acct_billing_periods_updated before update on acct.billing_periods for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.billing_periods', false);

-- Immutable work record (Domain Model 3.5, invariant 3).
create table acct.time_entries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ticket_id uuid references acct.tickets (id) on delete restrict,
  bucket_id uuid references acct.non_ticket_buckets (id) on delete restrict,
  contract_id uuid not null references acct.contracts (id) on delete restrict,
  person_id text not null,
  person_name text not null default '',
  performed_on date not null,
  minutes integer not null check (minutes > 0 and minutes <= 1440),
  activity_type text not null,
  billable_class text not null,
  description text not null default '',
  after_hours boolean not null default false,
  source text not null default 'manual' check (source in ('manual', 'timer', 'import', 'ai_nudge')),
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint ck_time_entries_target check ((ticket_id is null) <> (bucket_id is null))
);
create index ix_acct_time_entries_ticket on acct.time_entries (ticket_id, performed_on);
create index ix_acct_time_entries_person on acct.time_entries (person_id, performed_on);
create index ix_acct_time_entries_account_date on acct.time_entries (account_id, performed_on);
create index ix_acct_time_entries_contract on acct.time_entries (contract_id, performed_on);
create trigger trg_acct_time_entries_append_only before update or delete on acct.time_entries
  for each row execute function sys.raise_append_only();
select sys.apply_account_isolation('acct.time_entries', false);

-- Corrections and write-offs: a new row that references the original; the
-- signed delta keeps the original untouched.
create table acct.time_adjustments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  entry_id uuid not null references acct.time_entries (id) on delete restrict,
  contract_id uuid not null references acct.contracts (id) on delete restrict,
  performed_on date not null,
  delta_minutes integer not null check (delta_minutes <> 0),
  kind text not null check (kind in ('correction', 'write_off', 'reclass')),
  new_billable_class text,
  reason text not null,
  created_by text not null,
  created_by_name text not null default '',
  created_at timestamptz not null default now()
);
create index ix_acct_time_adjustments_entry on acct.time_adjustments (entry_id);
create index ix_acct_time_adjustments_contract on acct.time_adjustments (contract_id, performed_on);
create trigger trg_acct_time_adjustments_append_only before update or delete on acct.time_adjustments
  for each row execute function sys.raise_append_only();
select sys.apply_account_isolation('acct.time_adjustments', false);

-- A locked billing period rejects writes dated inside it (invariant 7),
-- at the database level so no code path can bypass it.
create or replace function acct.reject_locked_period() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from acct.billing_periods p
     where p.account_id = new.account_id and p.status in ('locked', 'exported')
       and new.performed_on between p.starts_on and p.ends_on
  ) then
    raise exception 'billing period containing % is locked', new.performed_on using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger trg_acct_time_entries_locked before insert on acct.time_entries
  for each row execute function acct.reject_locked_period();
create trigger trg_acct_time_adjustments_locked before insert on acct.time_adjustments
  for each row execute function acct.reject_locked_period();

-- Backfill one period per existing active contract from its dates.
insert into acct.contract_periods (account_id, contract_id, starts_on, ends_on, contracted_minutes)
select c.account_id, c.id, coalesce(c.period_starts_on, date_trunc('month', current_date)::date),
       coalesce(c.period_ends_on, (date_trunc('month', current_date) + interval '1 month - 1 day')::date),
       coalesce(round(c.period_hours * 60), 0)::int
  from acct.contracts c
 where c.status = 'active';
