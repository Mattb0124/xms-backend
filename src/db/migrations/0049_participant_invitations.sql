-- 0049 Asking somebody onto a ticket without handing it to them.
--
-- TM-22. The day-in-the-life analysis found people transferring a ticket to
-- ask a colleague a question and never getting it back: the only way to
-- involve somebody was to make them the assignee. An invitation is the way
-- out. Somebody is asked, they accept or decline, and the assignee is
-- unchanged throughout.
--
-- TM-21 left the 'invited' and 'declined' states in the check constraint for
-- exactly this, so the states are already here. What this migration adds is
-- everything an invitation needs that a direct add did not: who it was
-- addressed to when that is a group rather than a person, when the answer
-- came, and what the answer was.
--
-- A group invitation carries no user until it is accepted. "The OneStream
-- group was asked" is a true statement on its own, and inventing a member to
-- hang it on would make the record say something nobody did. The person who
-- accepts is written into the same row, so the record reads "accepted for
-- the OneStream group by Cara" rather than losing who was asked.
--
-- 'withdrawn' joins the states because the three ways an invitation can end
-- are different facts and deserve different words: the invitee said no
-- (declined), the inviter took it back (withdrawn), or somebody who was
-- actually on the ticket stepped off it (left). Collapsing them would make
-- "who turned us down?" unanswerable.

alter table acct.ticket_participants
  alter column user_id drop not null,
  add column group_id uuid references op.assignment_groups (id),
  add column group_name text not null default '',
  add column responded_at timestamptz,
  add column responded_by text,
  add column responded_by_name text not null default '',
  add column decline_reason text;

alter table acct.ticket_participants
  drop constraint ticket_participants_status_check,
  add constraint ticket_participants_status_check
    check (status in ('invited', 'active', 'declined', 'withdrawn', 'left'));

-- An invitation is addressed to somebody: a person, a group, or a group that
-- somebody has since accepted for.
alter table acct.ticket_participants
  add constraint ck_participant_addressed check (user_id is not null or group_id is not null),
  -- A group cannot do the work. Being active means a person accepted.
  add constraint ck_participant_active_is_a_person check (status <> 'active' or user_id is not null),
  -- Only an answer stamps an answer.
  add constraint ck_participant_responded check (responded_at is null or status in ('active', 'declined')),
  -- A reason belongs to a decline.
  add constraint ck_participant_decline_reason check (decline_reason is null or status = 'declined');

-- One live part per person per ticket, now that user_id can be absent.
drop index acct.ux_acct_ticket_participants_live;
create unique index ux_acct_ticket_participants_live
  on acct.ticket_participants (ticket_id, user_id)
  where user_id is not null and status in ('invited', 'active');

-- One open invitation per group per ticket, so asking twice while the first
-- ask is unanswered is refused rather than doubled.
create unique index ux_acct_ticket_participants_group_open
  on acct.ticket_participants (ticket_id, group_id)
  where group_id is not null and status = 'invited';

comment on column acct.ticket_participants.responded_by is 'Who answered the invitation, which for a group is the member who spoke for it.';
comment on column acct.ticket_participants.group_id is 'The group the invitation was addressed to (TM-22); the accepter is written into user_id.';
comment on column acct.ticket_participants.status is 'invited, then active, declined or withdrawn; left is somebody stepping off work they were doing.';
