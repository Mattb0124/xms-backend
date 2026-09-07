# backend (`xms-api` and the worker)

The NestJS application for XMS. One codebase, two entrypoints and two images: the API (`src/main.ts`) and the worker (`src/worker/main.ts`), so every business rule exists once.

Not scaffolded yet. The specification that governs it:

- System shape and request flows: `../01-architecture/ARCHITECTURE.md`
- Schemas, isolation mechanics, table catalog: `../01-architecture/DATA-MODEL.md`
- Identity, authorisation, isolation, audit: `../01-architecture/SECURITY-AND-TENANCY.md`
- Connector framework (outbox, inbox, DLQ, replay, kill switch): `../01-architecture/INTEGRATION-PATTERNS.md`
- Axel adapter: `../01-architecture/AI-INTEGRATION.md`
- Per-module data model, services, routes, worker jobs and tests: sections 2 to 4 and 8 of every `../02-modules/*/TECHNICAL-SPEC.md`

Planned layout (ADR-12, ADR-14):

```
backend/
  src/main.ts          API entrypoint
  src/worker/          worker entrypoint: outbox dispatcher, inbox apply, connectors, SLA sweeper, snapshots, report packs, Axel batch
  src/domain/          pure rules: state machines, priority matrix, SLA engine on calendars, burn-down, capacity, loop detection, thread matching
  src/db/              Drizzle schema, SQL migrations with RLS policies, repository base with session binding
  src/contracts/       DTOs, permission catalog, OpenAPI source for the frontend types
  src/modules/         one NestJS feature module per spec module (controller, service, data, dto colocated)
  src/axel/            the Axel adapter (interactive, single-shot, batch faces)
  test/kit/            factories, Testcontainers PostgreSQL harness, stubs (SES, S3, SQS, harness), email and ServiceNow corpora
  test/isolation/      the generated cross-account suite
```

Stack: NestJS, TypeScript, Drizzle, PostgreSQL 16 with pgvector, class-validator with a global ValidationPipe, Jest, supertest, Testcontainers. Build fails on lint or type errors.
