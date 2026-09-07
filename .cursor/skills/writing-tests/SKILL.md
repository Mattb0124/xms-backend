---
name: 'writing-tests'
description: 'How to write automated tests in XMS: Jest in backend (domain units, Testcontainers data-layer integration, supertest HTTP), Vitest in frontend, Playwright for end to end. Use whenever adding or reviewing tests, deciding what deserves a test, closing a coverage gap, or when a task says "add a test", "is this tested", "why is CI red". Covers the one principle (test behaviour at the lowest layer that exercises it), the universal rules (isolation, determinism, meaningful assertions, arrange-act-assert), the layer table with the real XMS paths, the mandatory isolation suite, the test kit factories, coverage floors, anti-patterns, and the pipeline gate.'
---

# Skill: Writing Tests (XMS)

Authority for this skill is `03-delivery/TEST-STRATEGY.md`. It is the plan of record, so when this skill and that document disagree, the document wins and this skill is wrong.

Two Packmind standards bind every test here: **Write Isolated Tests With Constructed Data, Never Live Credentials**, and **Do Not Suppress Type-Check and Lint Errors in Builds**.

## The one principle

**Test behaviour that can break, at the lowest layer that exercises it.** SLA math is tested in the domain service with a constructed clock; the HTTP layer is tested for mapping and auth, not for SLA math. A test earns its keep by failing when a real bug is introduced and passing otherwise. If it cannot fail for a real bug (`expect(x).toBeDefined()`, "renders without crashing"), delete it. `tsc --noEmit` is a gate, not a test suite: it proves types line up, not that logic is correct.

## Universal rules

- **Isolation.** No live credentials, no real database beyond Testcontainers, no real S3, SES, SQS, ServiceNow or Axel. Stub the boundaries and test your logic. Never hardcode a key, token, or production URL.
- **Determinism.** Control time, randomness and ordering. Inject the clock, seed the RNG, freeze time. SLA and calendar work makes this non-optional.
- **Constructed data.** Use the factories in `backend/test/kit`, not inline literals copy-pasted between files.
- **Arrange, act, assert.** One logical behaviour per test, with a name that states the expected behaviour.
- **Meaningful assertions.** Assert the effect, not that a function was called.
- **Test the contract, not the implementation.** If a behaviour-preserving refactor breaks the test, the test was too coupled.
- **No real client names in fixtures.** The seed uses fictional accounts.

## The layers (and where each lives)

| Layer | Tool | Where | What it proves |
|---|---|---|---|
| Static | ESLint, `tsc --noEmit`, Prettier check | all packages | No suppressed errors. `ignoreBuildErrors` and `ignoreDuringBuilds` are forbidden by a lint rule on the Next config |
| Domain unit | Jest | `backend/src/**/*.spec.ts` | State machine transitions, priority matrix, SLA business-minute math on calendars, pause accounting, breach latching, burn-down, capacity, rate snapshotting, period locking, loop detection, header threading, signature stripping |
| Data layer integration | Jest + Testcontainers PostgreSQL | `backend/test/db/**` | Migrations apply from empty; RLS denies cross-account reads and writes; append-only triggers reject updates and deletes; locked periods reject writes |
| HTTP | Jest + supertest | `backend/test/http/**` | Every route rejects anonymous and garbage tokens; portal tokens cannot reach operator routes; no grant means 404; DTO validation; controllers are thin |
| Worker | Jest | `backend/src/worker/src/**/*.spec.ts` | Outbox dispatch idempotency, inbox deduplication, retry classification, DLQ routing, connector contract tests against recorded fixtures, email parsing corpus |
| Axel adapter contract | Jest + recorded fixtures | `backend/test/axel/**` | Request shapes sent to the harness, per-account switch enforcement (no call when AI is off), suggestion persistence, HITL transitions, confidence withholding |
| Web unit | **Vitest** | `frontend/**/*.test.ts(x)` | Pure logic (SLA display math, condition builder serialisation, form validation) and component behaviour with Testing Library |
| End to end | Playwright | `frontend/e2e/**` | Golden paths against a seeded environment |
| Load | k6 | `load/**` | Queue list at 50k tickets per account under 500ms p95 |

Note the split: the backend is **Jest**, the web app is **Vitest**. Do not reach for Jest in `frontend/`.

## The isolation suite (mandatory from Phase 1)

Generated from the schema. For every table with an `account_id` column it creates two accounts and one row each, then asserts, under a session bound to account A, that: select returns only A's row; update and delete of B's row affect zero rows; insert with B's account id is rejected; and a join through any foreign key cannot reach B. It also runs with the portal database role to prove the tighter policy.

**Any account-scoped table missing from the suite fails the build** via a schema-introspection check. So when you add a table, you do not hand-write its isolation test, you make sure the generator sees it. See `secure-endpoint-auth` for the endpoint-side companion tests.

## The test kit

`backend/test/kit` holds the shared machinery, and you should extend it rather than re-inventing per suite:

- Factories: `anAccount()`, `aUser({ kind })`, `aTicket({ type, state })`, `aContract({ model })`, `aTimeEntry()`.
- A Testcontainers Postgres harness with migrations applied once per run and a transactional rollback per test.
- Stubs for SES, S3, SQS and the Axel adapter.
- An email corpus (Outlook, Gmail, Apple Mail, ServiceNow notification, out-of-office, bounce, loop) and a ServiceNow payload corpus from the stand-in.

`seed:dev` builds two accounts with contrasting calendars (UK and Australia), one internal team across three groups, contracts of each model, 200 tickets across all states, articles at each visibility, and a ServiceNow stand-in. It backs e2e and demos.

## Coverage

A floor, not a target: **80 percent lines** on API domain services and worker handlers. **100 percent branch** on the state machine, SLA engine, isolation, period locking and loop prevention, because a miss there is a client-visible incident. Chasing a percentage on trivial getters proves nothing.

## Anti-patterns

- `toHaveBeenCalled` standing in for behaviour. Assert the effect.
- Snapshot-testing everything. Snapshots rot into "press update" and catch nothing.
- Mocking so much that you test the mock.
- "Should be defined" scaffolding specs.
- Testing the framework (NestJS DI, Drizzle) instead of your rules.

## The gate

The XMS pipeline runs the gates before it builds an image, in this order: install with a frozen pnpm lockfile; lint, format check and `tsc --noEmit`; unit tests; data layer and HTTP integration against Testcontainers; isolation suite and schema check; build; deploy to dev, then Playwright and ZAP. **A red step stops the pipeline and there is no flag to skip a gate.**

Write the test with the change, in the same pull request. When fixing a bug, add the failing test first, then make it pass. Run `pre-pr-quality-check` in the app you changed before opening the PR.

## Checkpoints

- Is the behaviour tested at the lowest layer that exercises it?
- Is the test deterministic (clock and randomness injected) and free of live credentials?
- Does it use the `backend/test/kit` factories rather than inline literals?
- Did a new account-scoped table get picked up by the isolation suite?
- For web work, is it Vitest in `frontend/`, not Jest?
- Do the branch-critical areas (state machine, SLA, isolation, period locking, loop prevention) stay at full branch coverage?
- Would this test fail if the bug it guards were reintroduced?
