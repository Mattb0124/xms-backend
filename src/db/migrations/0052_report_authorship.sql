-- 0052 The pack is from somebody (TM-23: ownership drives report authorship).
--
-- A report run already records two people: `requested_by`, who asked for it,
-- and the `reviewer_id`/`reviewed_at` pair, who approved it and when. Neither
-- answers the question the client asks, which is who this report is from.
-- In practice that is the account owner: the CSM whose name the weekly pack
-- goes out over and who talks the client through it.
--
-- This is a third column rather than a reuse of `reviewer_id`, because
-- filling that at creation would claim a review that has not happened and
-- would make `requester_cannot_approve` and the approval audit read wrong.
-- Who it is from, who asked for it and who signed it off are three
-- questions, and conflating any two of them loses a fact.
--
-- Backfill from the account owner: existing runs were all authored by
-- whoever owns the account today, which is the best answer available and a
-- truer one than null.

alter table acct.report_runs
  add column author_user_id text;

update acct.report_runs r
   set author_user_id = a.owner_user_id::text
  from op.accounts a
 where a.id = r.account_id and a.owner_user_id is not null;

create index ix_acct_report_runs_author on acct.report_runs (author_user_id) where author_user_id is not null;

comment on column acct.report_runs.author_user_id is
  'Who the pack is from: the account owner at the time the run was created (TM-23). Not the reviewer, and not the requester.';
