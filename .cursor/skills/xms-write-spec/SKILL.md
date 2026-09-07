---
name: 'xms-write-spec'
description: 'Author a feature spec pair (FUNCTIONAL-SPEC.md + TECHNICAL-SPEC.md) in the XMS house format under "02-modules/<feature>/". Use when planning a new feature, workspace, module, or cross-repo change before building it, or when a task says "spec this", "write a spec", or "plan X". The functional spec fixes WHAT and WHY (problem, goals, non-goals, user behavior, rollout); the technical spec fixes HOW (architecture verified in code, data model, routes, ordering, testing, risks). Pairs with xms-write-what-was-done, which records the as-built result after the spec is built.'
---

# Skill: Write an XMS Feature Spec (Functional + Technical)

Every substantial XMS feature starts as a spec pair in `02-modules/<feature-slug>/`: a `FUNCTIONAL-SPEC.md` (what and why, no code) and a `TECHNICAL-SPEC.md` (how, grounded in the real codebase). After the feature ships, a third file `WHAT-WAS-DONE.md` records the as-built result (see the `xms-write-what-was-done` skill). Match this house shape exactly so specs stay scannable and cross-linked.

## Where specs live

- One directory per feature: `C:/Users/matt.brown/Documents/02-modules/<feature-slug>/` (kebab-case slug, e.g. `notification-system`, `requirements-rtm`, `commentary-activity`).
- Two files at authoring time: `FUNCTIONAL-SPEC.md`, `TECHNICAL-SPEC.md`. They cross-link each other in the header and to related specs (e.g. `[Commentary & Activity](../commentary-activity/FUNCTIONAL-SPEC.md)`).
- The canonical exemplar to copy is `notification-system/`. Also strong: `commentary-activity/`, `requirements-rtm/`.

## The header block (both files)

Every spec opens with a bold metadata block, then a `---` rule:

```markdown
# Functional Spec: <Feature Name>

**Status:** Draft | In progress | BUILT (see WHAT-WAS-DONE)
**Owner:** Matt Brown
**Last updated:** 2026-07-11
**Related:** [Technical Spec](./TECHNICAL-SPEC.md), [<Adjacent spec>](../<slug>/FUNCTIONAL-SPEC.md)
**Repos affected:** `frontend`, `backend`, `infra`, `xms_mcp` (list only the ones that change)

---
```

- `Status` earns its keeping: it is where a reader learns the spec is stale, built, or partially resolved. Once built, point it at `WHAT-WAS-DONE.md` and mark resolved concerns inline (the notification technical spec does exactly this: "the routines tenancy concern there is resolved as stale").
- Convert relative dates to absolute (today is 2026-07-17). Never write "last week".
- No em-dashes in prose (house rule): use commas, colons, or separate sentences.

## FUNCTIONAL-SPEC.md structure

Fixed section order. Numbered headings. This file contains NO code, NO schema, NO endpoint tables: it is readable by a non-engineer.

1. **Problem.** The user-felt gap, in plain language. Name the closest things that exist today and why they fall short. Enumerate the distinct kinds of events/cases the feature must cover.
2. **Current state (what exists today).** What is already built that this touches, with real file paths. Distinguish "approved UI, mock data" from "real but narrow" from "not built". This is the honest baseline the technical spec will verify.
3. **Goals.** A numbered list of outcomes, each a bolded one-liner then a sentence. Frame as user value, not implementation.
4. **Non-goals / out of scope.** Explicit cuts, each with the reason. This section prevents scope creep and is where reviewers look first. Call out anything deferred to a later phase.
5. **User-facing behavior.** The heart of the doc, broken into `### 5.1`, `### 5.2` subsections. Use a type/vocabulary table where there is a fixed set (see the notification-type table). Describe click-through, empty states, edge cases, collapse/dedup rules, in words a designer could build from.
6. **Rollout.** Numbered phases. Each phase is independently shippable and names its dependency ("Phase 1 with commentary-activity"). Reserve contracts for things not yet built ("when routines ship").
7. **Success criteria.** Concrete, testable sentences a human can walk through ("a user with three workspaces sees mentions from all three within one polling cycle").
8. **Open questions.** Unresolved decisions, each with a stated **default assumption** so the build is unblocked. These get resolved (struck or answered) in the technical spec or WHAT-WAS-DONE.

