/**
 * SQL Server implementation of BatchRepository (Sprint 5 — I-3c, AC-30..AC-32, D-04).
 *
 * Rows map to `dbo.Batches` and `dbo.BatchItems`
 * (database/migrations/001_initial_schema.sql):
 * - Separate tables + referential integrity (AC-30): every batch job is
 *   persisted in `dbo.Batches` and every item in `dbo.BatchItems`, linked
 *   by `FK_BatchItems_Batches`. A failed item insert or update is probed:
 *   an absent parent/target batch surfaces as `Record not found:
 *   <batchId>`, an absent item as `Record not found: <itemId>` and a
 *   duplicate insert as `Record already exists: <itemId>` — message
 *   parity with the shared repository convention (`Record already
 *   exists:` / `Record not found:`).
 * - No revision semantics (AC-31, decision D-04 Opção A): `BatchJob` has
 *   no `revision` field in the domain and the frozen DDL carries no
 *   Revision column, so this adapter never reads, writes or invents
 *   revision/concurrency behaviour. Nothing SQL-only leaks into the
 *   contract (AC-32); `updateJob` only fails with "not found".
 * - Contract conformance (AC-32): the public surface is exactly
 *   `BatchRepository` — no SQL-only methods or parameters; error messages
 *   follow the shared convention of the existing file repositories
 *   (`file-run-repo.ts`, `file-schedule-repo.ts`): `Record already
 *   exists:` / `Record not found:`.
 * - Round-trip: every row is validated with `batchJobSchema` /
 *   `batchItemSchema`; an invalid row raises `CorruptedRecordError`
 *   (FR-07 parity with the repository error semantics, including invalid
 *   JSON in `MetadataJson`).
 * - Statements are static exported constants — never built from
 *   interpolated or concatenated input (AC-36); SQL is 100% parameterized
 *   and `Date` values are bound as `DateTime2(3)` by `sql-pool.ts`
 *   (`applyParams`).
 * - Executor failures propagate unchanged as `SqlExecutorError`
 *   (error-mapping.ts) so sanitized messages and actions are preserved.
 */

import type {
  BatchItemFilters,
  BatchRepository,
  BatchWithItems,
} from "../../domain/batch-repository.js";
import {
  batchItemSchema,
  batchJobSchema,
  type BatchId,
  type BatchItem,
  type BatchItemId,
  type BatchJob,
  type BatchStatus,
} from "../../domain/batch-schema.js";
import { CorruptedRecordError } from "../persistence-errors.js";
import type { SqlExecutor, SqlQueryResult } from "./sql-pool.js";
import { parseJsonColumn, rowToObject, toDate, toOptionalString } from "./sql-row-helpers.js";

// ─── Static statements (AC-36: no interpolation, no concatenation) ───────────

export const INSERT_BATCH_SQL =
  "INSERT INTO dbo.Batches (BatchId, SchemaVersion, Status, TotalItems, CompletedItems, FailedItems, CreatedAt, UpdatedAt, MetadataJson) VALUES (@batchId, @schemaVersion, @status, @totalItems, @completedItems, @failedItems, @createdAt, @updatedAt, @metadataJson)";

export const SELECT_BATCH_BY_ID_SQL =
  "SELECT BatchId, SchemaVersion, Status, TotalItems, CompletedItems, FailedItems, CreatedAt, UpdatedAt, MetadataJson FROM dbo.Batches WHERE BatchId = @batchId";

/**
 * AC-31 / D-04 Opção A: no `Revision` column exists or is written — the
 * guarded row count comes from `OUTPUT inserted.BatchId`, never from a
 * revision predicate.
 */
export const UPDATE_BATCH_SQL =
  "UPDATE dbo.Batches SET SchemaVersion = @schemaVersion, Status = @status, TotalItems = @totalItems, CompletedItems = @completedItems, FailedItems = @failedItems, CreatedAt = @createdAt, UpdatedAt = @updatedAt, MetadataJson = @metadataJson OUTPUT inserted.BatchId WHERE BatchId = @batchId";

