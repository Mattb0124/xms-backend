---
name: xms-git-development-workflow
description: >-
  Guides XMS trunk-based development with production as trunk: work branches,
  release/dev validation, and squash PRs into dev then production. Use when
  starting feature/fix/hotfix work on backend or frontend, cutting a release/dev
  branch, opening land PRs, syncing from production, or when the user mentions
  XMS gitflow, TBD, or /xms-git-development-workflow.
disable-model-invocation: true
---

# XMS Git Development Workflow

Trunk-based development for XMS app repos (`backend`, `frontend`, and similarly
shaped clones). **`production` is the trunk** (source of truth / what ships).
**`dev` is unstable**, so use it only for validation, never as a source of truth
for work branches.

Follow the safety rules and phase instructions below. Do not invent shortcuts
that merge `dev` into a work branch or push directly to `dev` / `production`.

---

## Hard rules

1. **Trunk = `production`.** Work branches stay aligned with `production` only.
2. **Never merge `dev` into a work branch** (`feature|fix|hotfix/...`).
3. **Never push or commit directly to `dev` or `production`.** Land only via
   PR/MR with **squash**.
4. **Both** landings (`→ dev` and `→ production`) are squash merges with a
   descriptive Conventional Commits message (preview + approve first).
5. **Mutating git / VCS CLI** (checkout, pull, merge, push, create PR/MR): only
   after a short **phase confirmation** (branch names + target).
6. **Merge PR/MR and delete branches:** only with **explicit user approval** in
   that turn. **Never auto-delete.**
7. **Platform-agnostic:** detect remote host + available CLI (`gh`, `glab`,
   etc.). If none, prepare branches and give the user head/base + squash
   title/body to open the PR/MR themselves.

---

## Repo gate

On invoke:

1. Confirm this is a git repo with remotes.
2. Verify remote has branches **`production`** and **`dev`**. If either is
   missing → **stop** and explain this workflow does not apply.
3. If the repo name is not clearly an XMS app (`backend`, `frontend`, or known
   equivalents) → **warn**, then continue only if `production` + `dev` exist.

---

## Phase detection

Inspect current branch, recent remotes, and open PR/MRs when a CLI is
available.

| Signal | Phase |
|--------|--------|
| On `production` / no work branch yet / user says start | **Start work** |
| On `feature\|fix\|hotfix/...` with unfinished work | Stay on work branch (coding); offer **Cut release/dev** when they say done |
| On `release/dev/...` or user ready to land on dev | **Release → dev** |
| User says dev validated / ready for prod | **Land → production** |
| Prod PR conflicts / need trunk sync | **Sync from production** |
| After merges, cleanup | **Cleanup** (always ask) |

If ambiguous, show a short menu:

1. Start work branch  
2. Cut / continue release → dev  
3. Sync work branch from production  
4. Land → production (requires explicit “dev validated”)  
5. Cleanup branches  

---

## Naming

**Work branch:** `<type>/<TICKET_ID>/<short-description>`

- **Types (allow-list):** `feature`, `fix`, `hotfix`
- Interview for type (default suggestion: `feature`)
- **Ticket id:** required when one exists; shape varies by project. Prefer
  verifying via ClickUp MCP when available. **No-ticket** only with explicit
  confirmation (e.g. `no-ticket` as the id segment).
- **Short description:** kebab-case, concise

**Release branch:** `release/dev/` + full work branch name  

Example: `fix/XMS-1234/null-guard` → `release/dev/fix/XMS-1234/null-guard`

---

## Agent authority

| Action | Policy |
|--------|--------|
| Interview, draft branch names, draft squash title/body | Freely |
| `fetch` / read-only git / inspect remotes | Freely |
| Create/update branches, merge trunk into work, merge `dev` into release, push | After phase confirmation |
| Create PR/MR | After preview approval of title/body |
| Merge PR/MR | Explicit approval |
| Delete local/remote branches | Explicit approval, never auto-delete |

---

## Phase: Start work

1. Interview: **type**, **ticket id**, **short description**. Confirm full
   branch name before creating.
2. `git fetch origin`
3. Checkout `production` and update: `git pull` (or equivalent) so local matches
   remote.
4. Create work branch with **`-b`** (never `-B`, do not clobber):  
   `git checkout -b <type>/<TICKET_ID>/<short-description>`
   If the branch already exists → stop and ask (reuse / rename / delete with
   permission).
5. Confirm phase done; user implements on this branch.

Hotfix **break-glass** (skip `dev`): only if type is `hotfix` **and** the user
explicitly confirms skipping `dev`. Default for all types (including hotfix) is
the full release → `dev` → production path. Treat skip-dev as exceptional.

---

## Phase: Cut release → land on `dev`

Preconditions: work on `<type>/...` is ready to validate.

1. Confirm release branch name: `release/dev/<full-work-branch-name>`.
2. From the **work branch tip**, create/reset the disposable release branch
   with **`-B`** only after confirm (re-cuts are expected):  
   `git checkout -B release/dev/<full-work-branch-name>`
3. Merge remote `dev` into the release branch:  
   `git pull origin dev` (merge). Resolve conflicts on the **release** branch
   only, do **not** carry those resolutions onto the work branch.
4. Push release branch; open **PR/MR → `dev`**, squash.
5. Draft squash message **and** template-filled PR/MR description (see below);
   **preview and approve**; create PR/MR (copy/paste fallback if auto-open fails).
