import type { RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";
import type { RunRepository } from "../domain/repository.js";
import type { OperationalEmitter } from "../domain/operational-emitter.js";
import type { AuditRepository } from "../domain/audit-repository.js";
import type { Clock } from "../domain/clock.js";
import { transitionRunState } from "../domain/transition.js";
import { createCheckpoint } from "../domain/checkpoint.js";
import { redactError, redactLog } from "../domain/redaction.js";

import { buildAdapterContext } from "./adapter-context.js";
import type { AdapterResult, PlatformAdapter } from "./platform-adapter.js";
import { synchronizeStatus, resolveAdapterState } from "./status-sync.js";
import { recoveryLoop as recoveryLoopImpl, type RecoveryResult } from "./recovery.js";
import { emitRunEvent } from "./orchestrator-events.js";

// ─── internal helpers ────────────────────────────────────────────────────────

/**
 * Safely emits a run event. Failures are logged to stderr and never
 * interrupt the orchestrator flow.
 */
async function safeEmitRunEvent(
  emitter: OperationalEmitter | undefined,
  auditRepo: AuditRepository | undefined,
  clock: Clock | undefined,
  params: Omit<Parameters<typeof emitRunEvent>[0], "emitter" | "auditRepo" | "clock">,
): Promise<void> {
  if (!emitter || !auditRepo || !clock) {
    return;
  }
  try {
    await emitRunEvent({ emitter, auditRepo, clock, ...params });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[orchestrator] Event emission failed: ${message}\n`);
  }
}

// ─── executeRun ──────────────────────────────────────────────────────────────

/**
 * Executes a run by transitioning it through the state machine.
 *
 * Flow:
 *  1. Transition queued → running (increments attempt)
 *  2. Create checkpoint before execution
 *  3. Call adapter.execute(context)
 *  4. Synchronize status with remote state via checkStatus()
 *  5. Process reconciled result and transition to final state
 *  6. Persist updated record via repo.update()
 *
 * @param record - The current run record (must be in `queued` state)
 * @param adapter - The platform adapter to execute
 * @param repo - The run repository for persistence
 * @param emitter - Optional operational event emitter (AC-19)
 * @param auditRepo - Optional audit repository (AC-24)
 * @param clock - Optional clock for deterministic timestamps
 * @returns The updated run record after execution
 */
export async function executeRun(
  record: RunRecord,
  adapter: PlatformAdapter,
  repo: RunRepository,
  emitter?: OperationalEmitter,
  auditRepo?: AuditRepository,
  clock?: Clock,
): Promise<RunRecord> {
  // 1. Transition queued → running
  const runningRecord = transitionRunState({
    current: record,
    targetState: "running",
  });

  // 2. Create checkpoint before execute (audit trail)
  createCheckpoint(runningRecord, {});

  // Persist the running state
  const persistedRunning = await repo.update(runningRecord);

  // Emit run.running event (AC-19)
  await safeEmitRunEvent(emitter, auditRepo, clock, {
    record: persistedRunning,
    eventName: "run.running",
    level: "info",
    message: `Run ${persistedRunning.runId} started`,
    actor: "system",
    previousState: "queued",
  });

  // 3. Build adapter context and execute
  const context = buildAdapterContext(persistedRunning);
  const result = await adapter.execute(context);

  // 4. Synchronize status with remote state
  const reconciled = await synchronizeStatus(adapter, persistedRunning.runId, result);

  // 5. Process reconciled result and determine final state
  const finalRecord = processResult(persistedRunning, reconciled, result);

  // 6. Persist final state
  const persisted = await repo.update(finalRecord);

  // Emit final-state event (AC-19)
  if (persisted.state === "succeeded") {
    await safeEmitRunEvent(emitter, auditRepo, clock, {
      record: persisted,
      eventName: "run.succeeded",
      level: "info",
      message: `Run ${persisted.runId} succeeded`,
      actor: "system",
      previousState: "running",
    });
  } else if (persisted.state === "failed") {
    await safeEmitRunEvent(emitter, auditRepo, clock, {
      record: persisted,
      eventName: "run.failed",
      level: "error",
      message: `Run ${persisted.runId} failed`,
      actor: "system",
      previousState: "running",
    });
  } else if (persisted.state === "waiting_manual") {
    await safeEmitRunEvent(emitter, auditRepo, clock, {
      record: persisted,
      eventName: "run.waiting_manual",
      level: "warn",
      message: `Run ${persisted.runId} waiting for manual intervention`,
      actor: "system",
      previousState: "running",
    });
  }

  return persisted;
}

// ─── resumeRun ───────────────────────────────────────────────────────────────

/**
 * Resumes a run that is in `waiting_manual` state.
 *
 * Flow:
 *  1. Fetch run by runId
 *  2. Verify state is waiting_manual
 *  3. Transition waiting_manual → running (clears previous error)
 *  4. Register evidence of the human action in metadata
 *  5. Create checkpoint with manual action context
 *  6. Call adapter.execute(context)
 *  7. Process result and transition to final state
 *  8. Persist updated record via repo.update()
 *
 * @param runId - The ID of the run to resume
 * @param adapter - The platform adapter to execute
 * @param repo - The run repository for persistence
 * @param emitter - Optional operational event emitter (AC-19)
 * @param auditRepo - Optional audit repository (AC-24)
 * @param clock - Optional clock for deterministic timestamps
 * @returns The updated run record after execution
 * @throws Error if the run is not in waiting_manual state
 */
export async function resumeRun(
  runId: RunId,
  adapter: PlatformAdapter,
  repo: RunRepository,
  emitter?: OperationalEmitter,
  auditRepo?: AuditRepository,
  clock?: Clock,
): Promise<RunRecord> {
  // 1. Fetch run
  const record = await repo.getById(runId);

  if (!record) {
    throw new Error(`Run not found: ${runId}`);
  }

  // 2. Verify state
  if (record.state !== "waiting_manual") {
    throw new Error(`Cannot resume run in state "${record.state}": expected "waiting_manual"`);
  }

  // Preserve attempt and maxAttempts before transition
  const preservedAttempt = record.attempt;
  const preservedMaxAttempts = record.maxAttempts;

  // 3. Transition waiting_manual → running (clears error)
  const runningRecord = transitionRunState({
    current: record,
    targetState: "running",
  });

  // Restore attempt and maxAttempts (transitionRunState does not increment for waiting_manual → running)
  const runningWithAttempt = {
    ...runningRecord,
    attempt: preservedAttempt,
    maxAttempts: preservedMaxAttempts,
  };

  // 4. Register sanitized evidence of the human action in metadata
  const metadata = {
    ...runningWithAttempt.metadata,
    manualAction: {
      resumedAt: new Date().toISOString(),
      previousState: "waiting_manual",
      actionType: "manual_resume",
    },
  };
  const runningWithMetadata = { ...runningWithAttempt, metadata };

  // Persist the running state
  const persistedRunning = await repo.update(runningWithMetadata);

  // Emit run.running event (AC-19)
  await safeEmitRunEvent(emitter, auditRepo, clock, {
    record: persistedRunning,
    eventName: "run.running",
    level: "info",
    message: `Run ${persistedRunning.runId} resumed`,
    actor: "system",
    previousState: "waiting_manual",
  });

  // 5. Create checkpoint with manual action context
  createCheckpoint(persistedRunning, {
    actionType: "manual_resume",
    previousState: "waiting_manual",
    resumedAt: metadata.manualAction.resumedAt,
  });

  // 6. Build adapter context and execute
  const context = buildAdapterContext(persistedRunning);
  const result = await adapter.execute(context);

  // 7. Process result and determine final state
  const finalRecord = processResult(persistedRunning, undefined, result);

  // 8. Persist final state
  const persisted = await repo.update(finalRecord);

  // Emit final-state event (AC-19)
  if (persisted.state === "succeeded") {
    await safeEmitRunEvent(emitter, auditRepo, clock, {
      record: persisted,
      eventName: "run.succeeded",
      level: "info",
      message: `Run ${persisted.runId} succeeded`,
      actor: "system",
      previousState: "running",
    });
  } else if (persisted.state === "failed") {
    await safeEmitRunEvent(emitter, auditRepo, clock, {
      record: persisted,
      eventName: "run.failed",
      level: "error",
      message: `Run ${persisted.runId} failed`,
      actor: "system",
      previousState: "running",
    });
  } else if (persisted.state === "waiting_manual") {
    await safeEmitRunEvent(emitter, auditRepo, clock, {
      record: persisted,
      eventName: "run.waiting_manual",
      level: "warn",
      message: `Run ${persisted.runId} waiting for manual intervention`,
      actor: "system",
      previousState: "running",
    });
  }

  return persisted;
}

// ─── executeRunWithRecovery ─────────────────────────────────────────────────

/**
 * Entry point that runs recovery before executing a new run.
 *
 * Flow:
 *  1. Execute recoveryLoop to handle any interrupted or retryable runs
 *  2. Execute the new run via executeRun
 *
 * RR-05: recoveryLoop() is called before executing new runs.
 *
 * @param record - The current run record (must be in `queued` state)
 * @param adapter - The platform adapter to execute
 * @param repo - The run repository for persistence
 * @param emitter - Optional operational event emitter (AC-19)
 * @param auditRepo - Optional audit repository (AC-24)
 * @param clock - Optional clock for deterministic timestamps
 * @returns Object containing recovery results and the executed run record
 */
export async function executeRunWithRecovery(
  record: RunRecord,
  adapter: PlatformAdapter,
  repo: RunRepository,
  emitter?: OperationalEmitter,
  auditRepo?: AuditRepository,
  clock?: Clock,
): Promise<{ recoveryResults: RecoveryResult[]; executedRun: RunRecord }> {
  // 1. Run recovery before new execution
  const recoveryResults = await recoveryLoopImpl(adapter, repo);

  // 2. Execute the new run
  const executedRun = await executeRun(record, adapter, repo, emitter, auditRepo, clock);

  return { recoveryResults, executedRun };
}

// ─── processResult (internal) ────────────────────────────────────────────────

/**
 * Processes an AdapterResult (optionally reconciled) and transitions the
 * run record accordingly.
 *
 * - success: true → running → succeeded
 * - success: false, requiresManual: true → running → waiting_manual
 * - success: false, error.retryable: true → running → failed
 * - success: false, error.retryable: false → running → failed (terminal)
 *
 * When a reconciled result is provided, its state takes precedence over
 * the raw adapter result. The raw result is used for metadata logging.
 */
function processResult(
  record: RunRecord,
  reconciled:
    | {
        state: import("../domain/run-state.js").RunState;
        output?: unknown;
        error?: import("../domain/run-state.js").RunError;
      }
    | undefined,
  rawResult: AdapterResult,
): RunRecord {
  const outputToLog = reconciled?.output ?? rawResult.output;
  const errorToLog = reconciled?.error ?? rawResult.error;

  // Add status-sync evidence to metadata
  const metadata = {
    ...record.metadata,
    statusSync: reconciled
      ? {
          reconciledState: reconciled.state,
          hasRemoteOutput: reconciled.output !== undefined,
          hasRemoteError: reconciled.error !== undefined,
          synchronizedAt: new Date().toISOString(),
        }
      : undefined,
    lastOutput:
      outputToLog !== undefined
        ? redactLog({ output: outputToLog as Record<string, unknown> })
        : undefined,
    lastError: errorToLog !== undefined ? redactError(errorToLog) : undefined,
  };

  const recordWithMetadata = { ...record, metadata };

  // Determine target state from reconciled result or raw adapter result
  const targetState = reconciled?.state ?? resolveAdapterState(rawResult);

  if (targetState === "waiting_manual") {
    return transitionRunState({
      current: recordWithMetadata,
      targetState: "waiting_manual",
    });
  }

  if (targetState === "succeeded") {
    return transitionRunState({
      current: recordWithMetadata,
      targetState: "succeeded",
    });
  }

  // targetState === "failed"
  return transitionRunState({
    current: recordWithMetadata,
    targetState: "failed",
    error: redactError(errorToLog ?? { message: "Unknown error" }),
  });
}

// Re-export recoveryLoop for orchestrator consumers
export { recoveryLoopImpl as recoveryLoop };
export type { RecoveryResult, RecoveryStrategy } from "./recovery.js";