export const SELECT_BATCHES_BY_STATUS_SQL =
  "SELECT BatchId, SchemaVersion, Status, TotalItems, CompletedItems, FailedItems, CreatedAt, UpdatedAt, MetadataJson FROM dbo.Batches WHERE Status = @status ORDER BY BatchId ASC";

export const INSERT_BATCH_ITEM_SQL =
  "INSERT INTO dbo.BatchItems (ItemId, BatchId, SchemaVersion, RunId, Status, Error, CreatedAt, UpdatedAt, MetadataJson) VALUES (@itemId, @batchId, @schemaVersion, @runId, @status, @error, @createdAt, @updatedAt, @metadataJson)";

export const SELECT_BATCH_ITEM_BY_ID_SQL =
  "SELECT ItemId, BatchId, SchemaVersion, RunId, Status, Error, CreatedAt, UpdatedAt, MetadataJson FROM dbo.BatchItems WHERE ItemId = @itemId";

export const UPDATE_BATCH_ITEM_SQL =
  "UPDATE dbo.BatchItems SET BatchId = @batchId, SchemaVersion = @schemaVersion, RunId = @runId, Status = @status, Error = @error, CreatedAt = @createdAt, UpdatedAt = @updatedAt, MetadataJson = @metadataJson OUTPUT inserted.ItemId WHERE ItemId = @itemId";

export const SELECT_BATCH_ITEMS_BY_BATCH_ID_SQL =
  "SELECT ItemId, BatchId, SchemaVersion, RunId, Status, Error, CreatedAt, UpdatedAt, MetadataJson FROM dbo.BatchItems WHERE BatchId = @batchId AND (@statusFilter = N'' OR Status = @status) ORDER BY ItemId ASC";

/**
 * Maps a `dbo.Batches` row (positional) to a validated domain `BatchJob`.
 *
 * Every field round-trips (AC-30): `MetadataJson` is parsed and validated
 * by `batchJobSchema`. There is no revision column to map — decision
 * D-04 (Opção A) aligned the DDL with the revision-less domain `BatchJob`
 * (AC-31).
 *
 * @throws {CorruptedRecordError} when a column cannot be interpreted or
 *   the assembled record fails `batchJobSchema` (FR-07 parity).
 */
function mapBatchJobRow(result: SqlQueryResult, row: readonly unknown[]): BatchJob {
  const raw = rowToObject(result.columns, row);
  const candidate = {
    schemaVersion: raw.SchemaVersion,
    batchId: raw.BatchId,
    status: raw.Status,
    totalItems: raw.TotalItems,
    completedItems: raw.CompletedItems,
    failedItems: raw.FailedItems,
    createdAt: toDate(raw.CreatedAt, {
      column: "CreatedAt",
      noun: "record",
      recordId: raw.BatchId,
    }),
    updatedAt: toDate(raw.UpdatedAt, {
      column: "UpdatedAt",
      noun: "record",
      recordId: raw.BatchId,
    }),
    metadata: parseJsonColumn(raw.MetadataJson, "MetadataJson", raw.BatchId, {
      noun: "record",
      empty: "nullOrUndefined",
    }),
  };

  const parsed = batchJobSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CorruptedRecordError(
      `Invalid batch job in dbo.Batches for batch ${String(raw.BatchId)}: ${parsed.error.message}`,
    );
  }
  return { ...parsed.data, batchId: parsed.data.batchId as BatchId };
}

/**
 * Maps a `dbo.BatchItems` row (positional) to a validated domain `BatchItem`.
 *
 * Every field round-trips (AC-30): `RunId` stays nullable (it is not a
 * foreign key — items may outlive or never create runs), `Error` maps to
 * the optional `error` field and `MetadataJson` is parsed and validated by
 * `batchItemSchema`.
 *
 * @throws {CorruptedRecordError} when a column cannot be interpreted or
 *   the assembled record fails `batchItemSchema` (FR-07 parity).
 */
