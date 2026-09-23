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
