-- =============================================================================
-- runtime-user.sql — least-privilege runtime account (Sprint 5, Seção 19)
-- AC-61: runtime SQL permissions follow least privilege.
-- AC-62: normal runtime operation requires NO migration privileges (no DDL).
-- REV-02: GRANTs only — principal provisioning lives in
--         provision-principals.sql (separation of duties).
-- =============================================================================
--
-- Scope: DML ONLY on the business tables inside opsdb.
--   - Runs, Schedules, Batches, BatchItems: SELECT, INSERT, UPDATE
--     (the repositories never delete business rows).
--   - Checkpoints, AuditEntries: SELECT, INSERT ONLY (append-only,
--     AC-23 / AC-33 — no UPDATE, no DELETE).
--   - dbo.SchemaMigrations: no grants at all for runtime (the ledger is
--     written exclusively by the migration path).
--   - No DDL grants (CREATE/ALTER/DROP) are ever granted here.
--
-- Prerequisite: the principal [marketing_ops_runtime] must already exist.
-- Create it with provision-principals.sql before running this file.
--
-- Credentials: NONE in this file. The SQL login (including its password)
-- is provisioned out-of-band by an authorized human and is never stored
-- in this repository (AP-05, AC-07, AC-60). Placeholder naming only:
-- [marketing_ops_runtime_login] must already exist before provisioning.
--
-- Execution context: run manually against opsdb as a privileged human
-- deployment step. Never executed by PR CI.
-- =============================================================================

-- Business tables that support updates ----------------------------------------
GRANT SELECT, INSERT, UPDATE ON dbo.Runs TO [marketing_ops_runtime];
GRANT SELECT, INSERT, UPDATE ON dbo.Schedules TO [marketing_ops_runtime];
GRANT SELECT, INSERT, UPDATE ON dbo.Batches TO [marketing_ops_runtime];
GRANT SELECT, INSERT, UPDATE ON dbo.BatchItems TO [marketing_ops_runtime];

-- Append-only tables: reads and appends only ----------------------------------
GRANT SELECT, INSERT ON dbo.Checkpoints TO [marketing_ops_runtime];
GRANT SELECT, INSERT ON dbo.AuditEntries TO [marketing_ops_runtime];

-- Explicitly NOT granted to the runtime account:
--   * any DDL (CREATE/ALTER/DROP)            — AC-62
--   * any DML on dbo.SchemaMigrations        — migration path only
--   * DELETE on any table                    — repositories never delete
--   * cross-database permissions             — AP-01
