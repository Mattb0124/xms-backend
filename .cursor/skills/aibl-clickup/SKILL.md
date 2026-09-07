---
name: aibl-clickup
description: >-
  Create and manage ClickUp tickets to the AIBL project structure: the
  "[Platform Module] - [Short Description]" naming convention, the functional
  description template (Context / Scope-User Story / Success Criteria /
  Additional Comments / Attachments), the 13-state Dev-vs-Bug status workflow
  with its ownership and handoff rules, Fibonacci sprint-point estimation, the
  required fields (Priority, Sprint Points, Next Release, Platform), and the
  sprint reporting KPIs. Use when creating a ClickUp task or bug, estimating
  sprint points, moving a ticket through statuses, setting up the ClickUp space
  (statuses / custom fields / dashboard), building sprint reports, or publishing
  and syncing local markdown specs into ClickUp Docs (the Specs folder) for AIBL.
  Works through the ClickUp MCP tools.
---

# AIBL ClickUp Ticket Structure

The single source of truth for how AIBL tickets are named, described, estimated,
and moved through their lifecycle. Follow it whenever you create or transition a
ClickUp ticket for AIBL so every ticket is self-explanatory and traceable.

## ClickUp MCP tools

The ClickUp tools are deferred. Load the ones you need first, e.g.
`ToolSearch("select:clickup_get_workspace_hierarchy,clickup_create_task,clickup_update_task,clickup_get_custom_fields")`,
or search by keyword (`ToolSearch("clickup create task")`). The core set:

- `clickup_get_workspace_hierarchy` - find the **X Platforms** space (this is where the AIBL project lives) / folder / list id **first**; never guess ids.
- `clickup_get_custom_fields` - read a list's custom fields (needed to set Next Release and Platform; note Sprint Points is not currently a field on the sprint list, see cached ids below).
- `clickup_create_task` / `clickup_update_task` - create a ticket, change its status/fields/assignee.
- `clickup_get_task` / `clickup_filter_tasks` - read one ticket or query a set (reporting, triage).
- `clickup_create_comment` / `clickup_get_task_comments` - the traceability trail (see rules below).
- `clickup_create_list` / `clickup_create_folder` / `clickup_create_dashboard` - one-time structure setup.
- `clickup_create_document` / `clickup_create_document_page` / `clickup_update_document_page` - publish and sync markdown docs (e.g. XMS specs) into ClickUp Docs (see **Docs** below).

Always resolve real ids through the hierarchy before writing. The AIBL work lives
in the ClickUp space named **X Platforms**; resolve that space, then its folder /
list. If the **X Platforms** space is not connected/visible, stop and tell the
user rather than writing to the wrong workspace.

## Resolved ids (cached 2026-07-20)

Use these to skip discovery. Treat the space/workspace/field ids as stable; still
`clickup_get_custom_fields` on the target list to confirm option ids before a
write, and re-resolve the current sprint list every time (it changes weekly).

- **Workspace (team) id:** `9015896416`
- **X Platforms space id:** `901511370980` (task `custom_id` prefix: `AIBL-`)
- **Sprint folder:** `X Platform Sprints` folder id `901516703258`. It holds the
  sprint lists (`Sprint N (M/D - M/D)`), one per week.
- **Current sprint list:** a list named `Sprint N (M/D - M/D)` inside the
  `X Platform Sprints` folder; pick the one whose date range contains today. Do
  **not** hardcode a sprint list id. Examples: `Sprint 1 (7/13 - 7/26)` =
  `901524338458`, `Sprint 2 (7/27 - 8/9)` = `901524755515`.
- **Bugs folder:** `Bugs` folder id `901516841378`, with one list per platform:
  `AIX` `901524516178`, `XT` `901524516182`, `XDA` `901524516186`.

