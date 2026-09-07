-- 0021 Event archive (Audit & Analytics section 5, XA-04 cold storage,
-- P1.7.6 remainder): one append-only row per stream and day naming the
-- archive file the nightly job wrote to the object store, its row count,
-- size and checksum. Partition detachment after export waits for the AWS
-- environment; the rows and files are what a detach would rely on.

create table sys.event_archives (
  id uuid primary key default gen_random_uuid(),
  stream text not null check (stream in ('audit', 'security', 'usage')),
  day date not null,
  object_key text not null,
  row_count integer not null check (row_count >= 0),
  byte_count integer not null check (byte_count >= 0),
  checksum text not null,
  digest_id uuid references sys.event_digests (id),
  created_at timestamptz not null default now(),
  unique (stream, day)
);
create trigger trg_sys_event_archives_append_only before update or delete on sys.event_archives
  for each row execute function sys.raise_append_only();
grant select on sys.event_archives to xms_app;
grant select, insert on sys.event_archives to xms_worker;
