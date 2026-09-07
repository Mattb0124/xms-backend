---
name: 'improve-review'
description: 'The outer loop that makes code review self-improving: read how humans reacted to the last cycle of automated review findings, classify each as validated, corrected, refined or ambiguous, decide which lessons are durable, and open a pull request editing the review-changes skill. Use at a sprint boundary, when the user says "the reviewer keeps getting X wrong", "improve the review skill", "why does it keep flagging this", or after a review cycle produced obvious false positives. Never merges its own change.'
---

# Skill: Improve the Review Skill

The review skill is only as good as its last correction. This is the outer loop: the inner loop (`review-changes`) runs on every pull request, humans agree or disagree with what it said, and this skill turns that reaction into a durable rule so the same argument does not happen twice.

The single most important rule: **you edit review guidance, never product code, and you never merge your own change.** A human reviews every proposed update.

## Cadence

Run it **at the sprint boundary**, not daily. The published pattern this is adapted from runs every 24 hours, which assumes a PR volume a four-person team will not produce. A fortnight of reviews is enough signal to tell a pattern from a one-off, and it lines up with the sprint lists in `X Platform Sprints`.

Run it early too, on demand, the moment someone says the reviewer keeps getting something wrong. That complaint is exactly the input this skill exists to consume.

## Collect the feedback

For the window (default: the sprint just ended), gather for each pull request that the review agent reviewed:

- The agent's review body and inline comments, with severities.
- Human replies to those comments, and any reactions.
- What actually happened to each finding: fixed as suggested, fixed differently, dismissed, argued with, or silently ignored.
- Whether a human added a review comment about something the agent **missed**. Misses matter as much as false positives and are easier to overlook, because nothing draws attention to them.

Until the ADO pipeline exists, run this manually: the human pastes the corrections, or you read the PR threads directly. The classification below does not depend on how the corpus was gathered.

## Classify each item

| Class | Meaning |
|---|---|
| **Validated** | The human agreed, accepted the suggestion, or fixed it as recommended |
| **Corrected** | The human said it was wrong, noisy, or the wrong severity |
| **Refined** | Mostly right, but the human adjusted the scope, the reasoning or the preferred fix |
| **Ambiguous** | Not enough signal. Leave it alone |

Ambiguous is a real answer. Do not manufacture a lesson from silence: a finding nobody replied to may have been correct and uncontroversial.

## Decide what is durable

**Encode it** when it is:

- A convention the reviewer repeatedly misses.
- A class of false positive to demote or stop raising.
- A severity miscalibration, in either direction. Under-calling a tenancy issue matters more than over-calling a nit.
- A preferred alternative the team keeps substituting for the agent's suggestion.
- A check humans keep adding by hand that the agent should have made.
- A case where the right behaviour was to say nothing.

**Reject it** when it is:

- Specific to one pull request or one file.
- Already covered by an existing skill. Prefer pointing at that skill over restating it.
- A product preference unrelated to review quality.
- A temporary project constraint unlikely to recur.
- One person's taste that the team has not agreed on. Two reviewers disagreeing is not a rule; it is a conversation to have first.

## What you may not change

Treat these as fixed contract. Changing them breaks the pipeline that consumes the output:

- The `review.json` shape and the `verdict` semantics.
- The four severity markers and their meanings.
- The trust boundary section, in either skill.
- The evidence rule, which is what keeps findings concrete.
- The instruction that the agent writes only `review.json` and never calls a write API.

And never: product code, tests, or configuration.

## Make the edit

1. Read the current `review-changes/SKILL.md` in this repo completely before touching it.
2. Make **the smallest cohesive edit that captures the lesson.** Prefer adding or tightening a line over rewriting a section.
3. Write it as a durable rule, not a diary. "Do not flag a missing `providesTags` on an endpoint that has no list view" is a rule. "In PR 214 Matt said this was fine" is not.
4. Keep the existing structure, headings and checkpoints intact so the diff stays readable.
5. If the lesson belongs to the other repo's checklist, say so in the report rather than editing across a repository boundary.

## Deliver it as a pull request

Branch `improve/review-changes-YYYY-MM-DD`, containing **only** the skill edit. The PR body states:

- The window, and how many pull requests and findings were inspected.
- The counts per class (validated, corrected, refined, ambiguous).
- Each lesson encoded, and why it is durable rather than a one-off.
- Links to the pull requests that evidence it.
- The candidates you rejected, and why. This is the most useful half for a reviewer, because it shows what you chose not to learn.

**Do not merge it.** Leave it for a human, and follow `xms-git-development-workflow` for the branch and PR conventions.

## Report

Close with: the window, PRs inspected, the class breakdown, the decision (no changes, or the lessons encoded), the PR link, and one concrete next action for a human. If the answer is "no durable lesson this sprint", say that plainly. A loop that invents an improvement every cycle to look busy will degrade the skill it is meant to sharpen.

## Checkpoints

- Is every encoded lesson backed by more than one pull request, or by an explicit human instruction?
- Did you leave the output contract, severity markers, trust boundary and evidence rule untouched?
- Is the edit the smallest one that captures the lesson?
- Did you record the rejected candidates?
- Is the change a pull request that you did not merge, touching only the skill file?
- Were misses considered, not just false positives?
