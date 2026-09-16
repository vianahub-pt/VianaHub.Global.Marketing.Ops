import type { IdempotencyKey, RunId } from "./idempotency.js";
import type { RunRecord } from "./run-record.js";
import type { RunState } from "./run-state.js";

/**
 * Filters available when listing run records.
 */
export interface RunListFilters {
  readonly brandId?: string;
  readonly market?: string;
  readonly platform?: string;
  readonly operation?: string;
  readonly state?: RunState;
}

/**
 * Domain-level contract for run record persistence.
 *
 * This interface is technology-agnostic — concrete implementations
 * (SQL Server, SQLite, in-memory, etc.) must satisfy this contract.
 *
 * Concurrency:
 *  - Optimistic concurrency is assumed at the application layer.
 *  - Implementations should document how they handle concurrent
 *    updates (e.g., version column, ETag, compare-and-swap).
 *  - This contract does not enforce concurrency control; it is
 *    the responsibility of the adapter layer.
 */
export interface RunRepository {
  /**
   * Persists a new run record.
   * Must fail if a record with the same runId already exists.
   */
  create(record: RunRecord): Promise<RunRecord>;

  /**
   * Retrieves a run record by its unique RunId.
   * Returns null if no record is found.
   */
  getById(runId: RunId): Promise<RunRecord | null>;

  /**
   * Updates an existing run record.
   * Must fail if the record does not exist.
   * Optimistic concurrency: implementations should verify that
   * the record version matches before applying updates.
   */
  update(record: RunRecord): Promise<RunRecord>;

  /**
   * Lists run records matching the provided filters.
   * Returns an empty array if no records match.
   */
  list(filters?: RunListFilters): Promise<RunRecord[]>;

  /**
   * Finds a run record by its idempotency key.
   * Returns null if no record is found.
   */
  findByIdempotencyKey(key: IdempotencyKey): Promise<RunRecord | null>;
}
