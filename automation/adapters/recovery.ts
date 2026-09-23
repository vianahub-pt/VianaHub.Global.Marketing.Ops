import type { RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";
import type { RunRepository } from "../domain/repository.js";
import type { RunState } from "../domain/run-state.js";
import type { AuditRepository } from "../domain/audit-repository.js";
import type { AlertEmitter } from "../domain/alert-emitter.js";
import { createAlertEntry } from "../domain/alert-schema.js";
import { createAuditEntry } from "../domain/audit-entry.js";
import { redactError, redactErrorString, redactLog } from "../domain/redaction.js";
import type { Clock } from "../domain/clock.js";
import { transitionRunState } from "../domain/transition.js";

import type { PlatformAdapter, StatusCheckResult } from "./platform-adapter.js";

// ─── Recovery strategy ───────────────────────────────────────────────────────

export interface RecoveryStrategy {
  readonly action: "succeed" | "wait_manual" | "retry" | "fail" | "leave_running";
  readonly remoteState?: RunState;
  readonly error?: { message: string; code?: string; retryable?: boolean };
  readonly reason: string;
}

// ─── detectInterruptedRuns ───────────────────────────────────────────────────

/**
 * Detects all run records that need recovery evaluation.
 *
 * Includes:
 *  - runs in `running` state (interrupted — process crash, network failure, etc.)
 *  - runs in `failed` state with retryable error and attempt < maxAttempts
 *
 * RR-01: Returns all RunRecord in state `running` or `failed` (retryable)
 * HUMAN-005: Includes failed retryable runs for recovery
 */
export async function detectInterruptedRuns(repo: RunRepository): Promise<RunRecord[]> {
  const running = await repo.list({ state: "running" });
  const failed = await repo.list({ state: "failed" });

  const retryableFailed = failed.filter(
    (r) => r.error?.retryable === true && r.attempt < r.maxAttempts,
  );

  return [...running, ...retryableFailed];
}

// ─── evaluateRecovery (internal) ─────────────────────────────────────────────

/**
 * Evaluates the appropriate recovery strategy for a run based on its
 * remote status and local state.
 *
 * RR-02: Conservative recovery logic:
 *  - remote succeeded → succeed
 *  - remote needs manual → wait_manual
 *  - remote failed retryable & attempt < maxAttempts → retry (fail → queued)
 *  - remote failed non-retryable or maxAttempts reached → fail (terminal)
 *  - remote ambiguous → leave_running (manual intervention required)
 *
 * RR-03: Preserves waiting_manual — never auto-recovers waiting_manual
 */
function evaluateRecovery(
  record: RunRecord,
  remoteStatus: StatusCheckResult | null,
): RecoveryStrategy {
  // If no adapter or checkStatus unavailable, leave running (ambiguous)
  if (!remoteStatus) {
    return {
      action: "leave_running",
      reason:
        "No remote status available — run left in running state " +
        "for manual intervention to avoid potential duplication",
    };
  }

  const { state: remoteState } = remoteStatus;

  // Remote shows completed successfully
  if (remoteState === "succeeded") {
    return {
      action: "succeed",
      remoteState,
      reason: "Remote status confirms operation completed successfully",
    };
  }

  // Remote needs human action
  if (remoteState === "waiting_manual") {
    return {
      action: "wait_manual",
      remoteState,
      reason: "Remote status indicates human intervention is required",
    };
  }

  // Remote failed — check retryability
  if (remoteState === "failed") {
    const error = remoteStatus.error ?? {
      message: "Remote operation failed",
      retryable: false,
    };

    const isRetryable = error.retryable === true;
    const canRetryMore = record.attempt < record.maxAttempts;

    if (isRetryable && canRetryMore) {
      return {
        action: "retry",
        remoteState,
        error,
        reason:
          `Remote failure is retryable and attempt (${record.attempt}) ` +
          `is below maxAttempts (${record.maxAttempts})`,
      };
    }

    return {
      action: "fail",
      remoteState,
      error,
      reason: isRetryable
        ? `Retryable failure but maxAttempts (${record.maxAttempts}) already reached`
        : "Remote failure is not retryable",
    };
  }

  // Remote still running or queued — ambiguous state, leave for manual check
  if (remoteState === "running" || remoteState === "queued") {
    return {
      action: "leave_running",
      remoteState,
      reason:
        `Remote state is "${remoteState}" — ambiguous; leaving in running state ` +
        "to prevent potential duplication on retry",
    };
  }

  // Remote cancelled — treat as failed (conservative)
  if (remoteState === "cancelled") {
    return {
      action: "fail",
      remoteState,
      error: { message: "Remote operation was cancelled", retryable: false },
      reason: "Remote operation was cancelled — treating as terminal failure",
    };
  }

  // Unknown remote state — conservative: leave running
  return {
    action: "leave_running",
    remoteState,
    reason: `Unknown remote state "${remoteState}" — manual intervention required`,
  };
}

// ─── recoverRun ──────────────────────────────────────────────────────────────

/**
 * Recovers a single interrupted run based on its remote status.
 *
 * Conservative approach:
 *  - Checks remote status via adapter.checkStatus() when available
 *  - Transitions based on remote evidence, not assumptions
 *  - Preserves waiting_manual runs
 *  - Preserves idempotencyKey
 *  - Registers recovery event in metadata
 *
 * RR-02: Full recovery logic as described in evaluateRecovery
 * RR-03: Preserves waiting_manual and idempotencyKey
 * RR-04: Registers recovery event in metadata; corrupted state returns error
 * RR-06: Terminal states not processed; failed with retryable + attempt < max → queued
 * HUMAN-005: failed retryable runs transition failed → queued
 */
export async function recoverRun(
  record: RunRecord,
  adapter: PlatformAdapter | null,
  repo: RunRepository,
): Promise<RunRecord> {
  // RR-03: Never auto-recover waiting_manual
  if (record.state === "waiting_manual") {
    const metadata = {
      ...record.metadata,
      recovery: {
        evaluatedAt: new Date().toISOString(),
        action: "skipped",
        reason: "Run is in waiting_manual state — requires explicit human action",
        idempotencyKey: record.idempotencyKey,
      },
    };
    return repo.update({ ...record, metadata, updatedAt: new Date() });
  }

  // RR-06: Terminal states are not processed
  if (record.state === "succeeded" || record.state === "cancelled") {
    return record;
  }

  // HUMAN-005: Handle failed retryable runs (failed → queued)
  if (record.state === "failed") {
    // Defensive check: verify retryable conditions even though detectInterruptedRuns filters
    if (record.error?.retryable !== true || record.attempt >= record.maxAttempts) {
      // Should not happen since detectInterruptedRuns filters these out, but be defensive
      return record;
    }

    const recoveryTimestamp = new Date().toISOString();
    const baseMetadata = {
      ...record.metadata,
      recovery: {
        evaluatedAt: recoveryTimestamp,
        action: "retry",
        reason:
          `Failed run is retryable and attempt (${record.attempt}) ` +
          `is below maxAttempts (${record.maxAttempts})`,
        idempotencyKey: record.idempotencyKey,
      },
    };

    // Transition failed → queued for retry
    const queuedRecord = transitionRunState({
      current: { ...record, metadata: baseMetadata },
      targetState: "queued",
      error: record.error,
    });
    return repo.update(queuedRecord);
  }

  // Only running runs need recovery; other states are unexpected here
  if (record.state !== "running") {
    const error = new Error(
      `Cannot recover run in state "${record.state}": expected "running" or "waiting_manual"`,
    );
    throw error;
  }

  // Check remote status if adapter is available
  let remoteStatus: StatusCheckResult | null = null;
  if (adapter) {
    try {
      remoteStatus = await adapter.checkStatus(record.runId);
    } catch {
      // If checkStatus fails, treat as no remote status available
      remoteStatus = null;
    }
  }

  // Evaluate recovery strategy
  const strategy = evaluateRecovery(record, remoteStatus);

  const recoveryTimestamp = new Date().toISOString();
  const baseMetadata = {
    ...record.metadata,
    recovery: {
      evaluatedAt: recoveryTimestamp,
      action: strategy.action,
      reason: strategy.reason,
      remoteState: strategy.remoteState,
      idempotencyKey: record.idempotencyKey,
    },
  };

  switch (strategy.action) {
    case "succeed": {
      const updated = transitionRunState({
        current: { ...record, metadata: baseMetadata },
        targetState: "succeeded",
      });
      return repo.update(updated);
    }

    case "wait_manual": {
      const updated = transitionRunState({
        current: { ...record, metadata: baseMetadata },
        targetState: "waiting_manual",
      });
      return repo.update(updated);
    }

    case "retry": {
      // RR-02: running → failed (with retryable error), then failed → queued
      const failedRecord = transitionRunState({
        current: { ...record, metadata: baseMetadata },
        targetState: "failed",
        error: redactError(
          strategy.error ?? { message: "Recovery: retryable failure", retryable: true },
        ),
      });

      // Persist the failed state first
      await repo.update(failedRecord);

      // Now transition failed → queued (retryable, attempt < maxAttempts)
      const queuedRecord = transitionRunState({
        current: failedRecord,
        targetState: "queued",
        error: strategy.error,
      });
      return repo.update(queuedRecord);
    }

    case "fail": {
      const updated = transitionRunState({
        current: { ...record, metadata: baseMetadata },
        targetState: "failed",
        error: redactError(
          strategy.error ?? { message: "Recovery: non-retryable or max attempts reached" },
        ),
      });
      return repo.update(updated);
    }

    case "leave_running":
    default: {
      // RR-04: Register evidence and leave in running state
      const updated = {
        ...record,
        metadata: baseMetadata,
        updatedAt: new Date(),
      };
      return repo.update(updated);
    }
  }
}

// ─── recoverRun result types ─────────────────────────────────────────────────

export interface RecoveryResult {
  readonly runId: RunId;
  readonly previousState: RunState;
  readonly newState: RunState;
  readonly action: string;
  readonly reason: string;
  readonly error?: string;
}

// ─── recoveryLoop ────────────────────────────────────────────────────────────

/**
 * Executes the recovery loop: detects all interrupted runs and recovers each one.
 *
 * RR-05: recoveryLoop() executes detectInterruptedRuns + recoverRun for each;
 *        called before executing new runs.
 *
 * Also includes waiting_manual runs so their recovery status is reported.
 */
export async function recoveryLoop(
  adapter: PlatformAdapter | null,
  repo: RunRepository,
): Promise<RecoveryResult[]> {
  const interruptedRuns = await detectInterruptedRuns(repo);
  const waitingManualRuns = await repo.list({ state: "waiting_manual" });
  const allRunsToProcess = [...interruptedRuns, ...waitingManualRuns];
  const results: RecoveryResult[] = [];

  for (const run of allRunsToProcess) {
    const previousState = run.state;

    try {
      const recovered = await recoverRun(run, adapter, repo);

      const recoveryMeta = recovered.metadata?.recovery as
        { action?: string; reason?: string } | undefined;

      results.push({
        runId: run.runId,
        previousState,
        newState: recovered.state,
        action: (recoveryMeta?.action as string) ?? "unknown",
        reason: recoveryMeta?.reason ?? "No recovery needed",
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        runId: run.runId,
        previousState,
        newState: previousState,
        action: "error",
        reason: `Recovery failed: ${message}`,
        error: message,
      });
    }
  }

  return results;
}

// ─── AutomatedRecoveryResult ────────────────────────────────────────────────

export interface AutomatedRecoveryResult {
  readonly runId: string;
  readonly previousState: RunState;
  readonly newState: RunState;
  readonly action: string;
  readonly reason: string;
  readonly alertEmitted: boolean;
  readonly auditRecorded: boolean;
  readonly error?: string;
}

// ─── automatedRecoveryLoop ──────────────────────────────────────────────────

/**
 * Automated recovery loop with audit and alert integration.
 *
 * AC-31: Calls detectInterruptedRuns + recoverRun for each;
 * emits audit + alert for each action.
 *
 * AC-32: NEVER transitions waiting_manual to running automatically.
 * Registers audit entry "skipped: waiting_manual".
 *
 * AC-33: Non-retryable failures are NOT re-executed.
 * Registers audit entry "skipped: non-retryable".
 *
 * AC-34: Does NOT transition states requiring CAPTCHA/MFA/
 * verification/human action. Preserves waiting_manual.
 *
 * AC-35: Can be called multiple times without side effects.
 * Idempotency preserved via existing audit entries.
 */
export async function automatedRecoveryLoop(
  adapter: PlatformAdapter | null,
  repo: RunRepository,
  auditEmitter: AuditRepository,
  alertEmitter: AlertEmitter,
  clock: Clock,
): Promise<AutomatedRecoveryResult[]> {
  const interruptedRuns = await detectInterruptedRuns(repo);
  const waitingManualRuns = await repo.list({ state: "waiting_manual" });
  const allFailedRuns = await repo.list({ state: "failed" });

  // AC-33: Include non-retryable and max-attempts failed runs for skip handling.
  // detectInterruptedRuns only returns retryable failed runs with attempt < maxAttempts,
  // so we need to explicitly include the terminal failed runs here.
  const terminalFailedRuns = allFailedRuns.filter(
    (r) => r.error?.retryable === false || r.attempt >= r.maxAttempts,
  );

  // Deduplicate by runId to avoid processing a run twice
  const allRunsMap = new Map<string, RunRecord>();
  for (const run of [...interruptedRuns, ...waitingManualRuns, ...terminalFailedRuns]) {
    allRunsMap.set(run.runId, run);
  }
  const allRunsToProcess = Array.from(allRunsMap.values());
  const results: AutomatedRecoveryResult[] = [];

  for (const run of allRunsToProcess) {
    const previousState = run.state;

    // AC-32: NEVER auto-transition waiting_manual
    if (run.state === "waiting_manual") {
      const auditEntry = createAuditEntry({
        category: "recovery",
        action: "recovery.skipped",
        actor: "system",
        correlationIds: {
          runId: run.runId,
          scheduleId: run.metadata?.scheduleId as string | undefined,
          batchId: run.metadata?.batchId as string | undefined,
        },
        previousState: "waiting_manual",
        newState: "waiting_manual",
        metadata: { reason: "skipped: waiting_manual" },
        clock,
      });
      await auditEmitter.append(auditEntry);

      const alert = createAlertEntry({
        severity: "info",
        category: "recovery",
        message: `Recovery skipped for run ${run.runId}: waiting_manual (requires human action)`,
        correlationIds: { runId: run.runId },
        deduplicationKey: `recovery-skip-waiting-manual-${run.runId}`,
        clock,
      });
      alertEmitter.emit(alert);

      results.push({
        runId: run.runId,
        previousState,
        newState: "waiting_manual",
        action: "skipped",
        reason: "skipped: waiting_manual",
        alertEmitted: true,
        auditRecorded: true,
      });
      continue;
    }

    // AC-33: Non-retryable failures are NOT re-executed
    if (
      run.state === "failed" &&
      (run.error?.retryable === false || run.attempt >= run.maxAttempts)
    ) {
      const auditEntry = createAuditEntry({
        category: "recovery",
        action: "recovery.skipped",
        actor: "system",
        correlationIds: {
          runId: run.runId,
          scheduleId: run.metadata?.scheduleId as string | undefined,
          batchId: run.metadata?.batchId as string | undefined,
        },
        previousState: "failed",
        newState: "failed",
        metadata: {
          reason:
            run.error?.retryable === false
              ? "skipped: non-retryable"
              : "skipped: max-attempts-reached",
          attempt: run.attempt,
          maxAttempts: run.maxAttempts,
        },
        clock,
      });
      await auditEmitter.append(auditEntry);

      const alert = createAlertEntry({
        severity: "warn",
        category: "recovery",
        message: `Recovery skipped for run ${run.runId}: ${run.error?.retryable === false ? "non-retryable failure" : "max attempts reached"}`,
        correlationIds: { runId: run.runId },
        deduplicationKey: `recovery-skip-non-retryable-${run.runId}`,
        clock,
      });
      alertEmitter.emit(alert);

      results.push({
        runId: run.runId,
        previousState,
        newState: "failed",
        action: "skipped",
        reason:
          run.error?.retryable === false
            ? "skipped: non-retryable"
            : "skipped: max-attempts-reached",
        alertEmitted: true,
        auditRecorded: true,
      });
      continue;
    }

    // Normal recovery path
    try {
      const recovered = await recoverRun(run, adapter, repo);
      const recoveryMeta = recovered.metadata?.recovery as
        { action?: string; reason?: string } | undefined;

      // Emit audit entry for recovery action
      const auditEntry = createAuditEntry({
        category: "recovery",
        action: `recovery.${recoveryMeta?.action ?? "unknown"}`,
        actor: "system",
        correlationIds: {
          runId: run.runId,
          scheduleId: run.metadata?.scheduleId as string | undefined,
          batchId: run.metadata?.batchId as string | undefined,
        },
        previousState,
        newState: recovered.state,
        metadata: redactLog({
          reason: recoveryMeta?.reason ?? "No recovery needed",
          action: recoveryMeta?.action ?? "unknown",
        }),
        clock,
      });
      await auditEmitter.append(auditEntry);

      // Emit alert based on recovery outcome
      const alertSeverity = recovered.state === "failed" ? "error" : "info";
      const alert = createAlertEntry({
        severity: alertSeverity,
        category: "recovery",
        message: `Recovery ${recoveryMeta?.action ?? "unknown"} for run ${run.runId}: ${recoveryMeta?.reason ?? ""}`,
        correlationIds: { runId: run.runId },
        deduplicationKey: `recovery-${recoveryMeta?.action}-${run.runId}`,
        clock,
      });
      alertEmitter.emit(alert);

      results.push({
        runId: run.runId,
        previousState,
        newState: recovered.state,
        action: (recoveryMeta?.action as string) ?? "unknown",
        reason: recoveryMeta?.reason ?? "No recovery needed",
        alertEmitted: true,
        auditRecorded: true,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // Emit audit entry for recovery error
      const auditEntry = createAuditEntry({
        category: "recovery",
        action: "recovery.failed",
        actor: "system",
        correlationIds: {
          runId: run.runId,
          scheduleId: run.metadata?.scheduleId as string | undefined,
          batchId: run.metadata?.batchId as string | undefined,
        },
        previousState,
        newState: previousState,
        metadata: redactLog({ error: message }),
        clock,
      });
      await auditEmitter.append(auditEntry);

      // Emit critical alert for recovery failure
      const alert = createAlertEntry({
        severity: "critical",
        category: "recovery",
        message: `Recovery FAILED for run ${run.runId}: ${redactErrorString(message)}`,
        correlationIds: { runId: run.runId },
        deduplicationKey: `recovery-failed-${run.runId}`,
        clock,
      });
      alertEmitter.emit(alert);

      results.push({
        runId: run.runId,
        previousState,
        newState: previousState,
        action: "error",
        reason: `Recovery failed: ${redactErrorString(message)}`,
        alertEmitted: true,
        auditRecorded: true,
        error: redactErrorString(message),
      });
    }
  }

  return results;
}
