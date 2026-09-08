-- 0043 Webhook administration from the console (Integrations functional 5.2
-- and 5.4: the subscription record shows delivery health and lets the owner
-- replay from the console). Two changes the console needs and the API client
-- routes never did.
--
-- 1. An operator pause records why, in words. `paused_reason` is a closed
--    vocabulary the worker writes ('continuous_failure', 'client_revoked')
--    and must stay closed so a screen can read it, so the person's sentence
--    lives beside it rather than widening it.
-- 2. A replayed dead letter is one more attempt on the same event. The
--    original check stopped at the five attempts the retry ladder uses, so
--    a replay of a dead letter could not be recorded at all. The floor
--    stays; the ceiling is the ladder's own MAX_ATTEMPTS, in code.
alter table acct.webhook_subscriptions add column paused_note text;

alter table acct.webhook_deliveries drop constraint webhook_deliveries_attempt_check;
alter table acct.webhook_deliveries add constraint webhook_deliveries_attempt_check check (attempt >= 1);
