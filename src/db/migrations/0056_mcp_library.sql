-- 0056 The MCP library as a configuration kind.
--
-- A managed-services desk works several clients' estates and they do not run
-- the same systems: one has OneStream, the next has SAP. Axel should reach the
-- systems of the account whose ticket is open and nothing else, so the operator
-- keeps a library of MCP connections and turns them on account by account.
--
-- This is a ninth kind rather than a registry of its own. `op.config_defaults`
-- already gives a JSON-seeded operator catalog with versions and activation,
-- `acct.config_overrides` already gives the per-account narrowing, and both
-- already carry the audit trail, the routes under `admin:config` and the
-- Configuration tab that shows a default beside an account's override. A second
-- registry would be a second place to look and a second thing to keep in step,
-- which is the argument 0053 made for the close discipline and it holds here.
--
-- Like 0053 and 0010 before it, this migration only widens the two kind
-- vocabularies; the catalog's first version is seeded by `ensureDefaults` from
-- `src/config/seeds/mcp.json`, where every other catalog's first version comes
-- from. The override constraint is widened with the default one so the two
-- tables keep identical vocabularies, and here an account genuinely does
-- override: choosing which connections it gets is the whole point.
--
-- The body holds no secret. A connection names where its credential lives
-- (`secret_ref`, a Secrets Manager entry) or leaves a `${VAR}` placeholder;
-- `validateMcpLibrary` refuses a literal in a credential-shaped field, because
-- a configuration body is versioned and diffed into the audit trail, so a token
-- written here would be a token in the audit trail.

alter table op.config_defaults drop constraint config_defaults_kind_check;
alter table op.config_defaults add constraint config_defaults_kind_check
  check (kind in ('state_machine', 'priority_matrix', 'sla_policy', 'activity_types', 'billable_classes', 'resolution_codes', 'ai', 'close_discipline', 'mcp'));

alter table acct.config_overrides drop constraint config_overrides_kind_check;
alter table acct.config_overrides add constraint config_overrides_kind_check
  check (kind in ('state_machine', 'priority_matrix', 'sla_policy', 'activity_types', 'billable_classes', 'resolution_codes', 'ai', 'close_discipline', 'mcp'));
