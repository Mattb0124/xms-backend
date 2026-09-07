---
description: 'Scaffold an XMS NestJS feature module with controller, service, data and schema layering, DTOs from the contracts package, account scoping through the data layer, and its tests, so new features match the house shape instead of re-deriving it.'
---

# Create a NestJS Feature Module

Scaffold a new `backend` feature following the house Controller to Service to Data to Schema layering. Two Packmind standards bind this: **thin controllers**, and **database access through the data layer**. XMS uses **Drizzle and PostgreSQL**, not an ODM.

## Checkpoints before you start

- What is the feature name (kebab-case), and does it live in the operator route group or the portal route group?
- Which permissions from the catalog in `src/contracts` does each route require?
- Is the primary entity account-scoped (does its table carry `account_id`)?
- Which pure rules belong in `src/domain` rather than in the service?

## Steps

### 1. Schema (`src/db`)

Add the Drizzle table and a migration. Every account-scoped table carries `account_id` and gets **forced row-level security** with a `WITH CHECK` on writes (ADR-02, `01-architecture/DATA-MODEL.md` §3). A new account-scoped table is automatically picked up by the generated isolation suite, and the build fails if it is not covered.

### 2. Domain (`src/domain`)

Pure rules go here as plain functions and classes with no database and no HTTP: state machine transitions, SLA math, priority derivation, period locking. This is what the worker reuses, which is why the worker is the same codebase and not a separate repository. Unit tests live beside them.

### 3. Data class

Add `<feature>.data.ts`: the only place that touches Drizzle for this feature. It binds tenancy itself with `SET LOCAL` on `xms.account_ids` (or `xms.account_id` for portal). **Tenancy is bound in the data layer, never passed in as an optional parameter.** A connection without the setting sees nothing.

### 4. Service

Add `<feature>.service.ts`: `@Injectable()`, constructor-injected data class, business orchestration, `NotFoundException` on misses, and private mapping helpers to DTOs. Never inject the database client here, and never write a query. Cross-account misses surface as **404, not 403**.

### 5. Contracts (`src/contracts`)

DTOs and permission keys live in `src/contracts`, from which the OpenAPI document and the web client types are generated. Unknown permission keys fail the build. Do not hand-write a matching type in the frontend; it regenerates from here.

### 6. Controller

Thin: validate, call one service method, map the result. Route under `/v1`. Declare permissions on every route, take the account set from the `Principal`, and never accept an account id from the client. See the `secure-endpoint-auth` skill for the full contract and the tests that pin it.

### 7. Tests

Per `03-delivery/TEST-STRATEGY.md`: domain units in `src/**/*.spec.ts`, data-layer integration in `test/db/**` against Testcontainers PostgreSQL, HTTP in `test/http/**` with supertest covering anonymous, garbage-token, realm and grant cases. Use the factories in `test/kit`. See `writing-tests`.

### 8. Wire it

Register the module, then run `pre-pr-quality-check` before opening the pull request.
