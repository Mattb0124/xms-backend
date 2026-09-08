-- 0025 Finance delivery (Integrations technical 2.4, functional 5.2; INT-02
-- cut): one destination per account for the locked billing export, and one
-- delivery row per attempt to hand a period's file over, superseded when the
-- period is delivered again. The HTTPS secret is sealed like a webhook secret.

create table acct.finance_destinations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  kind text not null check (kind in ('https', 'object_store')),
  endpoint_url text,
  object_prefix text,
  secret_ciphertext text,
  secret_kid text,
  format text not null default 'csv' check (format in ('csv', 'xlsx')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint ux_acct_finance_destinations_account unique (account_id),
  constraint ck_acct_finance_destinations_target check (
    (kind = 'https' and endpoint_url is not null) or (kind = 'object_store' and object_prefix is not null)
  )
);
create trigger trg_acct_finance_destinations_updated before update on acct.finance_destinations
  for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.finance_destinations', false);
grant select on acct.finance_destinations to xms_worker;

create table acct.finance_deliveries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  billing_period_id uuid not null references acct.billing_periods (id) on delete cascade,
  billing_export_id uuid not null references acct.billing_exports (id) on delete cascade,
  destination_kind text not null check (destination_kind in ('https', 'object_store')),
  manifest_key text,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'acknowledged', 'failed', 'superseded')),
  supersedes_id uuid references acct.finance_deliveries (id),
  response_status integer,
  ack_received_at timestamptz,
  ack_reference text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_acct_finance_deliveries_export on acct.finance_deliveries (billing_export_id) where status <> 'superseded';
create index ix_acct_finance_deliveries_period on acct.finance_deliveries (billing_period_id, created_at desc);
create trigger trg_acct_finance_deliveries_updated before update on acct.finance_deliveries
  for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.finance_deliveries', false);
grant select, insert, update on acct.finance_deliveries to xms_worker;
grant select, insert on acct.billing_exports to xms_worker;
