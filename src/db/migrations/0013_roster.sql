-- 0013 Roster (Capacity & Allocation technical 2.1 to 2.3; P2.12.1 cut to
-- the day-30 scope: people, working calendars, skills and certifications;
-- no rates, PTO, allocations or demand yet). Operator tables: no account
-- content, nothing for the portal. Cost and bill rates arrive with the
-- finance column grants in Month 3, so no rate column exists to leak.

create table op.people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references op.users (id),
  display_name text not null,
  email citext not null unique,
  role text not null check (role ~ '^[a-z][a-z0-9_]{1,39}$'),
  fte_percent numeric(5,2) not null default 100 check (fte_percent >= 0 and fte_percent <= 100),
  hours_base_per_week numeric(5,2) not null default 40 check (hours_base_per_week > 0 and hours_base_per_week <= 80),
  admin_overhead_percent numeric(5,2) check (admin_overhead_percent is null or (admin_overhead_percent >= 0 and admin_overhead_percent <= 100)),
  currency char(3) not null default 'USD',
  country char(2),
  time_zone text not null default 'UTC',
  holiday_calendar_id uuid references op.holiday_calendars (id),
  assignment_group_ids uuid[] not null default '{}'::uuid[],
  start_date date,
  end_date date,
  is_active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint people_dates check (end_date is null or start_date is null or end_date >= start_date)
);
create index ix_op_people_active on op.people (is_active, display_name);
create index ix_op_people_role on op.people (role);
create trigger trg_op_people_updated before update on op.people for each row execute function sys.set_updated_at();

create table op.person_calendars (
  person_id uuid primary key references op.people (id) on delete cascade,
  working_days integer[] not null default '{1,2,3,4,5}'::integer[],
  day_start time not null default '09:00',
  day_end time not null default '17:00',
  hours_per_day numeric(4,2) not null default 8 check (hours_per_day > 0 and hours_per_day <= 24),
  updated_at timestamptz not null default now(),
  constraint person_calendars_days check (day_end > day_start)
);

create table op.skills (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('technology', 'account', 'process')),
  code text not null unique check (code ~ '^[a-z0-9][a-z0-9_.-]{0,59}$'),
  name text not null,
  account_id uuid references op.accounts (id),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table op.person_skills (
  person_id uuid not null references op.people (id) on delete cascade,
  skill_id uuid not null references op.skills (id),
  level integer not null check (level between 1 and 4),
  assessed_on date not null default current_date,
  assessed_by text not null,
  primary key (person_id, skill_id)
);
create index ix_op_person_skills_skill on op.person_skills (skill_id, level desc);

create table op.certifications (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references op.people (id) on delete cascade,
  name text not null,
  issuer text,
  obtained_on date not null,
  expires_on date,
  expiry_notified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint certifications_dates check (expires_on is null or expires_on >= obtained_on)
);
create index ix_op_certifications_person on op.certifications (person_id, expires_on);

grant select, insert, update, delete on op.people, op.person_calendars, op.skills, op.person_skills, op.certifications to xms_app;
grant select on op.people, op.person_calendars, op.skills, op.person_skills, op.certifications to xms_worker;
revoke all on op.people, op.person_calendars, op.skills, op.person_skills, op.certifications from xms_portal;
