# XMS backend (`xms-api` and `xms-worker`)

The NestJS application for XMS (Xelerated Managed Services): one codebase, two entrypoints and two images. `src/main.ts` is the API (`/v1/...`), `src/worker/main.ts` is the worker (outbox dispatch, inbox apply, connectors, SLA sweeper, snapshots, report packs, Axel batch). The specification set lives in the sibling `xms` spec repository (`01-architecture/*.md` and sections 2 to 4 and 8 of every `02-modules/*/TECHNICAL-SPEC.md`); this repository holds only the application.

## Rules that override defaults here

- **Security first (ADR-16).** Load the `xms-security-first` skill before designing, coding or reviewing. Every account-scoped table ships with forced row-level security and both policies in the same migration; the session binding lives only in the repository base; every route declares its permission or a justified `@Public(reason)`; the route-and-permission snapshot changes with it; every mutation writes its audit event in the same transaction; every guard decision writes a security event.
- **Thin controllers, data through the data layer.** Controllers map DTOs and call one service; services orchestrate; repositories own every query. Feature modules are colocated (controller, service, data, dto) under `src/modules/<module>/`, one per spec module.
- **The server is the only author of truth**: SLA due times, breach latches, derived priority, burn-down, capacity and permissions are computed here, never trusted from a client.
- **Global pipes are set once in `main.ts`**: `ValidationPipe` with `whitelist`, `forbidNonWhitelisted`, `transform`; helmet; URI versioning. Do not register per-route pipes to work around them.
- **Environment through `src/config/env.ts` only** (zod, fail fast); no `process.env` reads elsewhere; no secret defaults.
- **Tests are Vitest** (the Nest 12 default): `*.spec.ts` colocated, Testcontainers PostgreSQL for the data layer, the generated isolation suite under `test/isolation`. Build fails on lint or type errors; `pnpm check` is the pre-PR gate.
- No em-dashes in copy or comments.

## Commands

- `pnpm start:dev` (API), `pnpm start:worker:dev` (worker), `pnpm build`
- `pnpm check` runs lint, type-check and unit tests
- `pnpm test`, `pnpm test:e2e`
- `pnpm openapi` writes `openapi.json` for the frontend's generated types

## Layout (planned, per ADR-14)

```
src/main.ts           API entrypoint
src/worker/           worker entrypoint and handlers
src/config/           environment contract
src/common/auth/      Principal, composed guard, permission catalog, decorators
src/domain/           pure rules: state machines, priority matrix, SLA engine, burn-down, capacity, loop detection
src/db/               Drizzle schema, migrations with RLS policies, repository base with session binding
src/contracts/        DTOs, permission catalog, event catalog (OpenAPI source)
src/modules/          one feature module per spec module
src/axel/             the Axel adapter
src/health/           liveness and readiness
test/kit/             factories, Testcontainers harness, stubs, corpora
test/isolation/       the generated cross-account suite
```
