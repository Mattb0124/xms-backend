---
name: xms-security-first
description: The security definition of done for every XMS change. Use before designing, coding, reviewing or merging anything in frontend/, backend/, infra/ or xms_mcp, when a task says "add an endpoint", "add a table", "add a screen", "add a job", "add a connector", "add a setting", when reviewing a pull request, when answering a client security questionnaire, and whenever a change touches identity, permissions, account data, files, email, external systems, AI egress, secrets, logging or configuration. XMS holds several clients' data in one product and must pass ISO 27001, SOC 2 and client security audits; this skill is how every change is made audit-ready by construction.
---

# Skill: XMS security first

XMS is built to pass security audits, not to be patched after them. Every change is designed, written, tested and reviewed against this checklist, and every control leaves evidence that an auditor can pull without asking an engineer. The architecture documents that back this skill: `01-architecture/SECURITY-AND-TENANCY.md`, `01-architecture/SECURITY-ASSURANCE.md`, `01-architecture/AUDIT-AND-ANALYTICS.md`, `01-architecture/DATA-MODEL.md` section 3. This skill lives in the repo root and in both apps (`frontend/.claude/skills`, `backend/.claude/skills`, with `.cursor` mirrors); edit the root copy and re-copy.

## 1. The five failures every change is checked against

| Failure | The question to ask of the change |
|---|---|
| Isolation | Can any path let one account read, write, search or infer another account's data? |
| Visibility | Can an internal artefact (work note, rate, internal attachment, AI suggestion, audit row) reach a portal user, an email, a sync, a report or a log? |
| Realm | Can a portal identity reach an internal surface, or an internal token be used where a service credential was expected? |
| Evidence | Does the change write the audit, security and usage events that let us prove afterwards what happened and who did it? |
| Egress | Does any data leave the boundary (email, connector, harness, export, log, error report) without the account's settings and redaction being applied? |

If the answer to any question is "maybe", the change is not done.

## 2. Non-negotiable controls by layer

### Data layer (`backend/src/db`)
- Every account-scoped table has `account_id NOT NULL`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, the operator and portal policies with `USING` and `WITH CHECK`, created in the same migration as the table.
- No cross-account foreign key; shared data uses explicit visibility tables and `SECURITY DEFINER` boolean functions.
- Append-only tables keep their raise-on-update-or-delete trigger; never "temporarily" drop it.
- The session binding (`SET LOCAL xms.account_ids` or `xms.account_id`) happens only in the repository base; no raw connection use anywhere else.
- Portal role grants are explicit; a new table gets no portal grant unless the spec says so.
- Secrets never in rows; Secrets Manager names only.

### API (`backend/src`)
- Every route declares its permission or `@Public()` with a reason; the route-and-permission snapshot must change in the same pull request.
- Principal resolution is the single guard; no handler reads headers for identity or account; no `default` fallbacks.
- Realm separation: portal routes only under the portal controller group; portal tokens rejected elsewhere with 403; internal tokens rejected on portal routes.
- DTOs validated by the global pipe (`whitelist`, `forbidNonWhitelisted`, `transform`); ids from the client are asserted in-account under RLS before use.
- Optimistic `version` on mutable rows; typed 409s; idempotency key on POSTs that create.
- Every mutation writes its audit event in the same transaction and the outbox row where anything downstream must know.
- Security events for every guard decision, admin change, export, download and AI egress.
- Errors carry codes, never stack traces or internal names, to clients.

### Worker (`backend/src/worker`)
- Jobs claim work with `SKIP LOCKED` or SQS; every job binds the account context before touching account data.
- Inbound payloads (email, webhooks, ServiceNow, imports) are untrusted: parsed with limits, size-capped, stored raw under the account prefix, deduplicated by external id, never executed or rendered as HTML without sanitising.
- Webhook signatures verified with constant-time comparison; unsigned or unconfigured means reject.
- Outbound calls carry only client-visible fields (typed view models); templates cannot reference internal types.
- Retries are classified; poison goes to the DLQ with an alarm; replay is an audited admin action.

### Frontend (`frontend/`)
- No authorisation decisions in the browser; UI gating mirrors the server and fails closed while loading.
- No secrets, no server-only variables in `NEXT_PUBLIC_*`; CSP enforced; no `dangerouslySetInnerHTML` without a sanitiser and a review comment.
- Portal route group renders only the portal view models; no import from internal components that could leak fields.
- Telemetry carries identifiers and structured facts only; never ticket, email or article text.
- Downloads and uploads go through presigned URLs minted by the API after an RLS-protected read.

