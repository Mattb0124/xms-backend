-- 0017 Billing period lifecycle and the finance export (Time, Contracts &
-- Budget functional 5.7, technical 2.7; TB-14, INT-02): the period records
-- who submitted, approved and locked it, the summary produced at submit,
-- and the checksum of its export; every export file is an append-only row.

alter table acct.billing_periods
  add column submitted_at timestamptz,
  add column submitted_by text,
  add column approved_at timestamptz,
  add column approved_by text,
  add column auto_lock_at timestamptz,
  add column summary jsonb,
  add column checksum text;

create table acct.billing_exports (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  billing_period_id uuid not null references acct.billing_periods (id) on delete cascade,
  format text not null check (format in ('xlsx', 'csv')),
  template_version text not null default 'thg-finance-v1',
  object_key text not null,
  checksum text not null,
  row_count integer not null check (row_count >= 0),
  produced_by text not null,
  produced_at timestamptz not null default now(),
  delivered_at timestamptz,
  delivery_ref text
);
create index ix_acct_billing_exports_period on acct.billing_exports (billing_period_id, produced_at desc);
create trigger trg_acct_billing_exports_append_only before update or delete on acct.billing_exports
  for each row execute function sys.raise_append_only();
select sys.apply_account_isolation('acct.billing_exports', false);

-- An approved period refuses new entries dated inside it (functional 5.7:
-- "Approved: entries dated in the period are refused"); adjustments keep
-- the locked rule so a correction dated in the open period may still
-- reference an approved entry.
create or replace function acct.reject_closed_period() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from acct.billing_periods p
     where p.account_id = new.account_id and p.status in ('approved', 'locked', 'exported')
       and new.performed_on between p.starts_on and p.ends_on
  ) then
    raise exception 'billing period containing % is closed', new.performed_on using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists trg_acct_time_entries_locked on acct.time_entries;
create trigger trg_acct_time_entries_locked before insert on acct.time_entries
  for each row execute function acct.reject_closed_period();
