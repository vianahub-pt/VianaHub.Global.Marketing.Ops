-- =============================================================================
-- migration-user.sql — migration account (Sprint 5, Seção 19)
-- AC-62: migration privileges are separate from runtime; normal runtime
--        operation never requires any of the grants below.
-- AC-61: the runtime account (runtime-user.sql) must keep receiving no DDL.
-- REV-02: GRANTs only — principal provisioning lives in
--         provision-principals.sql (separation of duties).
-- =============================================================================
--
-- Scope: the DDL needed to apply versioned migrations inside opsdb, plus
-- SELECT/INSERT on the ledger so the migration runner can verify and record
-- applied migrations transactionally (AC-11).
--
--   - GRANT CREATE TABLE / ALTER ON SCHEMA::dbo: enough to create and
--     evolve tables by migration; no server-level admin rights.
--   - dbo.SchemaMigrations: SELECT + INSERT only (applied migrations are
--     never rewritten — the ledger is append-only).
--
-- Prerequisite: the principal [marketing_ops_migration] must already exist.
-- Create it with provision-principals.sql before running this file.
--
-- Credentials: NONE in this file. The SQL login (including its password)
-- is provisioned out-of-band by an authorized human and is never stored
-- in this repository (AP-05, AC-07, AC-60). Placeholder naming only:
-- [marketing_ops_migration_login] must already exist before provisioning.
--
-- Execution context: run manually against opsdb as a privileged human
-- deployment step, immediately before/with a controlled migration run.
-- Never executed by PR CI (AP-04, AC-13).
-- =============================================================================

-- DDL required by versioned migrations ----------------------------------------
GRANT CREATE TABLE TO [marketing_ops_migration];
GRANT ALTER ON SCHEMA::dbo TO [marketing_ops_migration];

-- Migration ledger (append + verification only) --------------------------------
GRANT SELECT, INSERT ON dbo.SchemaMigrations TO [marketing_ops_migration];

-- Explicitly NOT granted here:
--   * server-admin or database-owner roles  — least privilege (AC-61)
--   * DELETE/UPDATE on dbo.SchemaMigrations — applied migrations are immutable
--   * cross-database permissions            — AP-01
--
-- The runtime account must NOT receive any of these grants (AC-62).
