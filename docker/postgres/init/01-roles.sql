-- Local development only. In AWS the four roles are created by the RDS
-- bootstrap task (P1.2.1) with secrets from Secrets Manager. The passwords
-- here are deliberately trivial and never used outside docker compose.
-- superuser locally so migrations may install extensions; in RDS the master
-- user installs extensions and xms_migrator owns the schemas.
create role xms_migrator login password 'xms' superuser;
create role xms_app login password 'xms';
create role xms_worker login password 'xms';
create role xms_portal login password 'xms';
create database xms owner xms_migrator;
