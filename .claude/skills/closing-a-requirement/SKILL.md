---
name: 'closing-a-requirement'
description: 'Close a requirement properly: cite its ID in the commit, move its status in the register generator, regenerate, and record what shipped in the delivery TODO. Use whenever a change delivers or partly delivers a numbered requirement (TM-, TB-, CAP-, CP-, DR-, EM-, SN-, INT-, AI-, DM-, XA-, KB-, RL-, MC-, AH-, TC-, CL-, CG-, OC-), when a task says "that is done", "mark it built", "close this off", when finishing a feature branch, or when the register and the code have drifted apart. Also covers auditing the register against commit history.'
---

# Skill: Closing a Requirement

A requirement is not closed when the code works. It is closed when someone reading the register a month later can see it is done, and see what proved it.

Two records have to move together: **the commit that delivered it** and **the register that tracks it**. They live in different repositories, which is exactly why they drift.

## The failure this prevents (it already happened)

TB-16, profitability per account, was built on 2026-09-09 across two repositories: `backend` `2c9fae6` with migration 0046, and `frontend` `3c93105`. Neither feature commit named TB-16. The register still said Partial the next day, and an audit had to infer the truth from a `docs(todo)` commit that happened to mention it.

The work was done well. The record was not, and for a day the register was lying about the product.

## What to do, every time

### 1. Name the requirement in the commit

Put the ID in the subject where it fits, or in the body where it does not:

```
feat(time): account profitability against delivered value (TB-16)
```

The body names the other half when the change spans repositories:

```
Frontend half in xms-frontend 3c93105. Register moved in xms-specs.
```

**"cut" in this history means delivered in this cut of scope, not removed.** `feat(portal): CSAT on ticket close (CP-07 cut)` shipped CSAT. Read the log with that in mind and write it the same way.

### 2. Move the status in the generator, never in the page

`00-overview/REQUIREMENTS-TRACEABILITY.md`, `requirements.csv` and `requirements.json` are **generated**. Hand-editing them is forbidden (ADR-00) and the next regeneration silently reverts you.

The status lives in `00-overview/scripts/build_register.py`:

- `BUILT` is a set of ids. Add the id here when it is present and wired.
- `PARTIAL` is a dict of id to the gap. **Every partial names what is missing.** A partial with no gap is a guess wearing a status.
- Anything in neither is `Not started`.

Moving a row from Partial to Built means deleting its `PARTIAL` entry and adding the id to `BUILT`. Leaving it in both is a contradiction the script will not catch for you.

### 3. Regenerate and check the count moved

```
py 00-overview/scripts/build_register.py "<path to Copy of DMS_Ticketing_System_Requirements.xlsx>"
```

The workbook is the first source, so you need it on disk. Confirm the summary in section 2 of the register moved by the number of rows you changed, and no further.

### 4. Record what shipped in the delivery TODO

`03-delivery/TODO.md` carries the house line: the id, the date, the commits in each repository, and what the reader needs to know.

```
- [x] TB-16 profitability per account (built 2026-09-09, backend `2c9fae6` migration 0046,
  frontend `3c93105`): a Margin panel on the Budget tab reading the month, and a Cost tab on
  the roster person holding effective-dated cost rates. Margin is computed over the finance
  lines rather than re-derived from the rate cards, so the two can never disagree. Two new
  permissions, finance:view-margin and finance:manage-cost, neither implied by contracts:view.
```

Commit it as `docs(todo): <what> is built`, matching the existing habit.

### 5. Commit the register with the code, not later

Two commits, one in each repository, in the same sitting. The app commit cites the id; the specs commit moves the status. A register update that waits for "later" is the drift this skill exists to stop.

## Built, Partial and the honest middle

**Built** means present and wired. It does **not** mean signed off against the acceptance note, and it does not mean it satisfies a later revision that widened the row. The register says this where the numbers are, and that sentence has to keep being true.

Reach for **Partial** more readily than feels comfortable. Three real examples:

- **AI-03 and AI-04.** The capability builders exist and the SSE client is real, but Ask Axel and Draft with Axel were removed from the UI because the turn surface is held. Code without a reachable surface is Partial.
- **AI-01, AI-02, AI-07.** `HARNESS_BASE_URL` is unset and `NullHarnessClient` throws, so nothing has run end to end. Wired is not working.
- **TM-17.** One backend reference and no authoring surface. Schema is not a feature.

If you cannot write the gap in a sentence, the status is probably Built or Not started, not Partial.

## Auditing for drift

Worth running before a review, a demo, or any conversation where the numbers get quoted. It compares what the commits claim against what the register says:

```bash
# every requirement id the commit history cites, across all three repos
for r in . frontend backend; do git -C "$r" log --format="%s%n%b"; done \
  | grep -ohE "\b(TM|TB|CAP|CP|DR|EM|SN|INT|AI|DM|XA|KB|RL|MC|AH|TC|CL|CG|OC)-[0-9]{2}[ab]?\b" \
  | sort -u
```

Anything cited by a feature commit but marked Not started is drift, and the commit is usually right. Anything marked Built and never cited anywhere needs its code evidence to stand on its own, which is fine but worth knowing: only about a quarter of the register is ever named in a commit message, so **history can corroborate a status and can never refute one by silence.**

Watch for docs commits polluting the result. An id mentioned only in a `docs(rtm)` or `docs(todo)` message is a record of the requirement, not evidence of a build.

## Steps

1. Confirm the change actually delivers the requirement, against its acceptance note in the register.
2. Commit the code with the id named.
3. Move the id in `BUILT` or `PARTIAL` in `build_register.py`, writing the gap if it is a partial.
4. Regenerate the register and confirm the counts moved by exactly what you changed.
5. Add the TODO line with the date and the commit in each repository.
6. Commit the specs change in the same sitting.

## Checkpoints

- Does the commit name the requirement id?
- Did you edit the generator rather than the generated page?
- If Partial, is the gap written in a sentence a stranger could act on?
- Is the id in exactly one of `BUILT` and `PARTIAL`, never both?
- Did the register counts move by the number of rows you touched, and no more?
- Does the TODO line carry the date and the commit in every repository that changed?
- Are both commits in, or is the register about to spend a week disagreeing with the product?
