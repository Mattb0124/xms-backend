-- Local development only. In AWS the four roles are created by the RDS
-- bootstrap task (P1.2.1) with secrets from Secrets Manager. The passwords
-- here are deliberately trivial and never used outside docker compose.
-- superuser locally so migrations may install extensions; in RDS the master
-- user installs extensions and xms_migrator owns the schemas.
--
-- That difference is a trap, and it has already cost one bug. Every acct.*
-- table carries FORCE ROW LEVEL SECURITY, which binds the table OWNER too,
-- and the policies name xms_app and xms_worker only. Locally the superuser
-- bypasses all of it; as a plain schema owner in RDS, a migration that writes
-- to an acct.* table matches no policy and updates ZERO ROWS WITH NO ERROR.
-- Migrations 0038, 0052 and 0054 were all written without knowing this and
-- would have been silent no-ops in production while passing every test here.
--
-- xms_migrator does NOT get BYPASSRLS in RDS (Matt, 2026-09-12). That is a
-- deliberate choice and it is the right one: a role that can read every
-- account's rows is exactly what the isolation model exists to prevent, and
-- granting it to make migrations convenient would put the audit answer
-- "nothing can read across accounts" in the wrong. It does mean the local
-- superuser is NOT a faithful stand-in, so the rule below is not optional.
--
-- THE RULE: a migration that writes data to an acct.* table must lift FORCE
-- for the duration and put it back, through sys.begin_account_backfill and
-- sys.end_account_backfill (migration 0055), and must assert its own row
-- count. Anything else is a statement that works here and silently does
-- nothing in production.
create role xms_migrator login password 'xms' superuser;
create role xms_app login password 'xms';
create role xms_worker login password 'xms';
create role xms_portal login password 'xms';
create database xms owner xms_migrator;
