# TODO: Reopen window after Resolved

**Spec:** Email Intake functional §5.3 / §8 question 8; technical matcher order only
**Ticket:** [AIBL-380](https://app.clickup.com/t/1241hmh73qm)
**Status legend:** `[ ]` not started, `[~]` in progress, `[x]` done and verified

---

## 1. Domain window (`xms-backend`, `feature/AIBL-380/reopen-window`)

- [x] `evaluateReopenWindow` math is pure: account days vs type override, `resolved_at` else `closed_at`, working days on the account calendar
- [x] Override `0` never reopens, including the resolve day
- [x] Missing timestamps refuse reopen (fail closed)
- [x] Tests: day 3 yes, day 8 no, holiday extends by one working day, override 0, weekday fallback when there is no calendar

## 2. Storage and config (`xms-backend`, same branch)

- [x] `acct.account_settings.reopen_window_business_days` default 5 (0 to 365), settings PATCH round-trips it
- [x] State-machine body accepts optional `reopen_window_business_days`; `0` is valid
- [x] Closed has a reopen-flagged exit on every seeded type; `validateMachine` allows that and nothing else out of terminal
- [x] Tests: PATCH audit field, change override 0, Closed reopen seeds validate

## 3. Shared gate (`xms-backend`, same branch)

- [x] GET transitions omits reopen past the window and carries `reopen_window`
- [x] POST transition past the window returns typed 409 `reopen_window_elapsed`
- [x] Reopen success writes `ticket.reopen_window_decided` in the same transaction; `ticket.transition` `new_value` stays the state string
- [x] Tests: portal and desk list, 409 body, audit on success

## 4. Inbound branch (`xms-backend`, same branch)

- [x] `closedTooLong` is gone; matcher order is unchanged
- [x] Matched Resolved or Closed inside the window reopens (system actor) and appends the comment
- [x] Outside the window creates a new ticket of the matched type, related link, first comment names the old key and why it was not reopened
- [x] Spawn writes `ticket.reopen_window_decided` on the matched ticket; inbound reopen Activity copy is `reply inside reopen window`
- [x] Tests via `POST /v1/dev/email/inbound` on BRK: day 3, day 8, holiday, Change=0, plus-token (not only subject key)

## 5. Frontend (`xms-frontend`, same ticket)

- [x] Account settings field for business days, default 5
- [x] Portal hides Reopen past the window and shows the refusal sentence
- [x] Desk 409 toast for `reopen_window_elapsed`; Activity renders the reason sentence
- [x] Tests: settings, portal copy, toast, activity row

## 6. Verify

- [x] Day 3 / day 8 / holiday on BRK via `POST /v1/dev/email/inbound` (frozen `received_at`)
- [x] Cancelled inbound still appends; open inbound still appends (existing corpus)
- [x] Desk `stale_version` still wins over a reopen (existing tickets int-spec)
- [ ] Live BRK click-through of the frozen day 3 / day 8 clock (automated above; UI screenshots already cover settings, desk Reopen, portal elapsed)

---

## Decisions locked

- Functional §5.3 wins: window after match, Resolved or Closed. Technical §2.6 subject-key nesting is not followed.
- Matching is not this ticket (Juan / Vinnie).
- 5 business days, account calendar, type override on the state-machine JSON, `0` = never.
- Shared function for inbound, portal, API. 409 `reopen_window_elapsed`. Audit `ticket.reopen_window_decided`.
- Inbound actor `system`. New ticket copies type + account from the matched ticket.

## Blocked / open

- Subject-line matching: Vinnie. Default: leave matcher order as it is.
- Spec page technical §2.6 will be stale until ClickUp is edited; as-built note later, not this slice.
