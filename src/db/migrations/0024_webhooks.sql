-- 0024 Outbound webhooks (Integrations technical 2.3; INT-05 cut): an API
-- client subscribes an HTTPS endpoint per account to public event types;
-- every delivery attempt is an append-only row. The signing secret is kept
-- encrypted with the application key (the signature needs the plaintext),
-- never in clear and never returned after creation.

create table acct.webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  api_client_id uuid not null references op.api_clients (id) on delete cascade,
  endpoint_url text not null,
  event_types text[] not null,
  secret_ciphertext text not null,
  secret_kid text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'deleted')),
  paused_reason text check (paused_reason is null or paused_reason in ('continuous_failure', 'owner', 'client_revoked')),
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_acct_webhook_subscriptions_endpoint
  on acct.webhook_subscriptions (api_client_id, account_id, endpoint_url) where status <> 'deleted';
create index ix_acct_webhook_subscriptions_account on acct.webhook_subscriptions (account_id) where status = 'active';
create trigger trg_acct_webhook_subscriptions_updated before update on acct.webhook_subscriptions
  for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.webhook_subscriptions', false);
grant select, update on acct.webhook_subscriptions to xms_worker;

create table acct.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  subscription_id uuid not null references acct.webhook_subscriptions (id) on delete cascade,
  outbox_id text not null,
  event_type text not null,
  attempt integer not null check (attempt between 1 and 5),
  status text not null check (status in ('pending', 'delivered', 'retrying', 'dead_lettered', 'replayed')),
  response_status integer,
  duration_ms integer,
  error text,
  next_attempt_at timestamptz,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  constraint ux_acct_webhook_deliveries_attempt unique (subscription_id, outbox_id, attempt)
);
create index ix_acct_webhook_deliveries_sub on acct.webhook_deliveries (subscription_id, created_at desc);
create index ix_acct_webhook_deliveries_retry on acct.webhook_deliveries (next_attempt_at) where status = 'retrying';
select sys.apply_account_isolation('acct.webhook_deliveries', false);
grant select, insert, update on acct.webhook_deliveries to xms_worker;
