---
name: 'ticket-discipline'
description: 'Open a ClickUp ticket before starting substantive work, move it as the work moves, and close it with evidence when the work is done. Use when starting a feature, a fix, a spike or a migration, when the user says "start on", "pick up", "lets build", "work on this", when finishing a piece of work, and before ending a session with work in flight. Covers where an XMS ticket goes, the naming and description the house expects, which status to move to and when, and what closing evidence a ticket needs. Works through the ClickUp MCP tools.'
---

# Skill: Ticket Discipline

Work that exists only in a chat window and a commit log is invisible to everyone who was not in the room. The rule is simple: **substantive work opens a ticket before it starts, and that ticket closes when the work does.**

This skill owns the lifecycle. `aibl-clickup` owns the conventions it writes (naming, the description template, the 13 states, Fibonacci, the required fields), `triage-ticket` owns the decision about whether a ticket is ready, and `closing-a-requirement` owns the register side. Read this one for when to open and when to close.

## What needs a ticket

**Yes:** a feature, a fix a user would notice, a migration, a spike, a spec pair, a refactor that changes behaviour, anything spanning more than one sitting, anything another person would need to know happened.

**No:** a typo, a comment, a question, a rename with no behaviour change, work already covered by an open ticket. Opening a ticket for a five-minute change costs more than it records.

If you are unsure, the test is whether someone would ask "when did that change?" in a month.

## Where an XMS ticket goes

Workspace `9015896416`, space **X Platforms** `901511370980`.

| Kind | Destination |
|---|---|
| XMS work of any kind | **ServiceNow Replacement Project**, list `901525427419` |
| Bug | The same list. The `Bugs` folder `901516841378` holds XT, XDA and AIX only, and has no XMS list |

**XMS does not use the sprint lists.** `X Platform Sprints` folder `901516703258` carries the other platforms' fortnightly lists. XMS work lives in its own project list instead. Corrected 2026-09-10, after four tickets were filed into Sprint 5 and had to be moved.

The list carries the same 13 statuses as the sprint lists, so the workflow below is unchanged.

**Never create a ticket in the XMS list `901525777420`.** That list is the home for the published architecture docs only.

### Setup gaps to work around (verified 2026-09-10)

1. **The `Platform` dropdown has no XMS option.** Do not pick a wrong one to fill the field. Leave it unset and write `Platform: XMS` in the opening comment.
2. **No Sprint Points field** exists on the list. The estimate goes in a comment.
3. **No XMS list in the `Bugs` folder.** Raise it rather than filing an XMS defect under another platform.

## Opening the ticket

Before the first edit, not after the last.

1. Confirm the destination: ServiceNow Replacement Project `901525427419`.
2. Name it `[Platform Module] - [Short Description]`, for example `[XMS Tickets] - Ranked queue with stall weighting`.
3. Fill the description template from `aibl-clickup`: **Context**, **Scope / User Story**, **Success Criteria**. All three are required. Success criteria are what you will paste evidence against when you close it, so write them as things that can be demonstrated.
4. Set Priority. Set Next Release if it is going in one.
5. Name the requirement id in the description where the work closes one (`Closes TM-24`). That is the thread between the ticket, the commit and the register.
6. Open at **Backlog**, or at the state the work is actually at. Opening at In Progress is honest when you are starting immediately.

## Moving it

Set the status, then do the handoff: change the assignee and leave a comment. The comment is the traceability record and it is not optional where a rule asks for one.

| Moving to | When |
|---|---|
| Planning | The approach is being worked out. Leave with the plan and the estimate |
| In Progress | The plan is settled and code is being written |
| Testing/QA - Dev | Work is finished and testable in dev. Reassign to QA, comment the testing instructions |
| Testing Passed / Dev | QA passed it. Set by QA, reassign to the original owner |
| On Hold | Work started and paused. Say why, and who owns the pause |

Do not let a ticket sit in In Progress for a fortnight without a comment saying where it actually is.

## Closing it

A ticket closes with **evidence**, not with an assertion.

The closing comment carries:

- **What shipped**, in a sentence a non-engineer can read.
- **The commits**, per repository, by sha. Cross-repo work names both halves.
- **The requirement id** if it closed one, and whether it is now Built or Partial.
- **What is not done**, if anything. A gap named on the ticket is worth more than a clean close that hides it.

```markdown
**Done.** A Margin panel on the Budget tab reading the month, and a Cost tab on the
roster person holding effective-dated cost rates.

Commits: backend `2c9fae6` (migration 0046), frontend `3c93105`
Requirement: TB-16, now Built in the register
Not done: the revision 3 rule that margin never renders without delivered value beside it
```

**Terminal states.** `Resolved` means validated, with evidence attached. If QA is a different person, you do not resolve your own ticket: move it to Testing/QA - Dev and hand it over. `Cancelled` is terminal too, and it takes a reason and an owner.

If the work closed a numbered requirement, **run `closing-a-requirement` in the same sitting.** The ticket, the commit and the register are three records of one fact, and any one of them lagging is how they end up disagreeing.

## Steps

1. Decide whether this needs a ticket. Most substantive work does.
2. Confirm the destination list.
3. Create the ticket with the name, the three description sections, priority, and the requirement id if there is one.
4. Move it to In Progress when you start, with the estimate in a comment.
5. Work. Comment on anything that changes the scope, rather than editing the description silently.
6. Close with evidence: what shipped, the commits, the requirement, the gaps.
7. Move the register too, if a requirement changed status.

## Checkpoints

- Was the ticket open before the work started, or written up afterwards to look tidy?
- Is it in ServiceNow Replacement Project, and not in a sprint list or the XMS docs list?
- Do Context, Scope and Success Criteria all say something a stranger could act on?
- Is the estimate recorded in a comment, since there is no field for it?
- Does the closing comment carry the commit sha for every repository that changed?
- Did anything get left undone, and does the ticket say so?
- If a requirement moved, did the register move with it?