**WHERE NEW TICKETS GO: read before creating anything.** Almost all work you
create is Development/Enhancement; those go in the **current sprint list** (under
`X Platform Sprints`). Only a reported defect is a **Bug**, and only bugs go in
the `Bugs` folder's platform list. NEVER create a dev/enhancement ticket in a
`Bugs` list. TRAP: `clickup_get_list(list_name="XT")` (or AIX/XDA) resolves to the
**Bugs/XT** list, not the sprint; do not use it for feature work. Always resolve
the current sprint list explicitly (by its `Sprint N (M/D - M/D)` name inside
folder `901516703258`), and if you are unsure which list is right, ask the user
rather than guessing.
- **Custom fields** (list-resolved, inherited across sprint lists):
  - `Platform` (drop_down) id `b8bfb2b8-6ab6-4af4-898f-f911baf10263`. Options:
    `AIX - OS` `832541e9-a24c-442a-8d1b-3c5ae7738308` · `AIX - EEA`
    `1f6458ec-e5e6-4959-8e3d-caef2d3eafd0` · `AIX - T2P`
    `79856f3a-63c2-46f0-9776-d900094772a1` · `AIX - Procurement`
    `907e3f7c-a337-46a1-9f50-fe1301198014` · `AIX - SAP`
    `87db734f-d28b-4ae3-b12f-6ac6aa21ee4b` · `XT`
    `3c25d99c-977f-4891-940e-5ddf4361718a` · `XDA`
    `cb80acf8-b981-4e75-ae0d-3f9a338c266c` · `CSF`
    `d20469fb-2119-45b9-9811-ef91bdf70573` · `Spend Analysis`
    `899c3ea0-6fb6-4b9e-82d4-a137c2d7ca0b` · `HLM`
    `5e13bedd-e353-48b2-915f-a5885f5c51a5` · `ALL`
    `f528c502-d316-44f7-b0ca-5b41678f18fd`
  - `⚡ Next Release` (checkbox) id `10158a6b-7a0c-49ad-a249-92f83ed79dff` (value
    `"true"` / `"false"`).
  - **No `Sprint Points` custom field exists on the sprint list** (only Platform
    and Next Release). Set status/priority by name; leave points out at creation
    (they are assigned in Planning, and there is no field to write them to today).
    If a Sprint Points field is added later, re-cache it here.
- **Statuses:** set by name (`backlog`, `planning`, `in progress`, ...); the list
  carries all 13 workflow states below plus a trailing closed `complete`.
- **Hierarchy tool bug / workaround:** a blank-named space in this workspace makes
  `clickup_get_workspace_hierarchy` fail root output validation. Scope the call
  with `space_ids: ["901511370980"]` (or the AIXELERATOR space `90156123347`) to
  avoid the broken sibling. `clickup_get_list` / `clickup_search` are unaffected.

## Docs: syncing specs into ClickUp

Local markdown specs (e.g. `02-modules/<feature>/*.md`) publish to ClickUp
Docs so the team can read them alongside the ticket. Convention: **one folder
`Specs`, one doc per feature, one page per spec file.**

- **Specs folder id (X Platforms space): `901516985418`** (cached 2026-07-22). Create
  it once with `clickup_create_folder(space_id, name="Specs")` if it is gone.
- **Create the doc under the folder:** `clickup_create_document(name, parent={id: "901516985418", type: "5"}, visibility: "PUBLIC", create_page: false)`. Parent `type`: `4`=space, `5`=folder, `6`=list, `12`=workspace. Returns a `document_id`.
- **Add a page per spec file:** `clickup_create_document_page(document_id, name, content=<markdown>, content_format="text/md")`. Markdown (headings, tables, code) renders natively. Typical pages: `Functional Spec`, `Technical Spec`, `What Was Done (as-built)`.
- **Update in place (re-sync):** `clickup_update_document_page(document_id, page_id, content=...)` refreshes an existing page instead of adding a duplicate. Keep the `page_id` from the create call (or `clickup_list_document_pages`) so edits to a local spec update the same page.
- **Link it from the ticket:** add a `clickup_create_comment` on the task with the `document_url` (`https://app.clickup.com/{workspace}/docs/{document_id}`). Docs are not attached to tasks directly; the comment is the trail.

Gotchas:
- There is **no move-doc or delete-doc MCP tool**. To relocate a doc (e.g. into the
  Specs folder) you must **re-create** it there and delete the old one **in the UI**.
  So pick the parent correctly on creation.
- `clickup_create_document` / `_page` intermittently return a transient ClickUp
  500, just **retry** (creation is not idempotent, but a 500 means it did not
  create, so retrying is safe).
- Publishing is a **one-way copy** of the file's content; ClickUp is not the source
  of truth. Update the local `.md`, then `update_document_page` to re-sync.

## Two ticket types (they enter the workflow differently)

- **Development / Enhancement** - a planned requirement. Lives in the **current
  sprint list** (`X Platform Sprints`). Enters at **Backlog** (or the status the
  work is actually at).
- **Bug** - a reported defect. Lives in the **Bugs folder's platform list**
  (AIX / XT / XDA). Enters at **Waiting for Triage**.

Everything after the testing stage is shared (ALL). The type only changes the
entry point and the two type-specific states (Planning vs Investigating).

## 1. Naming convention

`[Platform Module] - [Short Description]`

Example: `[XT Impact] - Enable Impact Filtering Options`

The task **name** is the Short Description. Keep it terse and specific; the full
detail belongs in the description.

## 2. Description template

The description must be **functional** and leave little to no room for
interpretation, so any team member, senior or junior, understands the ticket
from the description alone. Scope-clarification questions go in **comments**, not
by editing the description silently (traceability). Fill this template into the
task description on creation:

