-- 0040 Per-account request forms (CP-03; Client Portal functional 5.4 step 3
-- and technical 2.2 and 2.6). Until now the portal request form was one
-- fixed set of fields for every account and every type. The spec asks for a
-- form the operator authors per account and per ticket type, versioned, with
-- a draft the author edits and a published version the client is served.
--
-- Two tables, exactly as technical 2.2 words them. `acct.ticket_forms` is the
-- card the client picks (a name, a description, whether the type is offered
-- at all); `acct.ticket_form_versions` holds the field list. A version with
-- `published_at` set is frozen: the definition it carries is the contract a
-- request in flight was submitted against, so it is never edited again, and
-- the trigger below refuses the update rather than trusting the service.
--
-- One published form per account and type is the pair of
-- `ux_acct_ticket_forms_active` (one active form per account and type) and
-- `current_version_id` (the one version that form serves). A form change
-- applies to new requests only: the ticket keeps the `form_version_id` it
-- was created with.

create table acct.ticket_forms (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ticket_type text not null check (ticket_type in ('incident', 'service_request', 'change')),
  name text not null check (char_length(name) between 1 and 160),
  description text not null default '',
  -- Set by publishing; the foreign key is added after the versions table
  -- exists, because the two tables point at each other.
  current_version_id uuid,
  is_active boolean not null default true,
  -- An account may author a form and not offer it to clients yet.
  client_visible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_acct_ticket_forms_active on acct.ticket_forms (account_id, ticket_type) where is_active;
create trigger trg_acct_ticket_forms_updated before update on acct.ticket_forms
  for each row execute function sys.set_updated_at();

create table acct.ticket_form_versions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  form_id uuid not null references acct.ticket_forms (id) on delete cascade,
  version_no integer not null check (version_no >= 1),
  -- { "fields": [ { key, kind, label, help, required, options, visible_when, maps_to } ] }
  -- validated by src/domain/portal/form-schema.ts on every save and again on
  -- every submission, so what the builder wrote and what the server enforces
  -- cannot disagree.
  definition jsonb not null default '{"fields": []}'::jsonb,
  published_at timestamptz,
  published_by text,
  created_at timestamptz not null default now(),
  constraint ck_acct_form_versions_definition check (jsonb_typeof(definition -> 'fields') = 'array'),
  constraint ck_acct_form_versions_published check ((published_at is null) = (published_by is null))
);
create unique index ux_acct_form_versions_no on acct.ticket_form_versions (form_id, version_no);
create index ix_acct_form_versions_published on acct.ticket_form_versions (form_id, published_at desc)
  where published_at is not null;

alter table acct.ticket_forms
  add constraint fk_acct_ticket_forms_current_version foreign key (current_version_id)
    references acct.ticket_form_versions (id) on delete set null;

-- Append-only once published (technical 2.2). A draft is edited freely; the
-- publish itself is the update that sets `published_at` on a row whose
-- `published_at` is still null, so the trigger lets it through and refuses
-- everything after it.
create or replace function acct.raise_form_version_frozen() returns trigger
language plpgsql as $$
begin
  raise exception 'ticket_form_versions: a published version is frozen' using errcode = '23514';
end $$;
create trigger trg_acct_form_versions_frozen before update or delete on acct.ticket_form_versions
  for each row when (old.published_at is not null) execute function acct.raise_form_version_frozen();

-- Isolation. The operator block is the standard one; the portal policies are
-- narrower than the installer's, exactly as technical 2.6 writes them: the
-- portal sees an active, client-visible form and a published version, and
-- nothing else, on the one account its session is bound to.
alter table acct.ticket_forms enable row level security;
alter table acct.ticket_forms force row level security;
create policy acct_isolation_operator on acct.ticket_forms to xms_app, xms_worker
  using (account_id = any (sys.account_ids()))
  with check (account_id = any (sys.account_ids()));
create policy acct_isolation_portal on acct.ticket_forms for select to xms_portal
  using (account_id = sys.account_id() and is_active and client_visible);
grant select (id, account_id, ticket_type, name, description, current_version_id, is_active, client_visible, created_at, updated_at, version)
  on acct.ticket_forms to xms_portal;

alter table acct.ticket_form_versions enable row level security;
alter table acct.ticket_form_versions force row level security;
create policy acct_isolation_operator on acct.ticket_form_versions to xms_app, xms_worker
  using (account_id = any (sys.account_ids()))
  with check (account_id = any (sys.account_ids()));
create policy acct_isolation_portal on acct.ticket_form_versions for select to xms_portal
  using (account_id = sys.account_id() and published_at is not null);
grant select (id, account_id, form_id, version_no, definition, published_at, created_at)
  on acct.ticket_form_versions to xms_portal;

-- The ticket's half of the contribution (technical 2.2): which version the
-- request was submitted against, and the answers that did not map onto a
-- ticket column. Both are null and empty for every ticket created any other
-- way, so nothing already stored changes meaning.
alter table acct.tickets
  add column form_version_id uuid references acct.ticket_form_versions (id) on delete set null,
  add column form_data jsonb not null default '{}'::jsonb;
create index ix_acct_tickets_form_version on acct.tickets (form_version_id) where form_version_id is not null;
