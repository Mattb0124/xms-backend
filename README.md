# backend (`xms-api` and `xms-worker`)

The NestJS application for XMS. One codebase, two entrypoints and two images: the API (`src/main.ts`) and the worker (`src/worker/main.ts`), so every business rule exists once (ADR-08). This file describes what is built; the specification that governs it lives one level up (`../01-architecture`, `../02-modules`), the day-by-day record in `../03-delivery/TODO.md` and the as-built summary in `../03-delivery/WHAT-WAS-DONE.md`.

## Run it locally

```
pnpm install
pnpm db:up            # PostgreSQL 16 with pgvector on port 5433, MailHog on 8025
cp .env.example .env  # fill DATABASE_URL_* and BOOTSTRAP_ADMIN_EMAILS
pnpm db:migrate       # applies src/db/migrations/*.sql with the migrator role
pnpm seed:dev         # roles, defaults, team, two accounts, 200 tickets (SEED_TICKETS=20 for a small set)
pnpm standin          # a local ServiceNow stand-in on 3005 (basic xms.integration / stand-in) with one seeded case
# SEED_SERVICENOW_URL=http://127.0.0.1:3005 pnpm seed:dev also creates a Brookfield connector instance in ingest-only mode
pnpm dev:token --email admin@example.test   # a development bearer token (refused in production)
pnpm start:dev        # API on 3001, Swagger at /docs
pnpm start:worker:dev # jobs and the outbox dispatcher
```

Quality gates, all of which must be green before a push (the pipelines do not run them for you):

```
pnpm lint             # oxlint
pnpm typecheck        # tsc --noEmit
pnpm test             # unit (Vitest): domain rules, parsers, logging
pnpm test:int         # integration over a Testcontainers PostgreSQL (needs Docker)
pnpm test:e2e         # auth, routes and the harness contract; UPDATE_SNAPSHOT=1 refreshes test/golden/routes.json
pnpm test:all
```

## Layout

```
src/main.ts            API entrypoint: helmet, request context, pino access log, versioning (/v1), validation, Swagger
src/worker/            worker entrypoint, outbox dispatcher (SKIP LOCKED, dead letters), leased jobs (SLA sweeper, at-risk, snapshots, AI intake and expiry, digests)
src/db/                pool per role, session binding (set_config xms.account_ids), unit of work, repository base, migrate runner, migrations 0001 to 0011
src/domain/            pure rules: state machines, priority matrix, SLA engine, close discipline, burn math, measures, email matching and stripping, AI redaction and SSE parsing
src/contracts/         permission catalog, event catalog, AI capability contract (shared with the web client)
src/common/            auth (token verifiers, guard, principal resolution, route table), audit writer, security events, outbox writer, storage and mail adapters, logging
src/modules/           one feature module per spec module: admin, contracts, tickets, portal, telemetry, time, knowledge, attachments, email, reporting, ai, integrity, security, connectors, roster, calendars, migration
src/config/            environment contract (zod) and the seed catalogs (state machines, priority matrix, SLA policy, activity types, billable classes, resolution codes, ai)
src/tools/             seed, dev-token
test/kit/              database and fixture helpers, constructed identities, the in-process harness, the email corpus
test/isolation/        the generated cross-account suite over every account-scoped table
test/golden/           the route-and-permission snapshot
```

Every feature module is split into a `*CoreModule` (providers the worker imports) and the HTTP module that adds controllers, so the worker mounts nothing but the health endpoints.

## Conventions that matter

- **Isolation** is a database property: every account-scoped table has forced row-level security bound to `xms.account_ids`; the portal role is read-only and column-granted; the `sys.apply_account_isolation` helper installs the standard policies and the isolation suite introspects the catalog so a new table cannot escape it.
- **Audit** is written inside the transaction of the change; protected tables reject an update without an audit row (`sys.require_audit`); the three event streams are append-only and digested nightly.
- **Routes** declare their permission (`@RequirePermission`) or `@Authenticated()`; the boot check and `test/golden/routes.json` catch a route without one. Portal routes live under `/v1/portal` in their own realm.
- **Database access** goes through repositories; services orchestrate; controllers map DTOs and delegate.
- **Tests** use constructed data, an in-process harness and a Testcontainers database; no live credential or production URL anywhere.
- **Copy** uses no em-dashes and spells "generalization" with a z.

## Deviations from the draft specification

Recorded where they were made, summarised here:

- SQL-first migrations with the `pg` driver instead of Drizzle (0001 onwards).
- Portal writes run on the app role bound to one account; the portal database role stays read-only (`UnitOfWork.portalWrite`).
- Mail templates are typed HTML functions, not MJML.
- Harness session tokens are minted locally with the shared `HARNESS_SESSION_SECRET`; the Clerk exchange cannot cross two Clerk applications (`src/modules/ai/session-token.service.ts`).
- Duplicate detection uses trigram similarity until the harness exposes embeddings.
- Worker AI intake runs as a synthetic `axel-service` principal; the seed creates the matching service user.
- The event archive is the digest chain and its verification; the Parquet export and Athena wait for the AWS environment.