function mapBatchItemRow(result: SqlQueryResult, row: readonly unknown[]): BatchItem {
  const raw = rowToObject(result.columns, row);
  const candidate = {
    schemaVersion: raw.SchemaVersion,
    itemId: raw.ItemId,
    batchId: raw.BatchId,
    runId: raw.RunId,
    status: raw.Status,
    error: toOptionalString(raw.Error, "Error", raw.ItemId, {
      noun: "record",
      empty: "nullOrUndefined",
    }),
    createdAt: toDate(raw.CreatedAt, {
      column: "CreatedAt",
      noun: "record",
      recordId: raw.ItemId,
    }),
    updatedAt: toDate(raw.UpdatedAt, {
      column: "UpdatedAt",
      noun: "record",
      recordId: raw.ItemId,
    }),
    metadata: parseJsonColumn(raw.MetadataJson, "MetadataJson", raw.ItemId, {
      noun: "record",
      empty: "nullOrUndefined",
    }),
  };

  const parsed = batchItemSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CorruptedRecordError(
      `Invalid batch item in dbo.BatchItems for item ${String(raw.ItemId)}: ${parsed.error.message}`,
    );
  }
  return {
    ...parsed.data,
    itemId: parsed.data.itemId as BatchItemId,
    batchId: parsed.data.batchId as BatchId,
  };
}

/**
 * Builds the fully-bound parameter set shared by job INSERT/UPDATE.
 *
 * Optional `metadata` is always bound (as `null` when absent) so the
 * driver never infers a type from an omitted parameter. `Date` values are
 * bound as `DateTime2(3)` by `sql-pool.ts` (`applyParams`). No revision
 * parameter exists anywhere (AC-31, D-04 Opção A).
 */
function jobParams(job: BatchJob): Record<string, unknown> {
  return {
    batchId: job.batchId,
    schemaVersion: job.schemaVersion,
    status: job.status,
    totalItems: job.totalItems,
    completedItems: job.completedItems,
    failedItems: job.failedItems,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    metadataJson: job.metadata === undefined ? null : JSON.stringify(job.metadata),
  };
}

/**
 * Builds the fully-bound parameter set shared by item INSERT/UPDATE.
 *
 * `runId` and `error` are bound as `null` when absent so the driver never
 * infers a type from an omitted parameter; `Date` values are bound as
 * `DateTime2(3)` by `sql-pool.ts` (`applyParams`).
 */
function itemParams(item: BatchItem): Record<string, unknown> {
  return {
    itemId: item.itemId,
    batchId: item.batchId,
    schemaVersion: item.schemaVersion,
    runId: item.runId,
    status: item.status,
    error: item.error ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    metadataJson: item.metadata === undefined ? null : JSON.stringify(item.metadata),
  };
}

// ─── SqlBatchRepository ──────────────────────────────────────────────────────

/**
 * `BatchRepository` backed by a `SqlExecutor` over `dbo.Batches` and
 * `dbo.BatchItems`.
 *
 * The executor is injected, so unit tests exercise this adapter against
 * the deterministic fake without a live SQL Server (AC-36, AC-49). The
 * public surface is identical to the `BatchRepository` contract, with no
 * SQL-only methods or parameters (AC-32); no filesystem/in-memory
 * BatchRepository implementation exists (spec §3/§14).
 */
