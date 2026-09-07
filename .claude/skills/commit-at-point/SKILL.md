---
name: commit-at-point
description: >-
  Drafts and commits manually staged changes using Conventional Commits headers,
  a descriptive body (changes + intent), and Claude co-author attribution. Shows
  a preview for approval before committing. Use when the user asks to commit,
  says "commit at this point", "commit now", delegates commit creation to the
  agent, or runs /commit. Only evaluates git diff --staged; user stages files first.
disable-model-invocation: false
---

# Commit at This Point

Follow every step below in order. Do not skip steps or merge them.

## Invocation

When triggered by `/commit` (slash command or skill menu) or natural language
("commit at this point", "commit now", etc.):

- Begin evaluating staged changes immediately; do not ask upfront confirmation to start.
- The mandatory preview gate (step 5) still applies before any `git commit`.

Optional type/scope hint from `$ARGUMENTS` or the user's message: prefer that hint
when drafting the header, unless it clearly conflicts with the staged diff.

---

## Step 1: Confirm delegation

Only run this workflow when the user explicitly asked to commit. Do not commit
proactively or without a commit-related request.

---

## Step 2: Check staged changes

Run `git diff --staged` and `git status`.

If **nothing is staged**, stop immediately. Tell the user to stage the files
they want in this commit (`git add …`) and invoke the skill again.

**Do not** run `git add` or stage files on the user's behalf.

---

## Step 3: Inspect context

Run in parallel:

- `git diff --staged`
- `git status`
- `git log` (recent messages for style)

Optionally read `git config user.name` and `git config user.email` to confirm
the human author (primary author is set automatically by git at commit time).

Rules:

- **Do not** read or include unstaged changes in the message.
- **Do not** run `git add` unless the user explicitly asks to stage something in
  the same turn.

---

## Step 4: Draft the message

Draft from the **staged diff only**, using the template below. Infer type, scope,
summary, and intent from what is staged.

### Conventional Commits rules

- **Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`
- **Scope:** optional but preferred when a clear area exists (e.g. `auth`, `api`, `ui`)
- **Subject:** imperative mood, lowercase, no trailing period, ~72 chars max
- **Breaking changes:** add `BREAKING CHANGE:` in the footer when applicable
- **Pick type from intent** of the staged changes, not file count

### Message template

```text
<type>(<scope>): <short imperative summary>

<2–4 sentences: what code changed, what behavior changed, and why>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

**Author attribution:**

- **User (primary author):** set automatically by git from `user.name` / `user.email`.
- **Claude (co-editor):** `Co-Authored-By` trailer in the footer (GitHub-recognized).
  This is the repo's canonical co-author line; keep it exactly as written.

### Example

```text
feat(cv-tailor): add /cv-tailor slash command for cross-workspace runs

Introduce a global slash command and update skill invocation docs so CV
tailoring can start from any workspace. Routes all artifact writes through
repoRoot config to avoid polluting unrelated projects.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

If staged files include secrets (`.env`, credentials, keys), **warn in the preview**
and recommend unstaging before approving. Do not unstage unless the user asks.

---

## Step 5: Preview and approve (mandatory gate)

Use **AskUserQuestion** to show the full proposed commit **before** any `git commit`.

Display clearly labeled sections:

- **Header**
- **Body**
- **Footer**
- **Staged files** (list every file that will be committed)

AskUserQuestion pattern:

```
Question: Commit preview (show full message)

Header:
feat(scope): short summary

Body:
2–4 sentences on what changed and why.

Footer:
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

Staged files:
- path/to/file1
- path/to/file2

Options:
- "Yes, commit" (approve)
- "No, I want changes" (revise)
- "Cancel" (cancel)
```

### On approve

Proceed to step 6.

### On revise

Ask the user what to change (if not already stated in chat). Incorporate feedback,
then re-show the **full** preview (not a partial diff of message edits). Repeat
until they approve or cancel.

### On cancel

Abort. Do not commit. Staged changes remain staged.

Treat "forget it", "drop it", or equivalent as **cancel**.

---

## Step 6: Commit

Only after explicit approval from step 5, run `git commit` with a HEREDOC using
the approved message:

```bash
git commit -m "$(cat <<'EOF'
<type>(<scope>): <short imperative summary>

<body paragraphs>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

Do not push unless the user explicitly asks.

Also follow the user's existing git commit safety rules: no amend/rebase tricks
unless explicitly requested; never skip hooks or bypass signing; never commit
secret files without warning in preview. If on the default branch, branch first.

---

## Step 7: Verify

Run `git status` after commit. Report:

- Commit hash
- Subject line
- Files included

---

## Staged-only policy

| Agent does | Agent does not |
|------------|----------------|
| Read `git diff --staged` | Run `git add` or stage files |
| List staged files in preview | Include unstaged hunks in the message |
| Commit exactly what is staged | Auto-select which changes belong in the commit |
