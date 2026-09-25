-- =============================================================================
-- provision-principals.sql — database principal provisioning (Sprint 5, Seção 19)
-- =============================================================================
--
-- Separation of duties (REV-02):
--   * THIS script only PROVISIONS database users
--     (CREATE USER ... FOR LOGIN ...).
--   * runtime-user.sql / migration-user.sql only AUTHORIZE (GRANT ...).
-- Neither file mixes both concerns anymore.
--
-- Idempotent: each CREATE USER runs only when the principal is absent
-- (DATABASE_PRINCIPAL_ID guard). Safe to re-run.
--
-- Placeholders only: the SQL logins (including their passwords) are
-- provisioned out-of-band by an authorized human and are never stored in
-- this repository (AP-05, AC-07, AC-60). The *_login names below are
-- placeholders that must already exist server-side before this script runs.
--
-- Execution context: run manually against opsdb as a privileged human
-- deployment step, BEFORE runtime-user.sql / migration-user.sql (GRANTs
-- require the principal to exist). Never executed by PR CI.
-- =============================================================================

IF DATABASE_PRINCIPAL_ID(N'marketing_ops_runtime') IS NULL
BEGIN
  CREATE USER [marketing_ops_runtime] FOR LOGIN [marketing_ops_runtime_login];
END;

IF DATABASE_PRINCIPAL_ID(N'marketing_ops_migration') IS NULL
BEGIN
  CREATE USER [marketing_ops_migration] FOR LOGIN [marketing_ops_migration_login];
END;
