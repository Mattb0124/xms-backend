-- 0030 The outbound half of the ServiceNow connector (ServiceNow Sync
-- technical 3.5; functional 5.5, 5.7; SN-03 to SN-05). One row per XMS
-- change that has to reach one instance: the queue the dispatcher fills
-- from `sys.outbox` and the deliver job drains, with the attempts, the
-- backoff and the conflict outcome the run log and the ticket Sync card
-- read back.
--
-- Why a table per instance rather than the shared outbox: one XMS change
-- fans out to every bidirectional instance the ticket is linked to, each
-- with its own attempts, its own kill switch and its own maps, and the
-- queue survives a trip so a comment written while an instance is paused
-- is sent when the switch is re-armed (functional 5.7).

create table acct.sync_outbound (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  instance_id uuid not null references acct.connector_instances (id),
  ticket_id uuid not null references acct.tickets (id),
  link_id uuid not null references acct.sync_links (id),
  event text not null check (event in ('ticket.updated', 'ticket.transitioned', 'comment.created', 'work_note.created')),
  -- The `sys.outbox` row this came from: the deduplication key for a
  -- redelivered dispatch, and the id the run row carries.
  outbox_id bigint,
  payload jsonb not null default '{}'::jsonb,
  -- The origin of the XMS change. `sync:<instance>` for this instance never
  -- reaches this table (the loop guard); another instance's origin does.
  origin text not null default 'user',
  correlation_id text,
  -- `skipped` is the conflict-policy outcome: the change was translated and
  -- then dropped because the instance owns the field (the outbound mirror
  -- of the `skipped_policy` run outcome).
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'dead_lettered', 'skipped')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  -- `{policy, kept, dropped, external_sys_updated_on}` when the case moved
  -- on the ServiceNow side after our last known update.
  conflict jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index ux_acct_sync_outbound_outbox on acct.sync_outbound (instance_id, outbox_id)
  where outbox_id is not null;
create index ix_acct_sync_outbound_pending on acct.sync_outbound (instance_id, next_attempt_at, id)
  where status = 'pending';
create index ix_acct_sync_outbound_ticket on acct.sync_outbound (ticket_id, created_at desc);
create index ix_acct_sync_outbound_instance on acct.sync_outbound (instance_id, created_at desc);
create trigger trg_acct_sync_outbound_updated before update on acct.sync_outbound
  for each row execute function sys.set_updated_at();
-- The API administers the queue (the outbound list and the retry action) and
-- the worker fills and drains it, both on the schema's default privileges;
-- the portal role is revoked here as on every other account table.
select sys.apply_account_isolation('acct.sync_outbound', false);
