# Marketing.Ops Operational Runbook

## Purpose

This runbook is the authoritative operational guide for Sprint 4 recovery and troubleshooting procedures.

Automatic stale/orphan lock deletion is prohibited. Lock remediation requires explicit operator investigation and manual action.

---

## 1. Lock Contention and Potential Orphan Locks

### Safety invariant

The runtime uses fail-closed exclusive lock acquisition.

If a `.lock` file already exists, the application must not infer ownership from PID, file age, timestamps, or other heuristics and must not automatically delete, rename, or replace the lock.

An existing lock must be treated as potentially owned by another running process until an operator verifies otherwise.

### 1.1 Identify the lock

When the application reports `LOCK_CONTENTION`:

1. Record the `runId` from the operational error.
2. Record the lock path reported by the application.
3. Do not delete or rename the lock.
4. Use the read-only orphan-lock diagnostics, when available, to inspect the recorded lock information.
5. Treat PID, timestamps, apparent age, and lock contents as diagnostic evidence only.

### 1.2 Identify the possible owner process

On Windows PowerShell, if the lock diagnostics contain a PID:

```powershell
Get-Process -Id <PID> -ErrorAction SilentlyContinue
```

For additional process information:

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId = <PID>" |
    Select-Object ProcessId, Name, ExecutablePath, CommandLine
```

A matching PID alone does not prove ownership because operating systems can reuse process identifiers.

Confirm that the process belongs to the expected Marketing.Ops execution before taking any remediation action.

### 1.3 Determine whether the lock is genuinely orphaned

A lock may be treated as orphaned only after the operator has established that no active Marketing.Ops process owns or is legitimately using it.

Verify all available evidence:

- the expected Marketing.Ops process is no longer running;
- there is no active execution corresponding to the `runId`;
- no scheduler, batch, recovery or other Marketing.Ops process is currently using the run;
- diagnostic lock information is consistent with an interrupted process;
- removing the lock will not interfere with another active execution.

File age, PID absence, PID mismatch or old timestamps are not sufficient by themselves to authorize deletion.

If ownership remains ambiguous, do not remove the lock.

### 1.4 If the owner is still running

Do not remove, rename or modify the lock.

Investigate the running process and allow it to complete normally.

If the process must be stopped, follow the normal graceful shutdown procedure first. Re-evaluate the lock only after the process has terminated and ownership can be safely determined.

### 1.5 Manual lock removal

Only after the operator has positively determined that the lock is orphaned:

```powershell
Test-Path -LiteralPath "<LOCK_PATH>"
```

Inspect the exact target:

```powershell
Get-Item -LiteralPath "<LOCK_PATH>" |
    Select-Object FullName, Length, CreationTimeUtc, LastWriteTimeUtc
