/**
 * Operational error types with actionable context.
 *
 * AC-41: All operational errors include:
 * - code (categorized)
 * - action (what to do, including runbook reference)
 * - context (relevant data without secrets)
 */

// --- Error Codes ---

export const ERROR_CODES = {
  LOCK_CONTENTION: "LOCK_CONTENTION",
  LOCK_TIMEOUT: "LOCK_TIMEOUT",
  SHUTDOWN_TIMEOUT: "SHUTDOWN_TIMEOUT",
  CONCURRENCY_CONFLICT: "CONCURRENCY_CONFLICT",
  CORRUPTED_RECORD: "CORRUPTED_RECORD",
  RECOVERY_FAILED: "RECOVERY_FAILED",
  SCHEDULE_EVALUATION_FAILED: "SCHEDULE_EVALUATION_FAILED",
  BATCH_EXECUTION_FAILED: "BATCH_EXECUTION_FAILED",
  AUDIT_WRITE_FAILED: "AUDIT_WRITE_FAILED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// --- Operational Error ---

export interface OperationalErrorContext {
  readonly [key: string]: unknown;
}

export class OperationalError extends Error {
  readonly code: ErrorCode;
  readonly action: string;
  readonly context: OperationalErrorContext;

  constructor(params: {
    code: ErrorCode;
    message: string;
    action: string;
    context?: OperationalErrorContext;
    cause?: Error;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "OperationalError";
    this.code = params.code;
    this.action = params.action;
    this.context = params.context ?? {};
  }

  /**
   * Returns a safe representation for logging (no secrets).
   */
  toSafeJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      action: this.action,
      context: this.context,
    };
  }
}

// --- Factory helpers ---

export function createLockContentionError(runId: string): OperationalError {
  return new OperationalError({
    code: ERROR_CODES.LOCK_CONTENTION,
    message: `Lock contention for runId: ${runId}`,
    action: "Runbook: docs/runbook.md#lock-contention",
    context: { runId },
  });
}

export function createLockTimeoutError(runId: string, attempts: number): OperationalError {
  return new OperationalError({
    code: ERROR_CODES.LOCK_TIMEOUT,
    message: `Lock acquisition timeout for runId: ${runId} after ${attempts} attempts`,
    action: "Runbook: docs/runbook.md#lock-timeout",
    context: { runId, attempts },
  });
}

export function createShutdownTimeoutError(pendingRuns: number): OperationalError {
  return new OperationalError({
    code: ERROR_CODES.SHUTDOWN_TIMEOUT,
    message: `Shutdown timeout: ${pendingRuns} runs still pending`,
    action: "Runbook: docs/runbook.md#shutdown-timeout",
    context: { pendingRuns },
  });
}
