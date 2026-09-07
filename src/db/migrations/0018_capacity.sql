-- 0018 Capacity (Capacity & Allocation technical sections 2.4, 2.5, 2.7;
-- CAP-02 to CAP-06): PTO per person, planned allocations per person,
-- account and month, and the two read models the capacity view and the
-- planned-versus-actual report read. Operator-only; the portal never sees
-- any of it. The read models are rebuilt inline on every read of a month
-- (pilot scale) and keep their computed_at.

create table op.pto (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references op.people (id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  kind text not null check (kind in ('vacation', 'sick', 'other')),
  fraction numeric(3,2) not null default 1 check (fraction > 0 and fraction <= 1),
  note text not null default '',
  entered_by text not null,
  created_at timestamptz not null default now(),
  constraint ck_op_pto_order check (ends_on >= starts_on)
);
create index ix_op_pto_person_dates on op.pto (person_id, starts_on, ends_on);

create table op.allocations (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references op.people (id) on delete cascade,
  account_id uuid not null references op.accounts (id),
  period_month date not null check (extract(day from period_month) = 1),
  planned_minutes integer not null check (planned_minutes >= 0),
  note text,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint uq_op_allocations unique (person_id, account_id, period_month)
);
create index ix_op_allocations_account_month on op.allocations (account_id, period_month);
create trigger trg_op_allocations_updated before update on op.allocations for each row execute function sys.set_updated_at();

create table rpt.capacity_periods (
  person_id uuid not null references op.people (id) on delete cascade,
  period_month date not null check (extract(day from period_month) = 1),
  working_days integer not null default 0,
  contracted_minutes integer not null default 0,
  pto_minutes integer not null default 0,
  holiday_minutes integer not null default 0,
  overhead_minutes integer not null default 0,
  available_minutes integer not null default 0,
  allocated_minutes integer not null default 0,
  actual_minutes integer not null default 0,
  status text not null check (status in ('available', 'warning', 'over', 'no_calendar')),
  computed_at timestamptz not null default now(),
  primary key (person_id, period_month)
);

create table rpt.capacity_actuals (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references op.people (id) on delete cascade,
  account_id uuid not null references op.accounts (id),
  period_month date not null check (extract(day from period_month) = 1),
  planned_minutes integer not null default 0,
  actual_minutes integer not null default 0,
  variance_minutes integer not null default 0,
  computed_at timestamptz not null default now(),
  constraint uq_rpt_capacity_actuals unique (person_id, account_id, period_month)
);
select sys.apply_account_isolation('rpt.capacity_actuals', false);

grant select, insert, update, delete on op.pto, op.allocations, rpt.capacity_periods, rpt.capacity_actuals to xms_app;
grant select, insert, update, delete on rpt.capacity_periods, rpt.capacity_actuals to xms_worker;
grant select on op.pto, op.allocations to xms_worker;
revoke all on op.pto, op.allocations, rpt.capacity_periods, rpt.capacity_actuals from xms_portal;