```

Perform one final process/ownership verification.

Then remove only the exact confirmed orphan lock:

```powershell
Remove-Item -LiteralPath "<LOCK_PATH>"
```

Never use wildcard deletion for lock remediation.

### 1.6 Verify safe removal

Confirm that the exact lock no longer exists:

```powershell
Test-Path -LiteralPath "<LOCK_PATH>"
```

Expected result:

```text
False
```

Then retry only the affected operation through the normal Marketing.Ops execution path.

Verify that:

- a new lock can be acquired normally;
- the run does not duplicate previously completed work;
- idempotency is preserved;
- audit and operational events contain no unexpected transition.

If any ownership uncertainty remains, stop and investigate rather than deleting another lock.

---

## 2. Interrupted Run Recovery

Interrupted runs must be handled through the existing recovery semantics.

### Procedure

1. Identify the interrupted `runId`.
2. Inspect its persisted state and audit history.
3. Determine whether the run is eligible for automated recovery.
4. Preserve `waiting_manual` without automatic transition.
5. Preserve non-retryable failures without re-execution.
6. Never bypass CAPTCHA, MFA, verification, authorization or other human-required states.
7. Use the normal recovery mechanism for retryable interrupted runs.
8. Verify the resulting state and audit trail.

If a persisted lock remains after an interruption, follow Section 1. Do not automatically delete the lock as part of recovery.

Repeated recovery execution must preserve idempotency.

---

## 3. Scheduler Troubleshooting

When an expected schedule does not execute:

1. Validate the configured cron expression.
2. Validate the configured timezone.
3. Confirm that the schedule is enabled.
4. Check operational events for schedule evaluation or drift warnings.
5. Check whether overlap prevention skipped execution because a compatible run was already active.
6. Inspect audit entries associated with the `scheduleId`.
7. Verify that the clock and calculated next execution are consistent.
8. Confirm that graceful shutdown is not currently preventing new work from being scheduled.

A skipped overlapping schedule must not be forced into a duplicate execution.

Correct the underlying configuration or operational condition and allow the scheduler to evaluate normally.

---

## 4. Batch Failure Investigation

When a batch reports failed items or `partial_failure`:

1. Record the `batchId`.
2. Inspect each batch item's state independently.
3. Review audit entries and operational events correlated by `batchId` and `runId`.
4. Distinguish retryable failures from permanent/non-retryable failures.
5. Preserve successful items; do not replay the entire batch merely because one item failed.
6. Preserve per-item idempotency keys.
7. Do not automatically retry `waiting_manual` or human-required items.
8. Investigate alerts generated for elevated failure ratios or permanent failures.
9. Retry only items allowed by the existing retry policy.

Batch concurrency must remain bounded by the configured Sprint 4 policy and must not be increased as an incident workaround.

---

## 5. Graceful Shutdown

Marketing.Ops handles `SIGTERM` and `SIGINT` by stopping new scheduling and allowing active work to finish within the configured shutdown timeout.

`SHUTDOWN_TIMEOUT_MS` controls the timeout and defaults to `30000` milliseconds.

During operational shutdown:

1. Stop initiating new work.
2. Allow running operations to complete within the timeout.
3. Preserve persisted state.
4. After restart, allow normal interrupted-run recovery to evaluate incomplete work.
5. If a lock remains, follow the manual lock procedure in Section 1.

Do not remove lock files merely to accelerate shutdown or restart.

---

## 6. Operational Escalation

Stop manual remediation and escalate for further investigation when:

- lock ownership cannot be established safely;
- the suspected owner process is still running;
- persisted state conflicts with audit history;
- recovery would require bypassing `waiting_manual`;
- recovery would require bypassing CAPTCHA, MFA, authorization or verification;
- a non-retryable operation would need to be replayed;
- safe remediation would require destructive or ambiguous filesystem operations;
- credentials, secrets or sensitive payloads appear in operational output.

Fail closed when ownership or recovery safety is uncertain.

---

## 7. SQL Server Operations

This section covers operational procedures for the SQL Server persistence
provider (`PERSISTENCE_PROVIDER=sqlserver`). The filesystem provider
remains the default and requires no SQL Server infrastructure.

### 7.1 Connectivity Diagnostics

When the application fails to connect to SQL Server:

1. Verify environment variables are set:

   ```powershell
   # Check which variables are present (values are not displayed)
   @('SQL_SERVER_HOST','SQL_SERVER_PORT','SQL_SERVER_DATABASE','SQL_SERVER_USER','SQL_SERVER_PASSWORD') |
       ForEach-Object { "$_ = $(if ($env:$_) { 'SET' } else { 'MISSING' })" }
   ```

2. Test TCP connectivity to the server:

   ```powershell
   Test-NetConnection -ComputerName $env:SQL_SERVER_HOST -Port ($env:SQL_SERVER_PORT -as [int]) -WarningAction SilentlyContinue |
       Select-Object ComputerName, RemotePort, TcpTestSucceeded
   ```

3. Verify DNS resolution:

   ```powershell
   Resolve-DnsName -Name $env:SQL_SERVER_HOST -ErrorAction SilentlyContinue |
       Select-Object Name, IPAddress
   ```

4. Check TLS/encrypt configuration. The default is `encrypt: true` with
   `trustServerCertificate: false`. Self-signed certificates in
   development require an explicit human decision to override.

5. Verify the login exists and the user is provisioned in `opsdb`:

   ```sql
   -- Run as a privileged user
   SELECT name, type_desc, is_disabled
   FROM sys.server_principals
   WHERE name = '<SQL_SERVER_USER>';

   USE opsdb;
   SELECT name, type_desc, default_schema_name
   FROM sys.database_principals
   WHERE name = '<SQL_SERVER_USER>';
   ```

6. Confirm the runtime user has DML grants on business tables
   (`database/privileges/runtime-user.sql`).

7. Check SQL Server error logs for authentication failures:

   ```sql
   EXEC xp_readerrorlog 0, 1, N'Login failed';
   ```

### 7.2 Filesystem Fallback

The filesystem provider is the safe default. If SQL Server is
unavailable, switch back to filesystem:

1. Set `PERSISTENCE_PROVIDER=filesystem` (or remove the variable).
2. Restart the application.
3. The application will use `.data/runs/` and `.data/checkpoints/` for
   persistence.

Existing `.data` files are never deleted or ignored by the SQL provider
(AC-48). Both providers can coexist — the active provider is determined
by configuration at startup.

To import filesystem data into SQL Server after recovery, see
Section 7.7 (FS→SQL Import).

### 7.3 Recovery

The recovery mechanism (`recovery.ts` + `recoveryLoop`) works
identically with both providers. When the process crashes or is
interrupted:

1. Runs in `running` state are detected automatically on restart.
2. Each interrupted run's remote status is evaluated.
3. Recovery strategies are applied according to the state machine
   (see `docs/architecture/persistence.md` for the complete flow).

**Key safety properties:**

- `waiting_manual` is never automatically bypassed.
- Terminal states (`succeeded`, `cancelled`) are never reprocessed.
- Conservative by default: ambiguous remote status → leave running for
  manual investigation.
- Idempotency is preserved across all transitions.
- Recovery evidence is recorded in `RunRecord.metadata.recovery`.

**SQL-specific recovery considerations:**

- If SQL Server was temporarily unavailable, interrupted runs remain in
  `running` state in the database.
- After SQL Server connectivity is restored, the normal recovery loop
  handles these runs.
- Optimistic concurrency (`Revision`) ensures that concurrent recovery
  attempts do not corrupt state.

### 7.4 Concurrency Diagnosis

When `ConcurrencyConflictError` occurs during normal operation:

1. Identify the affected `runId` or `scheduleId` from the error message.
2. Check the current revision in the database:

   ```sql
   SELECT RunId, State, Revision, UpdatedAt
   FROM dbo.Runs
   WHERE RunId = '<runId>';
   ```

3. Compare with the expected revision from the error. The error message
   includes `expected` and `actual` values.

4. Determine the source of the conflict:
   - Another process updated the same record concurrently.
   - A retry attempted to write stale data.
   - A recovery process transitioned the run while the original was
     still active.

5. For Schedule concurrency:

   ```sql
   SELECT ScheduleId, Revision, UpdatedAt
   FROM dbo.Schedules
   WHERE ScheduleId = '<scheduleId>';
   ```

6. The application handles `ConcurrencyConflictError` by logging and
   applying the appropriate retry policy. Manual intervention is
   required only if conflicts are persistent or unexpected.

**Lost-update detection:** SQL Server enforces atomic revision
comparison via `UPDATE ... WHERE Revision = @expected`. A zero-row
update distinguishes not-found from revision conflict (AC-20, AC-21).

### 7.5 Credential Rotation

When SQL Server credentials need to be rotated:

1. **Prepare new credentials** in SQL Server (out-of-band):
   - Create or alter the login with the new password.
   - Verify the database user mapping is intact.

2. **Update the application secret** (`SQL_SERVER_PASSWORD`) in the
   deployment environment (GitHub Actions secrets, Azure Key Vault,
   etc.). Never commit the password to source control.

3. **Restart the application** to pick up the new credentials.

4. **Verify connectivity** using the diagnostics in Section 7.1.

5. **Revoke old credentials** after confirming the new ones work.

**Migration user credentials** follow the same procedure. The migration
user has DDL privileges and is only needed during schema deployment
(AC-62). Normal runtime operation does not require migration privileges.

**Zero-downtime rotation:** If the application supports connection
pooling with automatic reconnection, credential rotation may not require
downtime. Verify pool behavior before relying on this.

### 7.6 Schema Rollback

There is **no automatic rollback** for schema migrations. Failures are
loud and non-destructive:

- A failing migration rolls back its transaction (including the ledger
  row in `dbo.SchemaMigrations`).
- Partial or incompatible ledger state halts the runner for human
  reconciliation.
- Migrations never drop or truncate production data automatically.

**For destructive rollback scenarios:**

1. Back up `opsdb` before any migration.
2. If a migration must be reverted:
   - Create a **new forward migration** that reverses the changes.
   - Never edit an already-applied migration file (the runner checks
     checksums and will fail).
3. For catastrophic failures, restore from backup and re-apply
   migrations up to the desired version.

**Verification after rollback:**

```sql
SELECT Version, Name, Checksum, AppliedAt
FROM dbo.SchemaMigrations
ORDER BY Version;
```

### 7.7 FS→SQL Import

To import existing filesystem data into SQL Server:

1. **Verify filesystem data** exists in `.data/runs/` and
   `.data/checkpoints/`.

2. **Run a dry-run** to validate without writing:

   ```typescript
   const result = await importFsToSql({
     dryRun: true,
     runRepo: fsRunRepo,
     checkpointRepo: fsCheckpointRepo,
     scheduleRepo: fsScheduleRepo,
     auditRepo: fsAuditRepo,
     sqlRunRepo,
     sqlCheckpointRepo,
     sqlScheduleRepo,
     sqlAuditRepo,
   });
   console.log(result);
   ```

3. **Review the dry-run result** for conflicts (existing records in SQL
   that would collide with imported data).

4. **Run the actual import** (with `dryRun: false`):

   ```typescript
   const result = await importFsToSql({
     dryRun: false,
     /* ...same repos... */
   });
   ```

5. **Verify the import:**

   ```sql
   SELECT COUNT(*) AS RunCount FROM dbo.Runs;
   SELECT COUNT(*) AS CheckpointCount FROM dbo.Checkpoints;
   SELECT COUNT(*) AS ScheduleCount FROM dbo.Schedules;
   SELECT COUNT(*) AS AuditCount FROM dbo.AuditEntries;
   ```

**Key safety properties (AC-45 through AC-48):**

- Source `.data` files are **never deleted or modified** by the import.
- RunId, idempotency keys, UTC timestamps, states, and checkpoint
  order are preserved.
- Existing records in SQL are reported as conflicts, never
  overwritten.
- Import is a single logical operation with error paths for each
  entity type.
- Audit entries are redacted before import (PII/secrets in metadata).
