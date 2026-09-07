## What and why

<!-- One paragraph. Link the Implementation Plan item (P<phase>.<sprint>.<n>) and the spec section. -->

Item: P
Spec:

## Threat note

<!-- What could this change break for isolation, visibility, realm, evidence or egress, and why it does not. -->

## Security definition of done (xms-security-first, ADR-16)

An unticked box blocks the merge.

- [ ] Isolation: new account-scoped tables ship with `account_id NOT NULL`, forced RLS and both policies in the same migration; ids from clients are asserted in-account under RLS; the session binding lives only in the repository base
- [ ] Visibility: portal role grants reviewed; no internal field reaches portal, email, sync, report or log; templates and exports reference client-visible view models only
- [ ] Realm: routes in the right controller group; permission declared or `@Public(reason)`; the route-and-permission snapshot updated in this PR
- [ ] Evidence: audit event in the same transaction as every mutation; security events for guard decisions, admin changes, exports, downloads and AI egress
- [ ] Egress: account settings and redaction applied on every path that leaves the boundary (email, connector, harness, export, log)
- [ ] Inputs: DTO validation through the global pipe, size limits, untrusted parsing, verified signatures, scan gating on downloads
- [ ] Secrets: none in code, config, logs, images or fixtures; environment read only through `config/env.ts`
- [ ] Tests from the skill's section 3 present (isolation suite count noted if a table was added); `pnpm check` and `pnpm test:e2e` green
- [ ] Data layer: every query in a repository; controllers thin (DTO map, one service call)

## Migration notes

<!-- Expand, migrate, contract: can the previous API version run against this schema? -->
