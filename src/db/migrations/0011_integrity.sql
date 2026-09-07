-- 0011 Tamper evidence (Audit & Analytics section 6; P1.7.6 cut to the
-- digest chain and its verification; the Parquet export and Athena wait for
-- the AWS environment). One digest row per stream per day, chained to the
-- previous day's digest; verifications are recorded so the Security
-- dashboard can show the last digest and the last verification.

create table sys.event_digests (
  id uuid primary key default gen_random_uuid(),
  stream text not null check (stream in ('audit', 'security', 'usage')),
  day date not null,
  row_count integer not null,
  digest text not null,
  previous_digest text,
  object_key text,
  created_at timestamptz not null default now(),
  unique (stream, day)
);
create trigger trg_sys_event_digests_append_only before update or delete on sys.event_digests
  for each row execute function sys.raise_append_only();
grant select on sys.event_digests to xms_app;
grant select, insert on sys.event_digests to xms_worker;
revoke all on sys.event_digests from xms_portal;

create table sys.digest_verifications (
  id uuid primary key default gen_random_uuid(),
  stream text not null check (stream in ('audit', 'security', 'usage')),
  day date not null,
  expected text not null,
  actual text not null,
  matched boolean not null,
  verified_by text not null,
  verified_at timestamptz not null default now()
);
create index ix_sys_digest_verifications_day on sys.digest_verifications (stream, day, verified_at desc);
create trigger trg_sys_digest_verifications_append_only before update or delete on sys.digest_verifications
  for each row execute function sys.raise_append_only();
grant select, insert on sys.digest_verifications to xms_app, xms_worker;
revoke all on sys.digest_verifications from xms_portal;
