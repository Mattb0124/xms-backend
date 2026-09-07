-- 0020 Forward demand (Capacity & Allocation technical 2.6, functional 5.7;
-- CAP-08): pipeline demand per prospect or account per month with hours and
-- a probability, project demand per account per month as committed hours,
-- entered or imported. Operator-only; the capacity view overlays the
-- weighted pipeline and the committed project hours per month.

create table op.pipeline_demand (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('pipeline', 'project', 'import')),
  account_id uuid references op.accounts (id),
  prospect_name text,
  period_month date not null check (extract(day from period_month) = 1),
  hours numeric(8,2) not null check (hours >= 0),
  probability numeric(3,2) not null default 1 check (probability > 0 and probability <= 1),
  role text check (role is null or role ~ '^[a-z][a-z0-9_]{1,39}$'),
  skill_id uuid references op.skills (id),
  note text not null default '',
  entered_by text not null,
  created_at timestamptz not null default now(),
  constraint ck_op_pipeline_demand_subject check (account_id is not null or prospect_name is not null)
);
create index ix_op_pipeline_demand_month on op.pipeline_demand (period_month);
create index ix_op_pipeline_demand_account on op.pipeline_demand (account_id, period_month);

grant select, insert, update, delete on op.pipeline_demand to xms_app;
grant select on op.pipeline_demand to xms_worker;
revoke all on op.pipeline_demand from xms_portal;