```markdown
## Context
Why this is needed: the business context / driver behind the requirement.

## Scope / User Story
What the system must do, functionally. Where possible express as user stories:
"As a <role>, I want <capability>, so that <outcome>."

## Success Criteria
The observable conditions that must be true before we call this "done".
- [ ] ...
- [ ] ...

## Additional Comments (optional)
Risks, concerns, cross-team dependencies, and any negative instructions
(what must NOT happen as a result of this change). Use for complex work that
needs triangulation across fronts.

## Attachments (optional)
Reference any images/specs attached to the ticket.
```

- **Context**, **Scope / User Story**, and **Success Criteria** are required.
- **Additional Comments** and **Attachments** are optional (include when they add clarity).
- Owner of the description content: **Project Manager / Support Lead**.

## 3. Required fields

| Field | What it is | ClickUp mechanism | Owner |
|-------|------------|-------------------|-------|
| Status | Workflow state (see below) | task status | Ticket Owner (whoever sets the transition) |
| Short Description | The `[Platform Module] - [Short Description]` title | task name | Project Manager |
| Assignee | Current ticket owner; changes on handoffs | assignee | Project Manager (and per-transition rules) |
| Comments | Running status / evidence / decisions trail | task comments | Ticket Owner |
| Sprint Points | Fibonacci complexity (see scale) | custom field (dropdown) | Development Team |
| Priority | Low / Medium / High / Urgent (urgency x impact) | native ClickUp priority | Project Manager |
| Next Release (Y/N) | Boolean; Yes = prioritized for the next release | custom field (checkbox/dropdown) | Project Manager |
| Platform | Which platform the ticket addresses | custom field (dropdown) | Project Manager |

Read the list's custom fields with `clickup_get_custom_fields` to get the field
ids and option ids before setting Next Release / Platform. Priority maps to
ClickUp's native priority (urgent/high/normal/low ~ Urgent/High/Medium/Low).
**Note:** the sprint list currently has **no Sprint Points custom field** (only
Platform and Next Release), so points cannot be written today; capture the
estimate in a comment during Planning until the field is added.

## 4. Status workflow (13 states)

Set the status, then **do the handoff**: change the assignee and leave a comment
per the rule. The comment is mandatory wherever a rule says "leave comments",
it is the traceability record.

| # | Status | Eligible | Meaning / entry condition |
|---|--------|----------|---------------------------|
| 1 | Backlog | Dev/Enh | Documented in enough detail to start, but not yet prioritized or scheduled for this sprint. |
| 2 | Waiting for Triage | Bugs | Bug reported, awaiting triage; severity + urgency drive triage order. |
| 3 | Planning | Dev/Enh | Picked up; turning functional requirements into a technical plan (prereqs, dependencies, approaches, success criteria, sprint points, ETA). Moves to In Progress once the plan is final and Sprint Points are assigned. |
| 4 | In Progress | Dev/Enh | Plan finalized; implementation underway. |
| 5 | Investigating | Bugs | Bug-only hybrid of planning + WIP: reproduction, edge-case validation, approach validation (hotfix vs definitive), regression checks. |
| 6 | Testing/QA - Dev | ALL | Work finished, testable in **Dev**. Set by the developer who promoted it; **reassign to QA**; comment latest status + testing instructions. |
| 7 | Testing Passed / Dev | ALL | Passed in Dev, ready to promote to **Demo**. Set by QA; **reassign to the original ticket owner**; comment testing evidence. |
| 8 | Testing/QA - Demo | ALL | Testable in **Demo**. Set by the developer who promoted it; **reassign to QA**; comment status + instructions. |
| 9 | Testing Passed / Demo | ALL | Passed in Demo, ready to promote to **Prod**. Set by QA; **reassign to original owner**; comment evidence. |
| 10 | Deployed to Prod | ALL | Promoted to Production. Dev assigns to QA (Dev/Enh) or to the support resource (Bug) for final validation; extra Prod testing is selective, by impact/complexity. |
| 11 | Resolved | ALL | **Terminal.** Dev/Enh: QA validated (evidence attached) from Deployed to Prod. Bug: support confirmed with the affected user(s), resolution comments attached. |
| 12 | On Hold | ALL | Started work paused. Product Director documents rationale in comments and takes ownership until resumed. |
| 13 | Cancelled | ALL | **Terminal.** No longer required (started or not). Product Director documents rationale in comments and takes ownership before cancelling. |

### Typical happy paths

- **Dev / Enhancement:** Backlog -> Planning -> In Progress -> Testing/QA - Dev -> Testing Passed / Dev -> Testing/QA - Demo -> Testing Passed / Demo -> Deployed to Prod -> Resolved
- **Bug:** Waiting for Triage -> Investigating -> Testing/QA - Dev -> Testing Passed / Dev -> Testing/QA - Demo -> Testing Passed / Demo -> Deployed to Prod -> Resolved

