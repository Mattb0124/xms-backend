-- 0007 Solution knowledge base (Solution Knowledge Base technical section
-- 2; P2.14.1 to P2.14.4). Articles are account-scoped by visibility, not by
-- origin (Domain Model section 1): a global article lives under the
-- reserved GLOBAL operator account row and is readable by every internal
-- principal and, when published, by every portal account.

-- The reserved operator account for global knowledge.
alter table op.accounts drop constraint accounts_status_check;
alter table op.accounts add constraint accounts_status_check
  check (status in ('onboarding', 'active', 'suspended', 'offboarding', 'offboarded', 'system'));
insert into op.accounts (id, key, name, status, default_time_zone)
values ('00000000-0000-4000-8000-000000000001', 'GLOBAL', 'Global knowledge', 'system', 'UTC')
on conflict (key) do nothing;

-- array_to_string is stable, not immutable; the wrapper is safe for a text[] of plain words.
create or replace function sys.join_words(words text[]) returns text
language sql immutable parallel safe as $$ select array_to_string(words, ' ') $$;

create sequence acct.article_key_seq start 100001;

create table acct.solution_articles (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  display_key text not null default ('KB' || lpad(nextval('acct.article_key_seq')::text, 6, '0')),
  kind text not null default 'solution' check (kind in ('solution', 'workaround', 'known_error', 'procedure', 'reference')),
  status text not null default 'draft' check (status in ('draft', 'in_review', 'published', 'retired')),
  is_global boolean not null default false,
  title text not null check (char_length(title) between 1 and 200),
  categories text[] not null default '{}',
  self_service text not null default 'none' check (self_service in ('none', 'follow', 'request', 'auto')),
  effort_band text check (effort_band in ('lt_15m', 'lt_1h', 'lt_4h', 'gt_4h')),
  owner_user_id text not null,
  owner_name text not null default '',
  reviewer_user_id text,
  reviewer_name text,
  published_version_id uuid,
  last_verified_at timestamptz,
  retired_at timestamptz,
  retired_reason text,
  source_ticket_id uuid references acct.tickets (id) on delete set null,
  generalised_from_id uuid references acct.solution_articles (id) on delete set null,
  -- Problem statement and symptoms of the published version, copied at
  -- publish so the generated search vector can include them.
  search_text text not null default '',
  search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(sys.join_words(categories), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(search_text, '')), 'C')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_acct_solution_articles_key on acct.solution_articles (display_key);
create index ix_acct_solution_articles_search on acct.solution_articles using gin (search_vector);
create index ix_acct_solution_articles_published on acct.solution_articles (account_id, status) where status = 'published';
create index ix_acct_solution_articles_key_trgm on acct.solution_articles using gin (display_key gin_trgm_ops);
create trigger trg_acct_solution_articles_updated before update on acct.solution_articles for each row execute function sys.set_updated_at();
create constraint trigger trg_acct_solution_articles_require_audit after update on acct.solution_articles
  deferrable initially deferred for each row execute function sys.require_audit();

create table acct.article_versions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  article_id uuid not null references acct.solution_articles (id) on delete cascade,
  version_no integer not null check (version_no > 0),
  problem_statement text not null default '',
  environment text not null default '',
  symptoms text not null default '',
  cause text not null default '',
  steps text not null default '',
  verification text not null default '',
  rollback text not null default '',
  client_notes text not null default '',
  ci_snapshot jsonb not null default '[]'::jsonb,
  authored_by text not null,
  authored_name text not null default '',
  published_at timestamptz,
  ai_suggestion_id uuid,
  created_at timestamptz not null default now()
);
create unique index ux_acct_article_versions_no on acct.article_versions (article_id, version_no);
alter table acct.solution_articles add constraint fk_solution_articles_published_version
  foreign key (published_version_id) references acct.article_versions (id) deferrable initially deferred;
-- A published version is frozen; the draft may be replaced by the service.
create trigger trg_acct_article_versions_published_frozen before update or delete on acct.article_versions
  for each row when (old.published_at is not null) execute function sys.raise_append_only();

create table acct.article_visibility (
  article_id uuid not null references acct.solution_articles (id) on delete cascade,
  account_id uuid not null references op.accounts (id),
  visible_account_id uuid not null references op.accounts (id),
  granted_by text not null,
  granted_at timestamptz not null default now(),
  primary key (article_id, visible_account_id)
);
-- The isolation suite and the fixture builder key on `id`; expose one.
alter table acct.article_visibility add column id uuid not null default gen_random_uuid();
create unique index ux_acct_article_visibility_id on acct.article_visibility (id);

create table acct.ticket_solutions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ticket_id uuid not null references acct.tickets (id) on delete restrict,
  article_id uuid not null references acct.solution_articles (id) on delete restrict,
  article_version_id uuid not null references acct.article_versions (id) on delete restrict,
  outcome text not null check (outcome in ('resolved_by', 'partially_resolved_by', 'created_from')),
  actor_kind text not null check (actor_kind in ('user', 'portal_user', 'api_client', 'system', 'ai')),
  actor_id text not null,
  actor_name text not null default '',
  created_at timestamptz not null default now()
);
create index ix_acct_ticket_solutions_ticket on acct.ticket_solutions (ticket_id);
create index ix_acct_ticket_solutions_article on acct.ticket_solutions (article_id, created_at);
create trigger trg_acct_ticket_solutions_append_only before update or delete on acct.ticket_solutions
  for each row execute function sys.raise_append_only();