export class SqlBatchRepository implements BatchRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  // ─── BatchJob CRUD ────────────────────────────────────────────────────────

  /**
   * Persists a new batch job in `dbo.Batches` (AC-30).
   *
   * @throws {Error} `Record already exists: <batchId>` when the primary
   *   key already exists — message parity with the shared repository
   *   convention (AC-32).
   */
  async createJob(job: BatchJob): Promise<BatchJob> {
    try {
      await this.executor.query(INSERT_BATCH_SQL, jobParams(job));
      return job;
    } catch (cause) {
      await this.verifyCreateJobFailure(job);
      throw cause;
    }
  }

  async getJobById(batchId: BatchId): Promise<BatchJob | null> {
    const result = await this.executor.query(SELECT_BATCH_BY_ID_SQL, { batchId });
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return mapBatchJobRow(result, row);
  }

  /**
   * Replaces an existing batch job (AC-30).
   *
   * AC-31 / D-04 Opção A: `BatchJob` carries no `revision`, so there is
   * no optimistic-concurrency check and no revision column is read or
   * written — the statement is guarded only by the primary key and the
   * contract carries no `ConcurrencyConflictError` clause, since that
   * case is inapplicable to the current domain.
   *
   * @throws {Error} `Record not found: <batchId>` when no row matched —
   *   message parity with the shared repository convention (AC-32).
   */
  async updateJob(job: BatchJob): Promise<BatchJob> {
    const result = await this.executor.query(UPDATE_BATCH_SQL, jobParams(job));
    if (result.rows.length === 0) {
      throw new Error(`Record not found: ${job.batchId}`);
    }
    return job;
  }

  // ─── BatchItem CRUD ───────────────────────────────────────────────────────

  /**
   * Persists a new batch item in `dbo.BatchItems` (AC-30).
   *
   * The item references its batch through `FK_BatchItems_Batches`; a
   * failed insert is probed so the failure surfaces as a clear,
   * repository-parity message instead of a raw driver error:
   * - existing `ItemId` → `Record already exists: <itemId>`;
   * - missing parent batch → `Record not found: <batchId>`.
   *
   * @throws {Error} on either probe outcome (AC-30, AC-32).
   */
  async createItem(item: BatchItem): Promise<BatchItem> {
    try {
      await this.executor.query(INSERT_BATCH_ITEM_SQL, itemParams(item));
      return item;
    } catch (cause) {
      await this.verifyCreateItemFailure(item);
      throw cause;
    }
  }

  async getItemById(itemId: BatchItemId): Promise<BatchItem | null> {
    const result = await this.executor.query(SELECT_BATCH_ITEM_BY_ID_SQL, { itemId });
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return mapBatchItemRow(result, row);
  }

  /**
   * Replaces an existing batch item (AC-30).
   *
   * Like `updateJob`, there is no revision semantics of any kind
   * (AC-31 / D-04 Opção A) — the statement is guarded only by the
   * primary key. The written `BatchId` must satisfy
   * `FK_BatchItems_Batches`, so a failed update is probed in the same
   * style as `createItem`: an absent item surfaces as `Record not
   * found: <itemId>`, an absent target batch as `Record not found:
   * <batchId>` — never a raw FK violation. Any other executor failure
   * rethrows unchanged (already sanitized/mapped `SqlExecutorError`).
   *
   * @throws {Error} `Record not found: <itemId>` when no row matched or
   *   the item does not exist; `Record not found: <batchId>` when the
   *   target batch is absent — message parity with the shared
   *   repository convention (AC-32).
   */
  async updateItem(item: BatchItem): Promise<BatchItem> {
    let result: SqlQueryResult;
    try {
      result = await this.executor.query(UPDATE_BATCH_ITEM_SQL, itemParams(item));
    } catch (cause) {
      await this.verifyUpdateItemFailure(item);
      throw cause;
    }
    if (result.rows.length === 0) {
      throw new Error(`Record not found: ${item.itemId}`);
    }
    return item;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  /**
   * Lists items for a batch, optionally filtered by status (AC-30).
   *
   * An absent status filter means "no filter"
   * (`(@statusFilter = N'' OR Status = @status)`), and results are
   * ordered by `ItemId ASC` for determinism.
   */
  async listItemsByBatchId(
    batchId: BatchId,
    filters?: BatchItemFilters,
  ): Promise<readonly BatchItem[]> {
    const result = await this.executor.query(SELECT_BATCH_ITEMS_BY_BATCH_ID_SQL, {
      batchId,
      statusFilter: filters?.status === undefined ? "" : "1",
      status: filters?.status ?? "",
    });
    return result.rows.map((row) => mapBatchItemRow(result, row));
  }

  /** Lists batch jobs by status, ordered by `BatchId ASC` for determinism. */
  async listJobsByStatus(status: BatchStatus): Promise<readonly BatchJob[]> {
    const result = await this.executor.query(SELECT_BATCHES_BY_STATUS_SQL, { status });
    return result.rows.map((row) => mapBatchJobRow(result, row));
  }

  /**
   * Retrieves a batch job with all its items (AC-30).
   *
   * Reads `dbo.Batches` first and `dbo.BatchItems` second; returns
   * `null` when the job does not exist (the item query is then skipped).
   */
  async getBatchWithItems(batchId: BatchId): Promise<BatchWithItems | null> {
    const jobResult = await this.executor.query(SELECT_BATCH_BY_ID_SQL, { batchId });
    const jobRow = jobResult.rows[0];
    if (jobRow === undefined) {
      return null;
    }
    const job = mapBatchJobRow(jobResult, jobRow);
    const itemResult = await this.executor.query(SELECT_BATCH_ITEMS_BY_BATCH_ID_SQL, {
      batchId,
      statusFilter: "",
      status: "",
    });
    const items = itemResult.rows.map((row) => mapBatchItemRow(itemResult, row));
    return { job, items };
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Recovery for a failed job insert: probe by BatchId — an existing row
   * means "already exists" (AC-32 message parity). A failing probe
   * returns silently so `createJob` rethrows the original executor error.
   */
  private async verifyCreateJobFailure(job: BatchJob): Promise<void> {
    let existing: BatchJob | null;
    try {
      existing = await this.getJobById(job.batchId);
    } catch {
      return;
    }
    if (existing !== null) {
      throw new Error(`Record already exists: ${job.batchId}`);
    }
  }

  /**
   * Recovery for a failed item insert (AC-30): probe by ItemId first — an
   * existing row means "already exists". Otherwise probe the parent batch
   * through the item's `BatchId`: an absent parent means the insert was
   * rejected by `FK_BatchItems_Batches`, surfaced as a clear
   * `Record not found: <batchId>` instead of the raw FK violation. Failing
   * probes return silently so `createItem` rethrows the original executor
   * error (AC-32 message parity).
   */
  private async verifyCreateItemFailure(item: BatchItem): Promise<void> {
    let existing: BatchItem | null;
    try {
      existing = await this.getItemById(item.itemId);
    } catch {
      return;
    }
    if (existing !== null) {
      throw new Error(`Record already exists: ${item.itemId}`);
    }

    let parent: BatchJob | null;
    try {
      parent = await this.getJobById(item.batchId);
    } catch {
      return;
    }
    if (parent === null) {
      throw new Error(`Record not found: ${item.batchId}`);
    }
  }

  /**
   * Recovery for a failed item update: probe by ItemId first — an absent
   * item means the statement was rejected before matching the row (or the
   * row vanished), surfaced as `Record not found: <itemId>`. Otherwise
   * probe the target batch through the item's `BatchId`: an absent target
   * means the update was rejected by `FK_BatchItems_Batches`, surfaced as
   * a clear `Record not found: <batchId>` instead of the raw FK
   * violation. When both probes succeed the original executor error is
   * unrelated to the FK, so this returns silently and `updateItem`
   * rethrows it unchanged (AC-32 message parity).
   */
  private async verifyUpdateItemFailure(item: BatchItem): Promise<void> {
    let existing: BatchItem | null;
    try {
      existing = await this.getItemById(item.itemId);
    } catch {
      return;
    }
    if (existing === null) {
      throw new Error(`Record not found: ${item.itemId}`);
    }

    let target: BatchJob | null;
    try {
      target = await this.getJobById(item.batchId);
    } catch {
      return;
    }
    if (target === null) {
      throw new Error(`Record not found: ${item.batchId}`);
    }
  }
}
