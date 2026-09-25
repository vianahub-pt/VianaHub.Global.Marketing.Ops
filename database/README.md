# database/ — SQL Server artifacts (Sprint 5)

## Purpose

This directory holds the versioned, reviewable SQL Server artifacts for
VianaHub.Global.Marketing.Ops:

- `migrations/` — versioned schema migrations applied to `opsdb`
  (currently `001_initial_schema.sql`).
- `privileges/` — least-privilege SQL user scripts for runtime and
  migration contexts.

No file in this directory contains credentials, connection strings,
passwords or any secret value. Configuration names and placeholders live
in `.env.example` only.

## AP-01 — Bounded database ownership

`opsdb` belongs to VianaHub.Global.Marketing.Ops alone (spec Section 2,
AP-01). All objects created by these migrations live inside `opsdb`:

- No cross-database foreign keys.
- No cross-database queries, views, synonyms or stored procedures.
- No runtime dependency on any other application database.

Future integration with other databases requires a separate, explicitly
authorized integration contract.

## Controlled deployment / migration procedure (Section 6, AC-10..AC-13)

Schema changes to production `opsdb` are **human-controlled**:

1. Review the new migration file (`NNN_name.sql`, contiguous 1-based
   versions) together with this procedure.
2. Back up `opsdb` according to the operational runbook before applying
   any migration.
3. Apply pending migrations **explicitly** through
   `automation/adapters/sql/migration-runner.ts` with the approval flag
   `apply=true`, run deliberately by an authorized human. Without the
   explicit flag the runner refuses to apply anything and reports the
   pending versions.
4. The runner records every successful application (version, name,
   sha256 checksum, timestamp) in `dbo.SchemaMigrations` in the **same
   transaction** as the script (AC-11).
5. Verify the ledger: `SELECT Version, Name, Checksum, AppliedAt FROM
   dbo.SchemaMigrations ORDER BY Version`.
6. Re-running an already recorded migration is a safe no-op (AC-12).
   An applied migration file must never be rewritten: the runner fails
   loudly on checksum mismatch. Fix problems with a **new forward
   migration**, never by editing applied files.

Failures are loud and non-destructive: a failing migration rolls back
its transaction (including its ledger row), and partial or incompatible
ledger state halts the runner for human reconciliation. Migrations never
drop or truncate production data automatically.

### PR CI isolation (AP-04, AC-13, HUMAN-06)

- Ordinary pull-request CI **never** migrates or mutates production
  `opsdb`.
- The migration approval flag is never set in PR CI; the five standard
  CI checks do not require any SQL Server availability.
- `ci.yml` remains untouched by this sprint's migration machinery.

## Privileges (Section 19, AC-61, AC-62)

Provisioning and authorization are separate steps (REV-02):

- `privileges/provision-principals.sql` — **provisions** the database
  users (`CREATE USER ... FOR LOGIN ...` from out-of-band login
  placeholders). Idempotent; run once per environment, before the
  grant scripts.
- `privileges/runtime-user.sql` — **grants only**: DML on business
  tables (least privilege). No DDL, no ledger access.
- `privileges/migration-user.sql` — **grants only**: DDL required to
  apply migrations plus ledger access. Normal runtime operation does
  **not** require any migration privilege (AC-62).

Execution order: `provision-principals.sql` first (the principal must
exist), then `runtime-user.sql` and/or `migration-user.sql`. All three
scripts reference login placeholders provisioned out-of-band by a
human. They never embed passwords or secrets.

## Deploy / Migration Procedure (AC-57)

### Pre-deploy

1. Verify the migration file exists in `database/migrations/` with a
   contiguous 1-based version number (e.g., `001_initial_schema.sql`).
2. Back up `opsdb` according to the operational runbook before applying
   any migration.
3. Verify the migration-user credentials are provisioned
   (`database/privileges/provision-principals.sql` +
   `database/privileges/migration-user.sql`). The runtime user does NOT
   need migration privileges (AC-62).

### Applying migrations

4. Run `migration-runner.ts` with the explicit approval flag
   `apply=true`. Without the flag the runner refuses to apply anything
   and reports the pending versions only.
5. The runner applies pending migrations inside a transaction. Each
   successful application (version, name, sha256 checksum, timestamp) is
   recorded in `dbo.SchemaMigrations` in the **same transaction** as the
   DDL script (AC-11).
6. Re-running an already recorded migration is a safe no-op (AC-12).
   An applied migration file must never be rewritten: the runner fails
   loudly on checksum mismatch. Fix problems with a **new forward
   migration**, never by editing applied files.

### Post-deploy verification

7. Verify the migration ledger:

   ```sql
   SELECT Version, Name, Checksum, AppliedAt
   FROM dbo.SchemaMigrations
   ORDER BY Version;
   ```

8. Verify expected table count:

   ```sql
   SELECT TABLE_NAME
   FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = 'dbo'
   ORDER BY TABLE_NAME;
   ```

   Expected tables: `SchemaMigrations`, `Runs`, `Checkpoints`,
   `Schedules`, `Batches`, `BatchItems`, `AuditEntries`.

### Rollback

There is **no automatic rollback**. Failures are loud and
non-destructive: a failing migration rolls back its transaction
(including its ledger row). Partial or incompatible ledger state halts
the runner for human reconciliation. Migrations never drop or truncate
production data automatically.

For destructive rollback scenarios, human intervention is required.
Always back up `opsdb` before applying migrations.

### PR CI isolation (AP-04, AC-13, HUMAN-06)

- Ordinary pull-request CI **never** migrates or mutates production
  `opsdb`.
- The migration approval flag is never set in PR CI; the five standard
  CI checks do not require any SQL Server availability.
- `ci.yml` remains untouched by this sprint's migration machinery.

## Configuration (Section 7)

Connection settings use the existing GitHub configuration names:
`SQL_SERVER_HOST`, `SQL_SERVER_PORT`, `SQL_SERVER_DATABASE` (target:
`opsdb`), `SQL_SERVER_USER`, `SQL_SERVER_PASSWORD`, plus
`PERSISTENCE_PROVIDER=filesystem|sqlserver` (default: `filesystem`,
backward compatible). See `.env.example` for placeholders.

TLS behavior is explicit and fail-closed: `encrypt: true`,
`trustServerCertificate: false`.
