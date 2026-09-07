---
description: 'Run the local lint, format, type-check, unit, integration and isolation gates for the XMS API and worker before opening a pull request, reproducing the pipeline gates so failures are found before review rather than in CI.'
---

# Pre-PR Quality Check (backend)

Run the gates locally before opening a pull request. The XMS pipeline runs lint, type-check, unit, integration and isolation tests **before** it builds an image, and a red step stops the pipeline with no flag to skip a gate (`03-delivery/TEST-STRATEGY.md` §5).

## When to use

- Before creating a pull request in `backend` (the API or the `src/worker` entrypoint).
- After a migration change, which is the most common cause of a late pipeline failure.
- When the pipeline went red and you want to reproduce it locally.

## Steps

### 1. Install

```bash
pnpm install --frozen-lockfile
```

### 2. Lint and format

```bash
pnpm lint
pnpm format:check
```

### 3. Type-check

```bash
pnpm tsc --noEmit
```

### 4. Unit tests

```bash
pnpm jest
```

Domain rules in `src/**/*.spec.ts` and worker handlers in `src/worker/src/**/*.spec.ts`.

### 5. Integration tests (Docker must be running)

```bash
pnpm test:db     # test/db/**   migrations, RLS, append-only triggers, locked periods
pnpm test:http   # test/http/** anonymous, garbage token, realm, grant, DTO validation
```

These use Testcontainers PostgreSQL. If Docker is not running they fail to start, which is not the same as passing.

### 6. Isolation suite and schema check

```bash
pnpm test:isolation
```

Generated from the schema. **If you added an account-scoped table and it is not covered, this fails the build**, which is the intended behaviour, not a bug to work around. Fix the coverage, not the check.

### 7. Build

```bash
pnpm build
```

## The rule that is not negotiable

Suppressing a type or lint error to get a green build violates the Packmind standard "Do Not Suppress Type-Check and Lint Errors in Builds". Fix the error.

## Before you open the PR

- Every gate above passed, not just the ones related to your change.
- New or changed routes declare permissions and ship with the auth tests (`secure-endpoint-auth`).
- New account-scoped tables are covered by the isolation suite.
- Migrations apply from empty, not just as a delta on your local database.