## TECHNICAL-SPEC.md structure

Fixed section order. The rule that separates a good XMS technical spec from a bad one: **every architectural claim is verified against real code**, with file paths, and the spec says so ("verified in code", "Verified 2026-07-12"). Draft assumptions that turn out wrong are corrected in place, not hidden.

1. **Architecture context (current state, verified in code).** A `| Piece | Where | Relevance |` table mapping each existing component you build on to its real path and why it matters. State the cross-repo dependency and its ordering here.
2. **Data model.** Per store/collection: a `| Field | Type | Notes |` table, then the actual index definitions in a fenced ```ts block, then any non-trivial service logic (collapse/upsert semantics, soft-delete). Follow the repo standards: route DB access through the data layer, keep controllers thin.
3. **Producers / core logic.** How data gets created: in-process service hooks vs external API-key contract. Name the exact services and methods the hooks live in.
4. **API routes.** A `| Method | Path | Purpose |` table. Note auth (guards, `x-api-key` vs user JWT), pagination params, and that recipient/tenant is always derived from the token, never trusted from the client.
5. **Cross-cutting concerns.** Sections for the hard problems (cross-tenant aggregation, auth scoping, caching). This is where verified-in-code corrections earn their place: show the wrong design you rejected and why.
6. **frontend / client changes.** Subsections per layer (RTK slice, screen cut-over, new component). Reference the focused `xms-web-*` skills rather than re-deriving their patterns.
7. **Ordering / branches.** The branch-by-branch, repo-by-repo sequence and what each depends on. Name the `feature/<slug>` branches.
8. **Testing & verification.** The Jest and Vitest cases that prove the rules (per the isolated-tests standard: constructed data, mocked externals, meaningful assertions), plus the manual smoke pass steps.
9. **Risks / notes.** Known trade-offs. Mark resolved risks **RESOLVED (date)** in place rather than deleting them, so the reasoning survives.
10. **As-built notes.** Added during/after the build: deviations from the draft, edge cases discovered, decisions locked. When the feature is fully done, this content graduates into `WHAT-WAS-DONE.md`.

## House conventions (both files)

- Numbered top-level sections (`## 1.`, `## 2.`), `### N.M` subsections. Bold metadata header, `---` rule after it.
- Prefer tables for anything with a fixed shape (types, fields, routes, the piece/where/relevance map).
- Ground every technical claim in a real path. If you have not read the file, say "assumption" or go read it (Grep/Read) before asserting.
- Respect the repo standards the spec will be built under: thin controllers/routers, DB access through the data layer, MCP modules on `mcp_common`, no suppressed type/lint errors, isolated tests with constructed data. Reference them where the design decision touches them.
- No em-dashes in any user-facing or doc copy.

## Steps

1. Create `02-modules/<feature-slug>/`. Pick a kebab-case slug that will name the `feature/<slug>` branches too.
2. Read `notification-system/FUNCTIONAL-SPEC.md` and `TECHNICAL-SPEC.md` as the shape to mirror.
3. Write `FUNCTIONAL-SPEC.md` first (sections 1-8). Do not describe implementation.
4. Before writing the technical spec, VERIFY the current state: Grep/Read the files you will build on, confirm the paths and signatures. Correct any functional-spec "current state" claim that turns out wrong.
5. Write `TECHNICAL-SPEC.md` (sections 1-10), grounding every claim in code and cross-linking the functional spec.
6. Cross-link both headers to each other and to adjacent specs. Set `Status`, `Owner`, `Last updated` (absolute date), `Repos affected`.
7. When the feature ships, use `xms-write-what-was-done` to add `WHAT-WAS-DONE.md` and flip the statuses.

## Checkpoints

- Does the functional spec stay free of code, schema, and endpoint tables (a non-engineer can read it)?
- Is every technical claim tied to a real file path, and are rejected/corrected designs shown rather than silently dropped?
- Does each rollout phase ship independently and name its dependency?
- Does every open question carry a default assumption so the build is unblocked?
- Are the section headings and header block byte-for-byte in the house shape (compare against `notification-system/`)?
- Are dates absolute and is the copy free of em-dashes?