create table acct.article_feedback (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  article_id uuid not null references acct.solution_articles (id) on delete cascade,
  article_version_id uuid references acct.article_versions (id) on delete set null,
  verdict text not null check (verdict in ('useful', 'not_useful', 'out_of_date', 'solved_it')),
  comment text,
  principal_kind text not null check (principal_kind in ('internal', 'portal')),
  actor_id text not null,
  actor_name text not null default '',
  context text not null check (context in ('ticket_rail', 'portal_search', 'portal_kb', 'article_record')),
  context_ref text,
  created_at timestamptz not null default now()
);
create index ix_acct_article_feedback_article on acct.article_feedback (article_id, created_at);
create trigger trg_acct_article_feedback_append_only before update or delete on acct.article_feedback
  for each row execute function sys.raise_append_only();

create table acct.configuration_items (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ci_type text not null check (ci_type in ('environment', 'application', 'module', 'integration', 'server', 'report', 'other')),
  name text not null check (char_length(name) between 1 and 120),
  attributes jsonb not null default '{}'::jsonb,
  owner_contact_id uuid references acct.contacts (id) on delete set null,
  external_ref text,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_acct_configuration_items_name on acct.configuration_items (account_id, ci_type, lower(name));
create trigger trg_acct_configuration_items_updated before update on acct.configuration_items for each row execute function sys.set_updated_at();

create table acct.ci_links (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ci_id uuid not null references acct.configuration_items (id) on delete cascade,
  target_kind text not null check (target_kind in ('ticket', 'article')),
  target_id uuid not null,
  created_at timestamptz not null default now()
);
create unique index ux_acct_ci_links on acct.ci_links (ci_id, target_kind, target_id);

create table acct.ticket_templates (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  ticket_type text not null check (ticket_type in ('incident', 'service_request', 'change', 'problem', 'project_task')),
  category text,
  title_pattern text not null default '',
  description_checklist text not null default '',
  assignment_group_id text,
  article_id uuid references acct.solution_articles (id) on delete set null,
  ci_id uuid references acct.configuration_items (id) on delete set null,
  is_global boolean not null default false,
  client_visible boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create trigger trg_acct_ticket_templates_updated before update on acct.ticket_templates for each row execute function sys.set_updated_at();

-- ---------------------------------------------------------------------------
-- Visibility function and policies
-- ---------------------------------------------------------------------------
-- An article is readable when it is global, owned by a bound account, or
-- explicitly shared with a bound account. SECURITY DEFINER so the visibility
-- table is consulted without a grant on the owner account; the portal role
-- binds xms.account_id only, so both variables are read.
create or replace function acct.article_visible(p_article_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, acct, sys as $$
  select exists (
    select 1 from acct.solution_articles a
     where a.id = p_article_id
       and (a.is_global
            or a.account_id = any (sys.account_ids())
            or a.account_id = sys.account_id()
            or exists (select 1 from acct.article_visibility v
                        where v.article_id = a.id
                          and (v.visible_account_id = any (sys.account_ids()) or v.visible_account_id = sys.account_id())))
  )
$$;
revoke all on function acct.article_visible(uuid) from public;
grant execute on function acct.article_visible(uuid) to xms_app, xms_worker, xms_portal;

-- solution_articles: standard operator block plus the visibility read policy;
-- portal reads published visible articles only.
alter table acct.solution_articles enable row level security;
alter table acct.solution_articles force row level security;
create policy acct_isolation_operator on acct.solution_articles to xms_app, xms_worker
  using (account_id = any (sys.account_ids()))
  with check (account_id = any (sys.account_ids()));
create policy article_read_visible on acct.solution_articles for select to xms_app, xms_worker
  using (acct.article_visible(id));
create policy acct_isolation_portal on acct.solution_articles for select to xms_portal
  using (status = 'published' and acct.article_visible(id));
grant select (id, account_id, display_key, kind, status, is_global, title, categories, self_service, effort_band, published_version_id, last_verified_at, created_at, updated_at, search_vector)
  on acct.solution_articles to xms_portal;

alter table acct.article_versions enable row level security;
alter table acct.article_versions force row level security;
create policy acct_isolation_operator on acct.article_versions to xms_app, xms_worker
  using (account_id = any (sys.account_ids()))
  with check (account_id = any (sys.account_ids()));
create policy version_read_visible on acct.article_versions for select to xms_app, xms_worker
  using (acct.article_visible(article_id));
create policy acct_isolation_portal on acct.article_versions for select to xms_portal
  using (published_at is not null and acct.article_visible(article_id));
grant select (id, account_id, article_id, version_no, client_notes, published_at) on acct.article_versions to xms_portal;

select sys.apply_account_isolation('acct.article_visibility', false);
select sys.apply_account_isolation('acct.ticket_solutions', false);
-- Feedback: the portal may insert its own rows (solved it, useful) and read nothing back.
alter table acct.article_feedback enable row level security;
alter table acct.article_feedback force row level security;
create policy acct_isolation_operator on acct.article_feedback to xms_app, xms_worker
  using (account_id = any (sys.account_ids()))
  with check (account_id = any (sys.account_ids()));
create policy acct_isolation_portal on acct.article_feedback for insert to xms_portal
  with check (account_id = sys.account_id() and principal_kind = 'portal');
grant insert on acct.article_feedback to xms_portal;
select sys.apply_account_isolation('acct.configuration_items', true);
select sys.apply_account_isolation('acct.ci_links', false);
select sys.apply_account_isolation('acct.ticket_templates', false);
