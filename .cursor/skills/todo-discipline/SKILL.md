---
name: 'todo-discipline'
description: 'Enforces a tracked todo list for any multi-step work: an in-session task list plus a durable TODO.md in the repo for anything spanning several branches, repos, or sessions. Use when starting a feature, a spec build, a migration, or any task with 3+ steps; when the user says "create a todo list", "track this", "keep a list", "begin"; when picking up work someone else started; and before ending a turn with unfinished multi-step work. Also use when reviewing a change whose plan lives only in chat.'
---

# Skill: Todo Discipline

Multi-step work needs a list that survives the turn. Two layers do that: the **in-session task list** (the TaskCreate / TaskUpdate tools) so the current turn stays honest, and a **durable `TODO.md` in the repo** so the next session, the next agent, or a colleague can pick the work up cold. This skill sets when each is required, the house shape of the file, and the rules that keep it from going stale.

Adjacent skills: `xms-write-spec` produces the spec a TODO is derived from, `xms-write-what-was-done` is where a finished TODO graduates to, `xms-git-development-workflow` owns the branch names the TODO groups by, and `commit-at-point` is the commit that must carry the tick.

## When a list is required

| Situation | In-session list | `TODO.md` in repo |
| --- | --- | --- |
| Single edit, one file, a question, a lookup | No | No |
| 3 or more distinct steps in one turn | Yes | No |
| Work spanning more than one repo or branch | Yes | Yes |
| Work that will not finish this session | Yes | Yes |
| Anything with a spec in `02-modules/<slug>/` | Yes | Yes |
| Anything with a ClickUp ticket that is more than one commit | Yes | Yes |

If you are unsure, write the list. The cost of an unnecessary list is thirty seconds; the cost of a missing one is a half-built feature nobody can resume.

## Where the file lives

- One file per feature, in the repo that **ships first** (per the spec's ordering section): `<repo>/docs/<feature-slug>-todo.md`.
- Precedent to mirror: the delivery TODO in the XMS spec set.
- The slug matches the spec directory and the branch name, so `02-modules/project-picker/`, `feature/project-picker`, and `backend/docs/project-picker-todo.md` all read as one thing.
- It is committed. A todo list on a scratchpad or in chat does not count, because the next session cannot find it.

## The house shape

```markdown
# TODO: <Feature Name>

**Spec:** 02-modules/<slug>/ (functional, technical)
**Ticket:** AIBL-nnn
**Status legend:** `[ ]` not started, `[~]` in progress, `[x]` done and verified

---

## 1. <Phase name> (`repo`, `branch`)

- [ ] One outcome, stated so it can be verified
- [ ] Another outcome
- [ ] Tests: the specific cases that prove this phase

## 2. <Next phase> (`repo`, `branch`)

...

## Decisions locked

- Short line per decision, so nobody relitigates it mid-build.

## Blocked / open

- The question, who owns it, and the default assumption being built against.
```

Rules for the content:

- **Phases mirror the spec's ordering section**, one heading per shippable branch, in deploy order. If the spec says `backend` ships before `frontend`, the file says so too.
- **Each item is an outcome, not an activity.** "Visit upsert is idempotent under a repeat write" beats "work on visits".
- **Tests are items, not an afterthought.** Every phase carries its own test line, per `writing-tests`.
- **Decisions locked** captures what the user already settled. It is the section that stops a rebuild of a decided question three days later.
- **Blocked / open** carries a default assumption for every open question, so the build is never stalled waiting on an answer.

## The rules that keep it true

1. **Write the list before the first edit**, not after. A list reconstructed at the end is a changelog, not a plan.
2. **Exactly one item in progress** at a time, in-session and in the file.
3. **Tick the moment it is done**, never in a batch at the end of the turn.
4. **`[x]` means verified**, not written. Code that compiles but has no passing test is `[~]`.
5. **The tick ships in the same commit as the work.** A commit that implements an item and leaves it unticked makes the file lie, and a file that has lied once stops being read.
6. **Never end a turn with a stale list.** Either the statuses are current, or the final message says which items remain open and why.
7. **New work discovered mid-build is added to the file**, not silently absorbed. Scope growth that never reaches the list is scope growth nobody can see.
8. **Deleting an item requires a reason** written next to it, or moved into Blocked / open.
9. **When the feature ships**, the content graduates into `WHAT-WAS-DONE.md` via `xms-write-what-was-done` and the TODO file is deleted in that same commit. Two records of the same truth will diverge.

## Steps

1. Decide from the table above whether this needs a file, an in-session list, or both.
2. If a spec exists, read its ordering and rollout sections. The phases in the TODO come from there, not from your own decomposition.
3. Create `<repo>/docs/<feature-slug>-todo.md` in the repo that ships first, using the house shape.
4. Fill Decisions locked from what the user has already settled in conversation, and Blocked / open from the spec's open questions, each with its default assumption.
5. Create the matching in-session task list, one task per item you intend to complete this session.
6. Work one item at a time. Mark it in progress when you start it, verified when its test passes.
7. Commit the tick with the work it describes.
8. Before ending the turn, reconcile: the file, the in-session list, and reality agree, or your final message names the gap.
9. On completion, graduate the file into `WHAT-WAS-DONE.md` and delete it.

## Checkpoints

- Does a reader who has never seen this conversation know what is done, what is next, and what is blocked?
- Is every item an outcome that can be verified, rather than an activity?
- Does each phase name its repo and branch, in deploy order matching the spec?
- Does every open question carry a default assumption?
- Are all `[x]` items actually verified by a passing test or a completed smoke step?
- Did the tick land in the same commit as the work?
- Is the copy free of em-dashes and are any dates absolute?
