import type { RunId } from "../domain/idempotency.js";
import type { RunState } from "../domain/run-state.js";

// ─── Checkpoint Repository Interface (CK-01) ─────────────────────────────────

/**
 * Checkpoint data transfer object for persistence.
 *
 * Mirrors the domain Checkpoint interface but is decoupled from it
 * to allow different serialization strategies per adapter.
 */
export interface CheckpointDto {
  readonly runId: RunId;
  readonly state: RunState;
  readonly attempt: number;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

/**
 * Domain-level contract for checkpoint persistence.
 *
 * Checkpoints are immutable snapshots of a run's state used for
 * recovery after failures. This interface provides storage and
 * retrieval methods.
 *
 * Note: `createCheckpoint()` in `automation/domain/checkpoint.ts`
 * remains a pure domain function (CK-02) — it does not depend on
 * this interface or any filesystem.
 */
export interface CheckpointRepository {
  /**
   * Persists a checkpoint record.
   */
  create(checkpoint: CheckpointDto): Promise<CheckpointDto>;

  /**
   * Retrieves the most recent checkpoint for a given run.
   * Returns null if no checkpoints exist for the run.
   */
  getLatest(runId: RunId): Promise<CheckpointDto | null>;

  /**
   * Lists all checkpoints for a given run, ordered by creation date (ascending).
   */
  listByRunId(runId: RunId): Promise<CheckpointDto[]>;
}
