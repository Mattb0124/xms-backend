-- 0053 The close discipline as a configurable catalog (TB-02).
--
-- The resolution gate had two halves that accepted anything. A ticket could
-- reach Resolved with nothing logged against it by putting a full stop in
-- `time_exemption_reason`, because that column is free text and the rule only
-- asked whether it was blank. And `resolution_notes` only had to be
-- non-empty, so "Fixed" was a complete resolution record as far as the server
-- was concerned. Neither is what TB-02 asks for under revision 3, and the
-- first one means the gate did not exist: any consultant in a hurry passed it
-- without noticing it was there.
--
-- Both now come from a catalog, so the vocabulary and the bar are an
-- account's decision rather than a constant in the code, and changing them is
-- an audited configuration change like every other catalog (CG-02 in spirit,
-- long before that module exists). Time & Budget 5.2 names the five reasons
-- the default carries.
--
-- This migration only widens the two kind vocabularies, the same way 0010 did
-- for `ai`; the catalog rows themselves are seeded by `ensureDefaults` from
-- `src/config/seeds/close-discipline.json`, which is where every other
-- catalog's first version comes from too.
--
-- The override constraint is widened with the default one so the two tables
-- keep identical vocabularies, and here an account genuinely does override:
-- narrowing the exemption list is the point.

alter table op.config_defaults drop constraint config_defaults_kind_check;
alter table op.config_defaults add constraint config_defaults_kind_check
  check (kind in ('state_machine', 'priority_matrix', 'sla_policy', 'activity_types', 'billable_classes', 'resolution_codes', 'ai', 'close_discipline'));
alter table acct.config_overrides drop constraint config_overrides_kind_check;
alter table acct.config_overrides add constraint config_overrides_kind_check
  check (kind in ('state_machine', 'priority_matrix', 'sla_policy', 'activity_types', 'billable_classes', 'resolution_codes', 'ai', 'close_discipline'));