### Infrastructure (`infra/`)
- Everything in Terraform; no console changes; `terraform plan` on pull request.
- Least-privilege task roles per service (API, worker, MCP, migrator); no wildcard IAM.
- Buckets private, versioned, account-prefixed policies, Object Lock for the event archive; queues with DLQs; RDS encrypted, Multi-AZ in prod, no public access; WAF on the portal.
- Secrets in Secrets Manager referenced by the task definition; rotation runbook.
- Logs and traces retained per policy; alarms for the signals in `AUDIT-AND-ANALYTICS.md` section 7.3.

### AI (`backend/src/axel`, `xms_mcp`)
- One egress: the adapter. Pre-flight checks the account switch, the capability opt-in and the caller's permission before any request.
- Redaction before egress; attachments never leave as binaries.
- MCP tools run as the caller (forwarded bearer), never as a service identity with broad grants; write tools only propose, except the two audited exceptions.
- Every suggestion, decision and turn is audited with model, prompt version and confidence.

## 3. Tests that must exist before merge

| Change | Required test |
|---|---|
| New account-scoped table | Appears in the generated isolation suite (both roles) automatically; the pull request shows the suite count increasing |
| New route | Auth rejection cases (anonymous, garbage token, wrong realm, missing grant), permission denial, and the snapshot update |
| New mutation | Audit event asserted in the same transaction; optimistic version 409; idempotency where applicable |
| New portal surface | A test that inserts a work note, an internal attachment and an AI suggestion and asserts none is returned |
| New inbound parser | Corpus test including malformed, oversized and hostile samples |
| New outbound template or export | Compile-time type check that only client-visible view models are referenced; a test that a work note cannot appear |
| New worker job | Idempotency under redelivery; DLQ on poison; account binding asserted |
| New Terraform | Plan reviewed; policy check (no public bucket, no wildcard IAM, encryption on) |
| New AI capability | Switch-off test (no HTTP call), threshold withhold test, audit linkage test |

## 4. Pull request checklist (paste into the description)

```
Security definition of done
- [ ] Isolation: new tables have RLS + policies in the same migration; ids from clients asserted in-account
- [ ] Visibility: portal role grants reviewed; no internal field reaches portal, email, sync, report or log
- [ ] Realm: routes in the right controller group; permission declared; snapshot updated
- [ ] Evidence: audit event in the transaction; security events for decisions; usage events for screens/actions
- [ ] Egress: redaction and account settings applied on every path that leaves the boundary
- [ ] Inputs: DTO validation, size limits, untrusted parsing, signature checks
- [ ] Secrets: none in code, config, logs, images or NEXT_PUBLIC_*
- [ ] Tests from section 3 present and green; isolation suite count noted
- [ ] Threat note: one paragraph on what this change could break and why it does not
```

A pull request without the checklist is not reviewed. A checklist with an unticked box is not merged.

## 5. Forbidden patterns (these were found in AIX and must not recur)

- Optional tenant or account parameters on data-layer methods; `'default'` fallbacks; header-driven tenancy.
- Permission checks computed only in the browser (the XMS POC exposed admin routes this way).
- Long-lived tokens accepted on every route; token verification without `authorizedParties`; verifying the same token three times.
- API keys without scopes or with linear bcrypt scans; user-owned service keys.
- Presigned PUT without size limits; no antivirus; downloads served before the scan result.
- Hand-rolled tokens or crypto; default secrets in code; personal email addresses as senders.
- Static health checks; build flags that suppress type or lint errors; pipelines without gates.
- Catch-all retry interceptors that inject business services; fire-and-forget notifications with no dead letter.

## 6. Evidence you must leave (for the auditors)

Every control above produces one of these artefacts, and the change must not break their production: the isolation suite report from the pipeline, the route-and-permission snapshot file, the migration files with policies, `sys.security_events` rows, `acct.audit_events` rows, the nightly digest in the Object Lock bucket, the Terraform state and plan output, the alarm definitions, the runbooks with rehearsal dates, and the ZAP and dependency-audit reports. `SECURITY-ASSURANCE.md` maps each to the audit control it satisfies.

## 7. Steps when you pick up a task

1. Read the spec section the task names and the five questions in section 1; write the threat note first.
2. Design the control before the feature: which policy, which permission, which event, which redaction.
3. Write the tests from section 3, then the code.
4. Run `pre-pr-quality-check`; confirm the isolation suite and the snapshot changed as expected.
5. Paste and complete the checklist in section 4; request review from the stream owner and, for identity, isolation, egress or infrastructure changes, from Matt.

## Checkpoints

- Could an auditor reconstruct who did what from the events this change writes?
- Could a portal user, with a crafted request, reach anything internal through this change?
- Does the change add any way for data to leave the boundary without redaction and the account switch?
- Is every new secret, role, bucket, queue or policy in Terraform and least-privilege?
- Are the tests present, and did the isolation suite and snapshot move in the pull request?
