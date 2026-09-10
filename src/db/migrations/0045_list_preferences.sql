-- 0045 What a reader wants a list to look like.
--
-- ServiceNow lets a person choose the columns of a list and their order, and
-- keeps that choice for them: two consultants on the same queue read it
-- differently because they do different work. XMS carries the same idea.
--
-- Operator scope, keyed on the person, so it holds across accounts and
-- machines. It is a preference, not data: losing the row costs the reader
-- their arrangement and nothing else, which is why the screen's own default
-- is the fallback rather than an error.

create table op.list_preferences (
  user_id uuid not null references op.users (id) on delete cascade,
  -- The screen the arrangement belongs to ("cases", "roster"), so one reader
  -- may order the Cases list one way and the roster another.
  screen text not null check (char_length(screen) between 1 and 64),
  -- The columns drawn, in the order they are drawn. An unknown key is
  -- ignored on read rather than refused, so a column that leaves the product
  -- does not strand the reader who had chosen it.
  columns jsonb not null default '[]'::jsonb,
  -- The display switches beside the column lists in the same dialogue.
  options jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, screen)
);

create trigger trg_op_list_preferences_updated before update on op.list_preferences
  for each row execute function sys.set_updated_at();

comment on table op.list_preferences is 'Per reader, per screen: which columns a list draws, in what order, and how.';
comment on column op.list_preferences.columns is 'Ordered column keys; an unknown one is ignored on read.';
comment on column op.list_preferences.options is 'The dialogue switches: wrap, compact, highlight, and the rest.';
