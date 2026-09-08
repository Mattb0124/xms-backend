-- 0034 Review before send (Dashboards & Report Packs functional 5.8,
-- technical 2.3 and 4; DR-05). A schedule with `review_required` already
-- existed on `acct.report_schedules` and nothing read it: every run
-- delivered the moment it rendered. Holding a run needs two facts the run
-- did not carry.
--
-- `review_due_at` is the instant the grace period ends, frozen on the run
-- when it is held rather than recomputed from the schedule, so editing the
-- schedule's grace hours never moves a deadline a reviewer was already
-- told about, and the worker sweep is a plain indexed comparison.
--
-- `review_note` is the reason a reviewer gave for cancelling. A cancelled
-- run takes the existing `skipped` status; the status vocabulary is closed
-- and already carries every state this flow moves through
-- (`ready_for_review`, `awaiting_review`, `approved`, `sending`, `sent`,
-- `skipped`), so nothing here widens the check.

alter table acct.report_runs
  add column review_due_at timestamptz,
  add column review_note text;

-- The deadline sweep asks one question: which held runs are past their
-- grace period. The partial index is the whole working set.
create index ix_acct_report_runs_review_due on acct.report_runs (review_due_at)
  where status = 'ready_for_review' and review_due_at is not null;
