-- 0014 Data migration (Data Migration technical section 2; P2.22.1 cut to
-- the rehearsal loop: batches, per-record identity with a source hash,
-- reconciliation reports). Imported rows are ordinary domain rows written
-- through the services with origin `import`; these tables only remember
-- where each came from and how the numbers reconciled.

create table acct.import_batches (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  object_kind text not null check (object_kind in ('account', 'contact', 'user', 'case', 'comment', 'work_note', 'attachment', 'time_record', 'contract', 'contract_period_balance', 'people_map')),
  source_kind text not null check (source_kind in ('servicenow_table_api', 'servicenow_export_files', 'finance_workbook')),
  source_ref jsonb not null default '{}'::jsonb,
  source_range jsonb not null default '{}'::jsonb,
  map_versions jsonb not null default '{}'::jsonb,
  dry_run boolean not null default true,
  status text not null default 'draft' check (status in ('draft', 'extracting', 'extracted', 'mapping', 'mapped', 'loading', 'loaded', 'reconciling', 'reconciled', 'signed_off', 'failed', 'superseded')),
  counts jsonb not null default '{"extracted": 0, "loaded": 0, "updated": 0, "skipped": 0, "unmatched": 0, "errors": 0}'::jsonb,
  checkpoint jsonb,
  supersedes_batch_id uuid references acct.import_batches (id),
  lease_owner text,
  lease_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  run_by text,
  error text,
  log jsonb not null default '[]'::jsonb,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index ux_acct_import_batches_scope_active on acct.import_batches (account_id, object_kind, (source_range::text))
  where status not in ('superseded', 'failed', 'signed_off', 'reconciled', 'loaded', 'mapped');
create index ix_acct_import_batches_account on acct.import_batches (account_id, created_at desc);
create trigger trg_acct_import_batches_updated before update on acct.import_batches for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.import_batches', false);

create table acct.import_records (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  batch_id uuid not null references acct.import_batches (id),
  object_kind text not null,
  source_id text not null,
  source_key text,
  target_table text,
  target_id uuid,
  status text not null default 'pending' check (status in ('pending', 'loaded', 'updated', 'skipped', 'unmatched', 'error')),
  message text,
  source_payload_key text,
  source_hash text not null,
  source_timestamp timestamptz,
  created_at timestamptz not null default now()
);
create unique index ux_acct_import_records_batch_source on acct.import_records (batch_id, source_id);
create index ix_acct_import_records_batch_status on acct.import_records (batch_id, status);
create index ix_acct_import_records_identity on acct.import_records (account_id, object_kind, source_id, created_at desc);
create index ix_acct_import_records_target on acct.import_records (account_id, target_table, target_id);
create trigger trg_acct_import_records_append_only before update or delete on acct.import_records
  for each row execute function sys.raise_append_only();
select sys.apply_account_isolation('acct.import_records', false);

create table acct.reconciliation_reports (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  scope text not null check (scope in ('batch', 'account', 'delta')),
  batch_id uuid references acct.import_batches (id),
  status text not null default 'open' check (status in ('pending', 'open', 'signed_off')),
  snapshot_key text,
  signed_by text,
  signed_at timestamptz,
  lines jsonb not null default '[]'::jsonb,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ix_acct_reconciliation_reports_account on acct.reconciliation_reports (account_id, created_at desc);
create trigger trg_acct_reconciliation_reports_updated before update on acct.reconciliation_reports for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.reconciliation_reports', false);

-- Imported journal entries keep their origin visible.
alter table acct.comments drop constraint comments_source_check;
alter table acct.comments add constraint comments_source_check check (source in ('internal', 'portal', 'email', 'sync', 'ai', 'import'));
alter table acct.work_notes drop constraint work_notes_source_check;
alter table acct.work_notes add constraint work_notes_source_check check (source in ('internal', 'email', 'sync', 'ai', 'import'));
