-- 0048 Who had a part in this ticket, besides the person it is assigned to.
--
-- TM-21. A ticket has one assignee and, in practice, several people who
-- worked on it: somebody who was asked a question, somebody who reviewed the
-- change, somebody watching because it touches their account. Today only the
-- assignee is on the record, so "who worked this?" cannot be answered and a
-- contributor count cannot be taken.
--
-- This is deliberately not `acct.watchers`. A watcher is a notification
-- subscription: it answers "who gets told". A participant answers "who had a
-- part", which is a different question with different consequences, and
-- folding them together would mean muting your notifications looked like
-- walking away from the work. The two overlap and stay separate.
--
-- The row carries its own history: joined_at, left_at, and who invited them.
-- Somebody who leaves and is asked back gets a second row rather than an
-- edited one, so the record reads as what happened.

create table acct.ticket_participants (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ticket_id uuid not null references acct.tickets (id) on delete cascade,
  -- The same shape a time entry names a person by, so the two can be joined.
  user_id text not null,
  display_name text not null default '',
  role text not null check (role in ('collaborator', 'reviewer', 'observer')),
  -- 'invited' and 'declined' are TM-22's states; TM-21 only ever writes
  -- 'active' and 'left'. They live here from the start so the invitation
  -- flow adds a path rather than a column.
  status text not null default 'active' check (status in ('invited', 'active', 'declined', 'left')),
  invited_by text,
  invited_by_name text not null default '',
  joined_at timestamptz,
  left_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  -- Left means left: a row cannot be gone and still open.
  constraint ck_participant_left check ((status = 'left') = (left_at is not null))
);

-- One live part per person per ticket. Somebody who left and came back has
-- two rows, which is the history the requirement asks for.
create unique index ux_acct_ticket_participants_live
  on acct.ticket_participants (ticket_id, user_id)
  where status in ('invited', 'active');

create index ix_acct_ticket_participants_ticket on acct.ticket_participants (ticket_id, created_at);
create index ix_acct_ticket_participants_user on acct.ticket_participants (user_id) where status = 'active';

create trigger trg_acct_ticket_participants_updated before update on acct.ticket_participants
  for each row execute function sys.set_updated_at();

select sys.apply_account_isolation('acct.ticket_participants', false);

comment on table acct.ticket_participants is 'Who had a part in a ticket besides the assignee, with when they joined and left (TM-21).';
comment on column acct.ticket_participants.status is 'invited and declined belong to the invitation flow (TM-22).';
