-- 0035 The narrative editor on a held run (Dashboards & Report Packs
-- functional 5.8; AI functionality 117: Axel writes the narrative from the
-- frozen numbers, and where AI is off the templated narrative is used and
-- the screen says so). The review screen shows the narrative in an
-- editable panel with "Regenerate with my edits", "Approve and send" and
-- "Send without changes", and the pack could record only where the
-- narrative came from, not that a person had rewritten it.
--
-- `acct.report_packs.narrative_source` was a two-value vocabulary,
-- `axel` or `template`. `edited` joins it: a reviewer's rewrite is neither
-- of the two, and losing that distinction would mean the run read could
-- not tell the screen whose words are about to reach a client. The AI
-- half is still unbuilt (`wsr_narrative` has no capability builder), so
-- nothing writes `axel` yet and the column carries `template` or `edited`
-- in practice.
--
-- Nothing else changes shape: the versions themselves already live in
-- `narrative_versions`, an append-only jsonb array, and an edit is one
-- more entry on it rather than a new table.

alter table acct.report_packs drop constraint report_packs_narrative_source_check;
alter table acct.report_packs add constraint report_packs_narrative_source_check
  check (narrative_source in ('axel', 'template', 'edited'));
