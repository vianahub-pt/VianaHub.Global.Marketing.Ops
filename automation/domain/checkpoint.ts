import type { RunId } from "./idempotency.js";
import type { RunRecord } from "./run-record.js";
import type { RunState } from "./run-state.js";

/**
 * A serializable snapshot of a run's state at a point in time.
 * Used for persistence and recovery after failures.
 */
export interface Checkpoint {
  readonly runId: RunId;
  readonly state: RunState;
  readonly attempt: number;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
}

/**
 * Creates a Checkpoint from a RunRecord and arbitrary payload data.
 *
 * The checkpoint captures:
 *  - The run's identity (runId)
 *  - The current state at the moment of checkpointing
 *  - The attempt number
 *  - An arbitrary serializable payload (adapter-specific context)
 *  - The timestamp of creation
 *
 * @param record  - The current run record
 * @param payload - Arbitrary serializable data to persist with the checkpoint
 */
export function createCheckpoint(record: RunRecord, payload: Record<string, unknown>): Checkpoint {
  return {
    runId: record.runId,
    state: record.state,
    attempt: record.attempt,
    payload,
    createdAt: new Date(),
  };
}