### Failure / re-open rule

If Production testing fails, attach the failed-testing evidence, reassign to the
original technical owner, and send the ticket **back to Investigating**. The
testing cycle resets from there.

`On Hold` and `Cancelled` can be entered from any active state and are owned by
the Product Director.

## 5. Sprint Points (Fibonacci)

Assigned by the **Development Team** during Planning/Triage. Satisfy the
**majority** of the criteria for a level, not all.

| Pts | Meaning | Criteria (majority) | Reference examples | ETA |
|-----|---------|---------------------|--------------------|-----|
| 1 | Trivial | Known solution, no design decisions; localized to one component; no new logic paths; no coordination; existing tests suffice. | Config/copy change, dependency bump with green CI, single-field label fix | 1-2 hours |
| 2 | Simple | Obvious approach; stays within one layer; small new logic following an existing pattern; standard scoped tests. | Small UI fix, backend validator update, add a field end-to-end within one layer | 2-4 hours |
| 3 | Standard | Clear scope, familiar territory; introduces state / non-trivial control flow / several validation branches; single bounded context; deliberate test coverage. | New form with server-side validation + error states, new endpoint following an existing pattern, prompt-pack revision within guidelines | 1-2 days |
| 5 | Substantial | Spans 2+ layers OR modifies a shared contract/interface/schema; design decisions needed but discoverable within the sprint; likely coordination with one adjacent team; non-trivial regression risk. | New agent on the established chain pattern, feature needing backend + frontend + schema, migrating a shared block across a few consumers | 3-5 days |
| 8 | Large | Cross-cutting; touches shared foundations (schemas, shared blocks, infra, platform contracts) OR needs research; coordination across 2+ teams; large test surface; explicit rollback/migration plan required. | Guidelines bump requiring migration of all agents, introducing a new architectural pattern, replacing a shared dependency | 1-2 weeks. Decompose into 3s and 5s first if you can. |
| 13 | Too big to commit | **Do not pull into a sprint.** Mandatory: (a) decompose into <=8 pt subtasks, or (b) open a spike capped at 3 pts to produce the decomposition and real estimates. | | >2 weeks |

## 6. Priority

`Low / Medium / High / Urgent`, based on a combination of **urgency and impact**.
Set by the Project Manager. Maps to ClickUp native priority.

## 7. Reporting KPIs (sprint dashboard)

Build with `clickup_create_dashboard`. Each KPI is **segmented by platform and
by ticket type (Tasks vs Bugs)**.

| KPI | Definition | Business value |
|-----|------------|----------------|
| # of Open Tickets per Sprint | Tickets currently open (Backlog + In Progress and other non-terminal states) | Volumetric analysis |
| # of Resolved Tickets per Sprint | Tickets moved to Resolved or Cancelled during the sprint | Volumetric analysis |
| Sprint Points | Total Sprint Points for the current sprint | Sprint complexity + staffing bandwidth trends (avg points per sprint) |

## Creating a ticket (checklist)

1. Resolve the destination list under the **X Platforms** space: the **current
   sprint list** (inside `X Platform Sprints`, folder `901516703258`) for a
   Development/Enhancement ticket, or the matching **Bugs** platform list only for
   a reported defect. Do NOT default to a `Bugs` list, and do NOT resolve `XT` by
   name (that is the Bugs/XT list). If unsure which, ask the user.
2. `clickup_get_custom_fields` on that list -> get field + option ids for Sprint Points, Next Release, Platform.
3. Name it `[Platform Module] - [Short Description]`.
4. Fill the **description template** (Context / Scope / Success Criteria required).
5. Set the **entry status**: Backlog for Dev/Enh, Waiting for Triage for Bug.
6. Set Priority (native) and the custom fields (Platform, Next Release; Sprint Points once estimated).
7. Assign the initial owner.
8. `clickup_create_task`. Put clarifications and decisions in **comments**, never by silently editing the description.

## Transitioning a ticket (checklist)

1. Confirm the target status is valid for the ticket type and the current state (use the happy-path / rules above).
2. `clickup_update_task` to set the new status.
3. **Reassign** per the status rule (e.g. developer -> QA on Testing/QA; QA -> original owner on Testing Passed).
4. `clickup_create_comment` with the required content for that transition (testing instructions, evidence, rationale).
5. For a failed Prod test: attach evidence, reassign to the original technical owner, set status back to **Investigating**.

## One-time space setup

If the **X Platforms** space is not yet structured: create the statuses in exact order and
naming from section 4; create the custom fields Sprint Points (dropdown: 1, 2, 3,
5, 8, 13), Next Release (checkbox/dropdown Y/N), and Platform (dropdown of
platforms); and build the reporting dashboard from section 7. Confirm platform
option values with the user before creating the Platform dropdown.
