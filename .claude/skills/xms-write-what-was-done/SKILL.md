---
name: 'xms-write-what-was-done'
description: 'Author the post-implementation WHAT-WAS-DONE.md that closes an XMS feature spec, recording the as-built result: what actually shipped, the commit map per repo, decisions locked during the build, known gaps accepted at delivery, required deploy order, and how future work plugs in. Use after building a feature that has a FUNCTIONAL-SPEC/TECHNICAL-SPEC pair, when a task says "document what was done", "write the as-built", or "close out the spec". Pairs with xms-write-spec.'
---

# Skill: Write an XMS WHAT-WAS-DONE (Post-Implementation Doc)

When an XMS feature ships, its spec directory gains a third file: `WHAT-WAS-DONE.md`. It is the honest, as-built record: what was actually delivered (which can differ from the technical spec), the commit map, the decisions that got locked mid-build, the gaps knowingly left open, and the deploy order that must be respected. It is written for the person who deploys, extends, or debugs this later, not for the person who approved the plan.

## Where it lives

- Same directory as the spec pair: `C:/Users/matt.brown/Documents/02-modules/<feature-slug>/WHAT-WAS-DONE.md`.
- Canonical exemplar: `notification-system/WHAT-WAS-DONE.md`. Also strong: `commentary-activity/WHAT-WAS-DONE.md`, `requirements-rtm/WHAT-WAS-DONE.md`.
- When you write it, flip the `Status` in both spec files to point here, and mark now-resolved risks/open-questions resolved in place.

## The header block + commit map

```markdown
# What Was Done: <Feature Name>

**Status:** Delivered (code complete, unit-tested, live smoke pending) | Merged to dev | Live
**Owner:** Matt Brown
**Date:** 2026-07-13
**Related:** [Functional Spec](./FUNCTIONAL-SPEC.md), [Technical Spec](./TECHNICAL-SPEC.md), [<Adjacent>](../<slug>/WHAT-WAS-DONE.md)
**Branches:** `feature/<slug>` in <which repos>, branched off `<base branch>`

| Repo | Commits (in order) |
|---|---|
| backend | `0e8be053` phase 1 module, `5942dc72` activity fan-out, ... |
| frontend | `a6305f55` landing bell, `acdd078e` follow toggle, ... |

---
```

- `Status` must be precise about the delivery stage: "code complete, unit-tested, live smoke pending" is very different from "Live". State exactly what has and has NOT been verified.
- The commit map (repo -> ordered commit shas with a phrase each) is what makes this doc auditable. Keep commits in landing order and label each with what it did.
- Absolute dates only (today is 2026-07-17). No em-dashes.

## Section structure

Fixed order, numbered headings:

1. **Summary.** One paragraph: what the user can now do that they could not before, and the shape of what shipped (surfaces, producers, contracts). Written as delivered reality, past tense.
2. **Backend delivered** (`backend`, including the `src/worker` entrypoint). Bulleted, each bullet a bolded lead then the detail. Name the modules, collections/tables, the identity/scoping decisions, the producer hooks, the tests count. Note where the build deviated from the technical spec and why.
3. **Frontend delivered** (`frontend`). Same bulleted shape: the RTK slice, the screens cut over, new components, the visual vocabulary, toasts, polish. Real component paths.
4. **Decisions locked during the build.** The choices that are now settled (and were open questions or draft assumptions in the spec). Each a one-liner with the rationale. This is where "we verified X, then designed around it" lives.
5. **Known gaps (accepted at delivery).** Numbered. Every shortcut, parallel-system, duplicate-edge, or deferred piece that a future reader must know about. Point to the technical spec's as-built section for detail. Being explicit here is the whole point: silent gaps become production surprises.
6. **Deploy order (required).** The exact sequence deploys must follow and why (which code calls endpoints that do not exist on older backends). Note what is already merged to dev vs what the open PR delta is.
7. **How to plug in (producer/extension recipes).** The reusable seams the feature left behind: "new notification type = add to enum + meta + produce"; "routines POST with an `axk_live_` key"; "agent audit screen = mount ActivityFeed on this target id". Each recipe is a short concrete recipe a future dev follows without re-reading the whole spec.

Adapt sections 2/3 to the repos that actually changed (drop "Frontend delivered" for a backend-only feature; add an `infra` or `xms_mcp` section when those changed).

## What makes a good WHAT-WAS-DONE (vs a bad one)

- **As-built, not as-planned.** If the build diverged from the technical spec, this file states the divergence and the reason. The `notification-system` doc records that `recipientId` became identity-keys (email OR Clerk id) instead of Clerk ids, and that a cross-tenant `read-all` route was added beyond the spec table. Do the same.
- **Honest about verification.** Distinguish "unit-tested" from "live-smoked". If nothing has run against a real backend, say so in `Status` and in Known gaps (#1 is almost always "nothing tested live yet").
- **Deploy order is load-bearing.** Cross-repo features break if deployed out of order. State it as a required sequence, not a suggestion.
- **Leave seams, not just history.** Section 7 is what lets the next feature (routines, an audit screen) land with zero changes here. Write the recipes even if the consumer does not exist yet.
- Respect repo standards in what you describe (thin controllers, data-layer access, isolated tests). If a gap violates one, name it as a gap.

## Steps

1. Confirm the feature is built and you can enumerate its commits. Run `git log` per affected repo/branch to build the commit map in landing order.
2. Read the feature's `TECHNICAL-SPEC.md` (especially its section 10 as-built notes) and `notification-system/WHAT-WAS-DONE.md` for shape.
3. Write `WHAT-WAS-DONE.md` in the section order above, describing what actually shipped, calling out every deviation from the spec.
4. List known gaps honestly, numbered, cross-linked to the technical spec.
5. State the required deploy order and the merged-vs-pending delta.
6. Write the plug-in recipes (section 7) for the seams the feature left.
7. Update the spec pair: flip both `Status` lines to reference this file, mark resolved risks/open-questions resolved in place.
8. If the memory index tracks this feature, update its one-line pointer to "BUILT / as-built documented".

## Checkpoints

- Is there a per-repo commit map in landing order, each commit labeled?
- Does `Status` state exactly what has and has not been verified (unit vs live)?
- Are deviations from the technical spec called out, not glossed?
- Is the deploy order stated as a required sequence with the reason?
- Does section 7 give a future dev a concrete recipe to extend the feature without re-reading the spec?
- Is Known gaps numbered and honest (including "not tested live yet" when true)?
- Absolute dates, no em-dashes, real file/module paths throughout?
