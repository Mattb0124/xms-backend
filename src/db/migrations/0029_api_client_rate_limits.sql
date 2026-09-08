-- 0029 Per-client rate limits (Integrations technical section 5: "per API
-- client 600 requests per minute default, configurable on the client").
-- The public API is the one surface a single caller can hammer while fully
-- authenticated, so the limit belongs on the client record rather than on
-- an environment variable shared by every integration.

alter table op.api_clients
  add column rate_limit_per_minute integer not null default 600
    check (rate_limit_per_minute between 1 and 100000);
