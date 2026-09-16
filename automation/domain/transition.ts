import type { RunRecord } from "./run-record.js";
import type { RunState } from "./run-state.js";
import type { RunError } from "./run-state.js";

export interface TransitionContext {
  readonly current: RunRecord;
  readonly targetState: RunState;
  readonly error?: RunError;
}

const TRANSITION_MATRIX: Record<RunState, readonly RunState[]> = {
  queued: ["running", "cancelled"],
  running: ["waiting_manual", "succeeded", "failed", "cancelled"],
  waiting_manual: ["running", "failed", "cancelled"],
  failed: ["queued"],
  succeeded: [],
  cancelled: [],
};

function isTerminal(state: RunState): boolean {
  return state === "succeeded" || state === "cancelled";
}

function canRetry(record: RunRecord, error?: RunError): boolean {
  const retryError = error ?? record.error;
  if (!retryError?.retryable) {
    return false;
  }
  return record.attempt < record.maxAttempts;
}

export function transitionRunState(context: TransitionContext): RunRecord {
  const { current, targetState, error } = context;

  if (isTerminal(current.state)) {
    throw new Error(`Cannot transition from terminal state "${current.state}"`);
  }

  const allowedTargets = TRANSITION_MATRIX[current.state];

  if (!allowedTargets.includes(targetState)) {
    throw new Error(`Invalid transition from "${current.state}" to "${targetState}"`);
  }

  if (current.state === "failed" && targetState === "queued" && !canRetry(current, error)) {
    throw new Error(
      `Cannot retry: error is not retryable or attempt (${current.attempt}) ` +
        `has reached maxAttempts (${current.maxAttempts})`,
    );
  }

  const now = new Date();
  const updates: Partial<RunRecord> = {
    state: targetState,
    updatedAt: now,
  };

  if (current.state === "queued" && targetState === "running") {
    const newAttempt = current.attempt + 1;
    if (newAttempt > current.maxAttempts) {
      throw new Error(
        `Cannot increment attempt: ${newAttempt} would exceed maxAttempts (${current.maxAttempts})`,
      );
    }
    updates.attempt = newAttempt;
    updates.startedAt = now;
  }

  if (targetState === "succeeded" || targetState === "failed" || targetState === "cancelled") {
    updates.finishedAt = now;
  }

  if (targetState === "failed" && error) {
    updates.error = error;
  }

  if (targetState === "running" && current.state === "waiting_manual") {
    updates.error = undefined;
  }

  return {
    ...current,
    ...updates,
  };
}
