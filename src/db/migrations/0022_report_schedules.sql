-- 0022 Report schedules and distribution (Dashboards & Report Packs
-- technical 2.3, functional 5.7; DR-05): one or more schedules per account
-- saying when a pack is generated, for which period, and to whom it goes.
-- Runs keep their delivery outcome per recipient in report_runs.delivery.

create table acct.report_schedules (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  name text not null,
  pack_type text not null default 'wsr' check (pack_type in ('wsr', 'qbr', 'custom')),
  cadence text not null check (cadence in ('weekly', 'monthly', 'quarterly')),
  run_day smallint not null check (run_day between 1 and 31),
  run_time time not null default '06:00',
  period_kind text not null check (period_kind in ('previous_week', 'previous_month', 'previous_quarter')),
  formats text[] not null default '{pptx}',
  template_id uuid references op.report_templates (id),
  distribution jsonb not null default '[]'::jsonb,
  review_required boolean not null default false,
  review_grace_hours smallint not null default 24,
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_run_id uuid,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ix_acct_report_schedules_due on acct.report_schedules (next_run_at) where enabled;
create index ix_acct_report_schedules_account on acct.report_schedules (account_id);
create trigger trg_acct_report_schedules_updated before update on acct.report_schedules for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.report_schedules', false);
grant select, insert, update, delete on acct.report_schedules to xms_app;
grant select, update on acct.report_schedules to xms_worker;