6. Merge only with explicit approval.
7. After merge: **ask** permission to delete local + remote **release** branch
   (recommended now, release is disposable). If validation later finds bugs,
   fix on the **work** branch and cut a **new** release branch.

---

## Phase: Sync from production (conflict / stay on pair)

Use when the production PR/MR conflicts, or the work branch must catch up to
trunk.

1. Checkout the **work** branch.
2. Merge trunk in (simple merge, not rebase):  
   `git pull origin production` (or `git merge origin/production`).
3. Resolve conflicts on the work branch.
4. **Always** re-run the full **Release → dev** cycle again (new release
   branch + PR/MR to `dev`), even if a prior version already landed on `dev`.
5. Squash message for the re-land should describe the **follow-up /
   re-validation delta**, not pretend it is the first landing of the whole
   feature.

Never merge `dev` into the work branch to “fix” prod conflicts.

---

## Phase: Land → production

Preconditions:

- User explicitly states **dev validation passed** (or equivalent). CI green is
  informational only, not sufficient alone.
- Work branch is the PR/MR head (not the release branch).

1. Ensure work branch is pushed and up to date with how it was validated. If
   production has moved, run **Sync from production** first (includes re-dev).
2. Open **PR/MR → `production`**, squash.
3. Draft squash message **and** template-filled PR/MR description (see below);
   **preview and approve**; create PR/MR (copy/paste fallback if auto-open fails).
4. Merge only with explicit approval.
5. After merge: **ask** permission to delete local + remote **work** branch.

If the prod PR/MR has conflicts: sync from production → re-run release/dev →
get validation again → retry prod.

---

## Phase: Cleanup

Never delete without asking.

- **Release branch:** suggest delete after it is merged to `dev`.
- **Work branch:** suggest delete after it is merged to `production`.
- Abandoned work: offer remote/local delete only with explicit confirm.

---

## Squash message format

Same vocabulary spirit as `commit-at-point`. Required for **both** `dev` and
`production` landings.

```text
<type>(<scope>): <short imperative summary>

<2–4 sentences: product/behavior change a human can understand.
Include ticket id. For re-lands to dev, say it is a follow-up / re-validation
and what changed since the last land.>
```

- Types: `feat`, `fix`, `hotfix` (map from branch type: feature→feat, fix→fix,
  hotfix→hotfix)
- Subject: imperative, lowercase, no trailing period
- Body: what shipped and why, not a file list
- Sources: diff vs target base, user-provided intent, relevant chat context

**Mandatory preview** before creating or merging the PR/MR. Show separately:

- **Squash commit message** (title + body above, used at merge time)
- **PR/MR title** (usually matches the Conventional Commits subject)
- **PR/MR description** (from the repo template when one exists, see below)

On revise, show the full preview again (all three).

---

## PR/MR description templates

Applies to **every** phase that opens a PR/MR (`→ dev` and `→ production`).

Before drafting the PR/MR description:

1. Search the repo for pull/merge request templates (platform-agnostic). Check
   common locations, including but not limited to:
   - `.github/PULL_REQUEST_TEMPLATE.md`
   - `.github/PULL_REQUEST_TEMPLATE/*.md` (or `pull_request_template/`)
   - `PULL_REQUEST_TEMPLATE.md` / `docs/PULL_REQUEST_TEMPLATE.md`
   - `.gitlab/merge_request_templates/*.md`
   - `.azuredevops/pull_request_template.md` / `pull_request_template.md`
2. If **one or more templates** exist:
   - Prefer the default/single template; if several, ask which to use (or pick
     the obvious default for this host).
   - **Fill the PR/MR description by following that template**, keep its
     headings/sections/checklists; populate each section from the diff, ticket,
     and chat context. Do **not** replace the template with only a free-form
     paragraph or title-only body.
   - Leave unchecked boxes / unanswered prompts only when the user must decide;
     call those out in the preview.
3. If **no template** exists: use a clear prose description of the product
   change (aligned with the squash body), still more than a title alone.

The squash commit message stays Conventional Commits as above. The PR/MR
**description** is independent and must honor the template when present.

---

## PR/MR automation (platform-agnostic)

1. `git remote -v` → detect host (GitHub, GitLab, Azure DevOps, etc.).
2. Resolve and fill the PR/MR description per **PR/MR description templates**.
3. Preview + approve: squash message, PR/MR title, and full PR/MR description.
4. If a matching CLI exists and is authenticated, create the PR/MR with that
   **title and full description**, then merge with squash using the approved
   squash message when the user approves merge.
5. **If auto-open fails** (no CLI, auth error, API error, unsupported host) or
   no automation is available:
   - Push the head branch if needed.
   - Print a **copy/paste block** the user can use in the web UI:
     - head branch
     - base branch (`dev` or `production`)
     - PR/MR title
     - **full PR/MR description** (template-filled body, ready to paste)
     - reminder: squash merge only; do not land with a merge commit of feature
       history
   - Do not stop at title-only instructions, the description must be included
     in full.

Never `git push origin dev` or `git push origin production`.

---

## Quick flow diagram

```text
production (trunk)
    │ checkout -b
    ▼
type/TICKET/desc          ← work here; merge production in when needed
    │ checkout -B (confirm)
    ▼
release/dev/type/TICKET/desc
    │ merge origin/dev (conflicts stay here)
    ▼
squash PR/MR → dev  → ask to delete release branch
    │
    │ user: "dev validated"
    ▼
squash PR/MR → production (from work branch) → ask to delete work branch
```

If prod conflicts: merge `production` → work branch → new release/dev cycle →
validate again → prod PR/MR.
