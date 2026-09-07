---
name: 'create-skill'
description: 'Author a new Claude Code skill in this repo as a SKILL.md under .claude/skills/<slug>/, following the XMS house format (YAML frontmatter with a trigger-rich description, then a scannable instruction body). Use when the user asks to create, write, or scaffold a skill, or when you notice a repeatable pattern or best practice worth capturing, especially around architecture, security, performance, testing, or a recurring workflow, so the next agent applies it consistently instead of re-deriving it. Also covers when a pattern deserves a skill, the naming conventions, and how to publish it via Packmind.'
---

# Skill: Create a Skill

A skill is a reusable, on-demand instruction set that teaches the next agent how to do one kind of task the house way. Each skill is a single `SKILL.md` file under `.claude/skills/<slug>/`, discovered by its `description`, and invoked via the Skill tool (or `/<slug>`). This skill teaches you to author one that matches the existing skills in this repo (`xms-write-spec`, `create-nestjs-feature-module`, `writing-tests`, ...).

## When to create a skill (be proactive)

Create a skill whenever you find a **repeatable pattern or an established best practice** that a future agent would otherwise have to rediscover. Do not wait to be asked. Strong triggers:

- **Architecture.** A house layering rule, a scaffolding recipe, a "always build X on shared Y" convention (e.g. MCP modules on `mcp_common`, thin controllers, DB access through the data layer). If you had to read three files to learn the shape, capture the shape.
- **Security.** An auth/scoping pattern, a "never trust the client for tenant/recipient", a secrets-handling rule, a validation gate. Security knowledge that lives only in one reviewer's head is the knowledge most worth writing down.
- **Performance.** A caching key convention, an N+1 avoidance pattern, a pagination or batching rule, a "don't do this in a hot path" caution learned the hard way.
- **Testing / quality gates.** A canonical test shape, fixtures, the pre-PR gate. (See `writing-tests`, `pre-pr-quality-check`.)
- **Recurring workflow.** Any multi-step task you have now done or explained more than once (a spec format, a commit convention, a release step).

Rule of thumb: if you catch yourself re-deriving a decision, correcting the same mistake twice, or writing "the house way to do X is...", that is a skill. Prefer one **focused** skill per pattern over a sprawling catch-all; skills can reference each other by name.

Do **not** create a skill for a one-off task, something already covered by an existing skill (extend that skill instead, check the skills list first), or facts the codebase/CLAUDE.md already records.

## Where skills live and naming

- One directory per skill: `.claude/skills/<slug>/SKILL.md`. The slug is kebab-case and IS the invocation name.
- Naming convention by kind:
  - `create-*` for scaffolding a new artifact (`create-nestjs-feature-module`, `create-rtk-query-api-slice`).
  - `xms-*` for XMS product work that is specific to this codebase (`xms-web-design-system`, `xms-write-spec`).
  - A plain verb/topic slug for a workflow or discipline (`writing-tests`, `commit-at-point`, `pre-pr-quality-check`).
- Supporting files (templates, reference docs, scripts) may live alongside `SKILL.md` in the same folder; reference them by relative path from the skill.

## The frontmatter (this is what makes the skill discoverable)

```markdown
---
name: '<slug>'
description: '<what it does> + <precise WHEN to use it>'
---
```

- `name` must equal the directory slug, single-quoted.
- `description` is the single most important line in the file: it is all the agent sees when deciding whether to load the skill. Write it in two parts:
  1. **What** the skill does, in one clause.
  2. **When** to use it: concrete trigger phrases, task shapes, and file/repo cues ("Use when the user says 'spec this'", "Use when adding an SSE event to the v3 chat pipeline", "Use when you notice a repeatable security pattern"). Include the words a future agent's task would actually contain.
- Keep it to a few sentences. Do not describe the whole procedure here; describe the entry conditions. Compare against existing descriptions in the skills list for calibration.

## The body structure

After the frontmatter, write scannable Markdown the agent follows top to bottom. Mirror the existing skills' shape:

1. **`# Skill: <Title>`** then a 2-4 sentence orientation: what this covers, the canonical in-repo exemplar to copy, and how it relates to adjacent skills.
2. **Core sections** with `##` headings tailored to the task. Common ones:
   - *Where it lives / naming* (paths, conventions).
   - *The pattern / house shape* (the actual recipe, with real file paths and short fenced code blocks). Ground every claim in a real path you have read.
   - *Conventions / rules* (the do's and don'ts, the standards it must respect).
3. **`## Steps`**, a numbered, do-this-then-that procedure. This is the operational core; make it executable without further guessing.
4. **`## Checkpoints`**, a short verification checklist ("Does X match the exemplar byte-for-byte? Are dates absolute? Do the tests assert behavior?"). Let the agent self-check before declaring done.

Keep it tight. A skill is instructions, not an essay: prefer tables, short code fences, and imperative bullets. Reference other skills by name rather than restating them.

## House conventions

- No em-dashes in the copy (repo rule): use commas, colons, or separate sentences.
- Absolute dates, never "last week" (today is knowable from context).
- Ground technical claims in real paths; if you have not read the file, read it (Grep/Read) before asserting the pattern.
- Respect and cross-reference the repo standards a skill's output must satisfy (thin controllers/routers, DB access through the data layer, MCP on `mcp_common`, no suppressed type/lint errors, isolated tests with constructed data).
- Single-quote the frontmatter `name` and `description` values.

## Steps

1. Confirm no existing skill already covers this (scan the skills list / `.claude/skills/`). If one is close, extend it instead of adding a duplicate.
2. Pick a kebab-case slug and the naming family (`create-*`, `xms-*`, or plain). Create `.claude/skills/<slug>/`.
3. Read the closest existing skill as a shape to mirror (`xms-write-spec` for docs and workflow skills, `create-nestjs-feature-module` or `create-rtk-query-api-slice` for scaffolding skills).
4. Write the frontmatter: `name` = slug, and a `description` whose second half lists the real trigger phrases and file/repo cues.
5. Write the body: orientation, core sections grounded in real paths, `## Steps`, `## Checkpoints`. Keep it scannable.
6. Verify: does invoking `/<slug>` make sense, is every path real, is the copy free of em-dashes, are dates absolute?
7. Publish via Packmind so the team gets it: `playbook add .claude/skills/<slug>/SKILL.md` (note: `skills add` was removed in 0.30.x; use `playbook add`). Then commit the new file.

## Checkpoints

- Is the skill focused on ONE pattern, not a catch-all, and not a duplicate of an existing skill?
- Does the `description` contain the concrete WHEN (trigger phrases, task shapes, file cues) a future agent's task would match on, not just the WHAT?
- Is every file path in the body real (you read it), and does it reference the relevant repo standards?
- Are there executable `## Steps` and a self-check `## Checkpoints` section?
- Is `name` equal to the folder slug, is the copy em-dash-free, and are dates absolute?
- Did you publish it (`playbook add ...`) and commit it?
