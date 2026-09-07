---
name: 'secure-endpoint-auth'
description: 'Enforce authentication, permissions and account scoping on every XMS API route and PROVE it with tests that reject anonymous, garbage and wrong-realm tokens. Use whenever adding or reviewing a NestJS controller in backend, wiring a new route group, adding a portal route, accepting a machine identity (API client, harness session token, ServiceNow webhook), or when a task says "protect this endpoint", "require auth", "is this authenticated", "can the portal see this". Covers the single Principal resolver, the global permission guard and its @Public() opt-out, the portal versus internal realm split, account scoping through row-level security, and the test recipes that pin each layer.'
---

# Skill: Secure Endpoint Auth

XMS resolves identity **once**, in one guard, and every route declares what it needs. The rule is mechanical: **every route resolves a `Principal`, declares its permissions, scopes to an account set it did not take from the client, and ships with tests that prove all three.** Authority for everything here is `01-architecture/SECURITY-AND-TENANCY.md` §2 to §4 and `03-delivery/TEST-STRATEGY.md` §2 to §3.

This is a rewrite of the AIX approach, not a port of it. The AIX failure modes the XMS design deliberately corrects are called out below so you do not reintroduce them.

## The `Principal` (one resolver, fail closed)

A single guard resolves one `Principal` per request (§2.2):

| Field | Source |
|---|---|
| `kind` | `internal`, `portal`, `api_client`, `harness` |
| `userId` | Clerk `sub` mapped to `op.users.id`; API clients and the harness map to a service user |
| `accountIds` | Internal: `op.account_grants`. Portal: exactly the account of the organisation in `org_slug`. API client: its grants |
| `permissions` | Transitive closure of role assignments plus global grants |

Non-negotiables:

- **There is no `x-tenant-slug` header and no `default` fallback.** A token without the claim gets 401. Never read tenancy from a header, a query param, or a body field.
- **Verify once.** The guard is the only place that validates the token, with `authorizedParties` set to the XMS hosts and `CLERK_JWT_CLOCK_SKEW_MS = 60_000`.
- **Realm is enforced, not implied.** Portal tokens are accepted only by routes in the portal controller group. An internal route that receives a portal token returns **403 regardless of permissions**.
- The long-lived `agents` token carries a distinct `aud` claim and is accepted **only on the Axel adapter routes**. Startup fails loudly if the template is missing.

## Authorisation rules

- **Global permission guard with an explicit `@Public()` opt-out.** Every route declares its permissions or is rejected at startup by the route-table test. `@Public()` is for genuinely unauthenticated surfaces only, never for a data endpoint.
- **The catalog lives in `backend/src/contracts`** and is shared with the web app. Two catalogs: operator (`tickets:view`, `tickets:work`, `tickets:resolve`, `time:log`, `time:adjust`, `time:lock-period`, `contracts:manage`, `capacity:manage`, `reports:view-portfolio`, `admin:accounts`, `admin:users`, `admin:config`, `admin:connectors`, `ai:use`, `ai:configure`, `kb:author`, `kb:publish`) and portal (`portal:submit`, `portal:view-org-tickets`, `portal:comment`, `portal:view-consumption`, `portal:manage-users`, `portal:kb`). **Unknown keys fail the build.**
- **Implications are transitive.** Do not hand-roll a one-level expansion.
- **Role assignments live in PostgreSQL only** (`op.role_assignments`), never in Clerk metadata.
- **Record-level rules** (own time entries only, an approver cannot approve their own out-of-scope flag) belong in the domain services and are unit-tested there, not in the controller.

## Account scoping is the data layer's job

Do not filter by account in a controller or in a service query. The chain (§4):

1. The guard produces a closed `accountIds` set.
2. The data layer binds `xms.account_ids` (or `xms.account_id` for portal) with `SET LOCAL`. **A connection without the setting sees nothing.**
3. `FORCE ROW LEVEL SECURITY` on every account-scoped table, `WITH CHECK` on writes.
4. The portal database role holds no grant at all on `acct.work_notes`, `acct.time_entries`, `acct.rate_cards`, `acct.ai_suggestions`, `acct.audit_events`. It reads the filtered `acct.ticket_timeline_public` view.

Consequences for your endpoint: **never accept an account id from the client**, stamp child rows from the parent server-side, and let a row the principal cannot reach surface as **404, not 403** (a consultant without a grant must not learn the account exists).

## Machine identities

| Caller | Credential | Rule |
|---|---|---|
| Worker | None. It uses the domain packages and the database directly as `xms_worker`, binding `xms.account_ids` for the job it claimed | Do not add an internal HTTP hop or a shared secret |
| Harness and XMS MCP | HS256 session token validated with `SESSION_SECRET`, with the `type == "session"` check mirrored | Maps `sub` to the XMS user |
| API clients | Prefix `xms_live_`, SHA-256 lookup hash unique-indexed plus bcrypt confirmation, scopes, account grants, expiry, last used | Never an O(n) bcrypt scan; keys are owned by the operator, not by a person |
| ServiceNow webhooks | Per-instance HMAC verified in the worker before the inbox write | Constant-time compare, fail closed when unconfigured |

## The test recipes (ship them WITH the endpoint)

Per `03-delivery/TEST-STRATEGY.md` §2, these live in `backend/test/http/**` with Jest and supertest:

1. **Route-table test.** Every route declares permissions or `@Public()`, and an undeclared route fails at startup. This is what stops the next open endpoint from shipping unnoticed.
2. **Anonymous and garbage token probe.** Representative routes return 401 with no token and with a malformed bearer. Pin any dev bypass to off inside the test rather than trusting the environment.
3. **Realm test.** A portal token against an operator route returns 403.
4. **Grant test.** An internal token with no grant on account B gets **404** on B's data, not 403 and not rows.
5. **Isolation suite** (§3) covers the table itself. It is generated from the schema, and any account-scoped table missing from it **fails the build**. Do not hand-write what the generator already covers.

## Steps

1. Put the route in the correct controller group (operator or portal). The group is what decides which realm may reach it.
2. Declare permissions from the catalog in `backend/src/contracts`. If no key fits, add it to the catalog first.
3. Keep the controller thin: validate, call one service, map the result. No account filtering, no business rules.
4. Take the account set from the `Principal`, never from the request.
5. Write the tests above alongside the endpoint, in the same change.
6. Confirm the DTO is covered by the global `ValidationPipe` contract (`whitelist`, `forbidNonWhitelisted`, `transform`).

## Checkpoints

- Does the route declare permissions, with no `@Public()` on a data endpoint?
- Is the account set taken only from the `Principal`, with no client-supplied account id?
- Does a cross-account id return 404, not 403 and not data?
- Is a portal token rejected with 403 on operator routes?
- Do the anonymous, garbage-token, realm and grant tests exist, and do they fail if the guard is removed?
- Is any new account-scoped table picked up by the generated isolation suite?
- Did you avoid a second token verification, a tenancy header, and any `default` tenant sentinel?
