-- 0054 A resolved project task says what it delivered (Matt, 2026-09-12).
--
-- Five ticket types, five resolving transitions, and they did not ask for the
-- same things. Incident, service request and problem all required a
-- resolution, a solution link and logged time; a change required a resolution
-- and logged time; a project task required logged time and nothing else. So a
-- project task reached Done with no resolution code and no resolution notes,
-- nothing said what had been delivered, and the row was invisible to every
-- report that groups by resolution code.
--
-- TB-02 (migration 0053) made the gate real for the other four types and left
-- this one as the way round it. This closes that.
--
-- `solution_link` is deliberately not added. A delivered project task is
-- planned work, not a problem solved, and demanding a knowledge article for
-- every one of them would fill the corpus with things nobody will ever search
-- for. The change machine makes the same choice for the same reason.
--
-- The catalog gains a code to go with it. Every existing resolution code is
-- incident-shaped (fixed, workaround, no fault found, vendor fix), and
-- requiring a code from a list with no right answer on it is worse than not
-- requiring one: people pick "fixed" for delivered work and the reports lie
-- in a new way.
--
-- `delivered` is deliberately NOT marked no-solution. There is one resolution
-- code catalog shared by every ticket type, and a no-solution code waives the
-- solution-link requirement wherever it is chosen, so marking it would have
-- handed incidents, service requests and problems a generic escape from the
-- article requirement that migration 0053 had just tightened. Project tasks
-- and changes do not ask for a solution link in the first place, so they lose
-- nothing by the code being an ordinary one.
--
-- Both updates follow migration 0038: the seed carries the shape for new
-- databases, and this carries it to the ones already stored, defaults and
-- account overrides alike. Overrides are included because no account
-- deliberately chose a gate-free project task; they inherited the shape the
-- seed gave them. An account that genuinely wants it back edits its own
-- machine afterwards, which is what an override is for.
--
-- Every statement is idempotent: the guards mean a re-run, or a database
-- seeded after this ships, changes nothing.

-- ---------------------------------------------------------------------------
-- The project task machine asks for a resolution
-- ---------------------------------------------------------------------------

update op.config_defaults
   set body = jsonb_set(
     body,
     '{transitions}',
     (select jsonb_agg(
        case when transition->>'from' = 'in_progress' and transition->>'to' = 'done'
             then jsonb_set(transition, '{requires}',
                    coalesce(transition->'requires', '[]'::jsonb) || '["resolution"]'::jsonb)
             else transition
        end)
      from jsonb_array_elements(body->'transitions') as transition)
   )
 where kind = 'state_machine' and scope_key = 'project_task'
   -- Only where the transition exists and does not already ask for it.
   -- Appending rather than replacing matters: an account that added its own
   -- requirement to this transition keeps it, where a wholesale set would
   -- have deleted it in the name of making the gate stricter.
   and body->'transitions' @> '[{"from": "in_progress", "to": "done"}]'::jsonb
   and not body->'transitions' @> '[{"from": "in_progress", "to": "done", "requires": ["resolution"]}]'::jsonb;

update acct.config_overrides
   set body = jsonb_set(
     body,
     '{transitions}',
     (select jsonb_agg(
        case when transition->>'from' = 'in_progress' and transition->>'to' = 'done'
             then jsonb_set(transition, '{requires}',
                    coalesce(transition->'requires', '[]'::jsonb) || '["resolution"]'::jsonb)
             else transition
        end)
      from jsonb_array_elements(body->'transitions') as transition)
   )
 where kind = 'state_machine' and scope_key = 'project_task'
   and body->'transitions' @> '[{"from": "in_progress", "to": "done"}]'::jsonb
   and not body->'transitions' @> '[{"from": "in_progress", "to": "done", "requires": ["resolution"]}]'::jsonb;

-- ---------------------------------------------------------------------------
-- A code for work that was delivered rather than fixed
-- ---------------------------------------------------------------------------

update op.config_defaults
   set body = jsonb_set(
     body,
     '{items}',
     (body->'items') || '[{"key": "delivered", "label": "Delivered as specified", "no_solution": false}]'::jsonb
   )
 where kind = 'resolution_codes'
   and not body->'items' @> '[{"key": "delivered"}]'::jsonb;

update acct.config_overrides
   set body = jsonb_set(
     body,
     '{items}',
     (body->'items') || '[{"key": "delivered", "label": "Delivered as specified", "no_solution": false}]'::jsonb
   )
 where kind = 'resolution_codes'
   and not body->'items' @> '[{"key": "delivered"}]'::jsonb;
