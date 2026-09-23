/**
 * Batch repository interface.
 *
 * Defines the contract for persisting and querying
 * batch jobs and batch items.
 */

import type {
  BatchId,
  BatchItem,
  BatchItemId,
  BatchJob,
  BatchStatus,
  BatchItemStatus,
} from "./batch-schema.js";

/**
 * Filters for listing batch items.
 */
export interface BatchItemFilters {
  readonly status?: BatchItemStatus;
}

/**
 * Batch job with its associated items.
 */
export interface BatchWithItems {
  readonly job: BatchJob;
  readonly items: readonly BatchItem[];
}

/**
 * Repository interface for batch persistence.
 */
export interface BatchRepository {
  // BatchJob CRUD

  /**
   * Creates a new batch job.
   * @throws {RecordAlreadyExistsError} if batchId already exists
   */
  createJob(job: BatchJob): Promise<BatchJob>;

  /**
   * Retrieves a batch job by its ID.
   * @returns The batch job or null if not found
   */
  getJobById(batchId: BatchId): Promise<BatchJob | null>;

  /**
   * Updates an existing batch job.
   * @throws {RecordNotFoundError} if batchId does not exist
   * @throws {ConcurrencyConflictError} if revision mismatch
   */
  updateJob(job: BatchJob): Promise<BatchJob>;

  // BatchItem CRUD

  /**
   * Creates a new batch item.
   * @throws {RecordAlreadyExistsError} if itemId already exists
   */
  createItem(item: BatchItem): Promise<BatchItem>;

  /**
   * Retrieves a batch item by its ID.
   * @returns The batch item or null if not found
   */
  getItemById(itemId: BatchItemId): Promise<BatchItem | null>;

  /**
   * Updates an existing batch item.
   * @throws {RecordNotFoundError} if itemId does not exist
   */
  updateItem(item: BatchItem): Promise<BatchItem>;

  // Queries

  /**
   * Lists items for a batch, optionally filtered by status.
   */
  listItemsByBatchId(batchId: BatchId, filters?: BatchItemFilters): Promise<readonly BatchItem[]>;

  /**
   * Lists batch jobs by status.
   */
  listJobsByStatus(status: BatchStatus): Promise<readonly BatchJob[]>;

  /**
   * Retrieves a batch job with all its items.
   * @returns The batch with items or null if not found
   */
  getBatchWithItems(batchId: BatchId): Promise<BatchWithItems | null>;
}
