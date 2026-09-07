-- 0016 Budget rules (Time, Contracts & Budget technical sections 2.2, 2.3,
-- 2.4, 2.7; TB-07 to TB-09, TB-11 overage): the contract carries its
-- rollover, overage and threshold rules, periods remember which thresholds
-- fired, rate cards are versioned and never edited, the rate and amount are
-- frozen on the entry, and every threshold crossing is an append-only event.

alter table acct.contracts
  add column threshold_percents integer[] not null default '{50,75,90,100}',
  add column threshold_notify_client boolean not null default false,
  add column overage_rule text not null default 'allow_flag'
    check (overage_rule in ('block', 'allow_flag', 'allow_rate')),
  add column overage_multiplier numeric(5,3)
    check (overage_multiplier is null or overage_multiplier >= 1),
  add column rollover_rule text not null default 'none'
    check (rollover_rule in ('none', 'carry_month', 'carry_term', 'cap')),
  add column rollover_cap_hours numeric(8,2)
    check (rollover_cap_hours is null or rollover_cap_hours >= 0),
  add column forecast_window_days integer not null default 10
    check (forecast_window_days between 1 and 90);

alter table acct.contract_periods
  add column thresholds_fired integer[] not null default '{}';

alter table acct.time_entries
  add column rate_snapshot numeric(10,2) check (rate_snapshot is null or rate_snapshot >= 0),
  add column amount numeric(14,2),
  add column over_budget boolean not null default false;

-- Rate cards: a version per (account, contract or account default, effective date); entries per role.
create table acct.rate_cards (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  contract_id uuid references acct.contracts (id) on delete cascade,
  effective_from date not null,
  currency char(3) not null default 'USD',
  note text not null default '',
  created_by text not null,
  created_at timestamptz not null default now()
);
create unique index ux_acct_rate_cards_version
  on acct.rate_cards (account_id, coalesce(contract_id, '00000000-0000-0000-0000-000000000000'::uuid), effective_from);
create index ix_acct_rate_cards_lookup on acct.rate_cards (account_id, contract_id, effective_from desc);
select sys.apply_account_isolation('acct.rate_cards', false);

create table acct.rate_card_entries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  rate_card_id uuid not null references acct.rate_cards (id) on delete cascade,
  role text not null,
  bill_rate numeric(10,2) not null check (bill_rate >= 0),
  overage_rate numeric(10,2) check (overage_rate is null or overage_rate >= 0),
  constraint ux_acct_rate_card_entries_role unique (rate_card_id, role)
);
select sys.apply_account_isolation('acct.rate_card_entries', false);

-- Threshold crossings: one append-only row per period and percent.
create table acct.threshold_alert_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  contract_id uuid not null references acct.contracts (id) on delete cascade,
  contract_period_id uuid not null references acct.contract_periods (id) on delete cascade,
  percent integer not null check (percent between 1 and 1000),
  consumed_minutes_at_fire integer not null check (consumed_minutes_at_fire >= 0),
  available_minutes integer not null check (available_minutes >= 0),
  notified_count integer not null default 0,
  fired_at timestamptz not null default now(),
  constraint ux_acct_threshold_alert_events_once unique (contract_period_id, percent)
);
create index ix_acct_threshold_alert_events_contract on acct.threshold_alert_events (contract_id, fired_at desc);
create trigger trg_acct_threshold_alert_events_append_only before update or delete on acct.threshold_alert_events
  for each row execute function sys.raise_append_only();
select sys.apply_account_isolation('acct.threshold_alert_events', false);
