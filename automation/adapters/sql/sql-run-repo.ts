/**
 * SQL Server implementation of RunRepository (Sprint 5 — I-2, AC-14..AC-22).
 *
 * Rows map to `dbo.Runs` (database/migrations/001_initial_schema.sql):
 * - `Revision` is persistence-only metadata (AC-15): it starts at 1, is
 *   incremented on every successful update and never appears in the
 *   domain `RunRecord`.
 * - Optimistic concurrency (AC-21): `update` accepts an optional
 *   `expectedRevision`; a mismatch throws `ConcurrencyConflictError`,
 *   mirroring FileRunRepository (AC-20).
 * - Idempotent create (AC-17, AC-22): a failed insert is recovered by
 *   probing by runId first and by idempotency key second; when no durable
 *   record explains the failure, the original driver error is rethrown.
 *
 * All statements are static string constants — never built from
 * interpolated or concatenated input (AC-36).
 */

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../../domain/idempotency.js";
import type { RunListFilters, RunRepository } from "../../domain/repository.js";
import { runRecordSchema, type RunRecord } from "../../domain/run-record.js";
import type { RunState } from "../../domain/run-state.js";
import { ConcurrencyConflictError, CorruptedRecordError } from "../persistence-errors.js";
import type { SqlExecutor, SqlQueryResult } from "./sql-pool.js";
import { parseJsonColumn, rowToObject, toDate, toOptionalDate } from "./sql-row-helpers.js";

// ─── Static statements (AC-36: no interpolation, no concatenation) ───────────

export const INSERT_RUN_SQL =
  "INSERT INTO dbo.Runs (RunId, SchemaVersion, BrandId, Market, Platform, Operation, State, Attempt, MaxAttempts, IdempotencyKey, PayloadFingerprint, CreatedAt, UpdatedAt, StartedAt, FinishedAt, ErrorMessage, ErrorCode, ErrorRetryable, MetadataJson, Revision, StoredAt) VALUES (@runId, @schemaVersion, @brandId, @market, @platform, @operation, @state, @attempt, @maxAttempts, @idempotencyKey, @payloadFingerprint, @createdAt, @updatedAt, @startedAt, @finishedAt, @errorMessage, @errorCode, @errorRetryable, @metadataJson, 1, @storedAt)";

export const SELECT_RUN_BY_ID_SQL =
  "SELECT RunId, SchemaVersion, BrandId, Market, Platform, Operation, State, Attempt, MaxAttempts, IdempotencyKey, PayloadFingerprint, CreatedAt, UpdatedAt, StartedAt, FinishedAt, ErrorMessage, ErrorCode, ErrorRetryable, MetadataJson FROM dbo.Runs WHERE RunId = @runId";

export const SELECT_RUN_BY_IDEMPOTENCY_SQL =
  "SELECT RunId, SchemaVersion, BrandId, Market, Platform, Operation, State, Attempt, MaxAttempts, IdempotencyKey, PayloadFingerprint, CreatedAt, UpdatedAt, StartedAt, FinishedAt, ErrorMessage, ErrorCode, ErrorRetryable, MetadataJson FROM dbo.Runs WHERE IdempotencyKey = @idempotencyKey";

export const SELECT_RUNS_SQL =
  "SELECT RunId, SchemaVersion, BrandId, Market, Platform, Operation, State, Attempt, MaxAttempts, IdempotencyKey, PayloadFingerprint, CreatedAt, UpdatedAt, StartedAt, FinishedAt, ErrorMessage, ErrorCode, ErrorRetryable, MetadataJson FROM dbo.Runs WHERE (@brandId = N'' OR BrandId = @brandId) AND (@market = N'' OR Market = @market) AND (@platform = N'' OR Platform = @platform) AND (@operation = N'' OR Operation = @operation) AND (@state = N'' OR State = @state) ORDER BY RunId ASC";

export const UPDATE_RUN_SQL =
  "UPDATE dbo.Runs SET SchemaVersion = @schemaVersion, BrandId = @brandId, Market = @market, Platform = @platform, Operation = @operation, State = @state, Attempt = @attempt, MaxAttempts = @maxAttempts, IdempotencyKey = @idempotencyKey, PayloadFingerprint = @payloadFingerprint, CreatedAt = @createdAt, UpdatedAt = @updatedAt, StartedAt = @startedAt, FinishedAt = @finishedAt, ErrorMessage = @errorMessage, ErrorCode = @errorCode, ErrorRetryable = @errorRetryable, MetadataJson = @metadataJson, Revision = Revision + 1, StoredAt = @storedAt OUTPUT inserted.Revision WHERE RunId = @runId";

export const UPDATE_RUN_GUARDED_SQL =
  "UPDATE dbo.Runs SET SchemaVersion = @schemaVersion, BrandId = @brandId, Market = @market, Platform = @platform, Operation = @operation, State = @state, Attempt = @attempt, MaxAttempts = @maxAttempts, IdempotencyKey = @idempotencyKey, PayloadFingerprint = @payloadFingerprint, CreatedAt = @createdAt, UpdatedAt = @updatedAt, StartedAt = @startedAt, FinishedAt = @finishedAt, ErrorMessage = @errorMessage, ErrorCode = @errorCode, ErrorRetryable = @errorRetryable, MetadataJson = @metadataJson, Revision = Revision + 1, StoredAt = @storedAt OUTPUT inserted.Revision WHERE RunId = @runId AND Revision = @expectedRevision";

export const SELECT_RUN_REVISION_SQL = "SELECT Revision FROM dbo.Runs WHERE RunId = @runId";

/**
 * Maps a `dbo.Runs` row (positional) to a validated domain `RunRecord`.
 *
 * @throws {CorruptedRecordError} when a column cannot be interpreted or
 *   the assembled record fails `runRecordSchema` (FR-07 parity).
 */
function mapRunRow(result: SqlQueryResult, row: readonly unknown[]): RunRecord {
  const raw = rowToObject(result.columns, row);
  const candidate = {
    schemaVersion: raw.SchemaVersion as number,
    runId: raw.RunId as RunId,
    brandId: raw.BrandId as string,
    market: raw.Market as string,
    platform: raw.Platform as string,
    operation: raw.Operation as string,
    state: raw.State as RunState,
    attempt: raw.Attempt as number,
    maxAttempts: raw.MaxAttempts as number,
    idempotencyKey: raw.IdempotencyKey as IdempotencyKey,
    payloadFingerprint: raw.PayloadFingerprint as PayloadFingerprint,
    createdAt: toDate(raw.CreatedAt, { table: "dbo.Runs" }),
    updatedAt: toDate(raw.UpdatedAt, { table: "dbo.Runs" }),
    startedAt: toOptionalDate(raw.StartedAt, { table: "dbo.Runs" }),
    finishedAt: toOptionalDate(raw.FinishedAt, { table: "dbo.Runs" }),
    error:
      raw.ErrorMessage === null
        ? undefined
        : {
            message: raw.ErrorMessage as string,
            code: raw.ErrorCode === null ? undefined : (raw.ErrorCode as string),
            retryable: raw.ErrorRetryable === null ? undefined : raw.ErrorRetryable === true,
          },
    metadata: parseJsonColumn(raw.MetadataJson, "MetadataJson", raw.RunId, {
      noun: "run",
      empty: "null",
    }),
  };

  const parsed = runRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CorruptedRecordError(
      `Invalid run record in dbo.Runs for run ${String(raw.RunId)}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Builds the fully-bound parameter set shared by INSERT/UPDATE statements.
 *
 * Optional columns are always bound (as `null` when absent) so the driver
 * never infers a type from an omitted parameter.
 */
function recordParams(record: RunRecord, storedAt: Date): Record<string, unknown> {
  return {
    runId: record.runId,
    schemaVersion: record.schemaVersion,
    brandId: record.brandId,
    market: record.market,
    platform: record.platform,
    operation: record.operation,
    state: record.state,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    idempotencyKey: record.idempotencyKey,
    payloadFingerprint: record.payloadFingerprint,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
    errorMessage: record.error?.message ?? null,
    errorCode: record.error?.code ?? null,
    errorRetryable: record.error?.retryable ?? null,
    metadataJson: record.metadata === undefined ? null : JSON.stringify(record.metadata),
    storedAt,
  };
}

/**
 * Sentinel for list filters: `undefined` binds as `""` (predicate matches
 * everything), a real empty-string filter binds as `"\u0001"` so it can
 * never match — the domain forbids empty identity fields, and the file
 * adapter therefore returns `[]` for an empty-string filter too.
 */
function filterParam(value: string | undefined): string {
  if (value === undefined) {
    return "";
  }
  if (value === "") {
    return "\u0001";
  }
  return value;
}

// ─── SqlRunRepository ────────────────────────────────────────────────────────

/**
 * `RunRepository` backed by a `SqlExecutor` over `dbo.Runs`.
 *
 * The executor is injected, so unit tests exercise this adapter against
 * the deterministic fake without a live SQL Server (AC-36, AC-49).
 */
export class SqlRunRepository implements RunRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async create(record: RunRecord): Promise<RunRecord> {
    try {
      await this.executor.query(INSERT_RUN_SQL, recordParams(record, new Date()));
      return record;
    } catch (cause) {
      const recovered = await this.recoverCreate(record);
      if (recovered !== null) {
        return recovered;
      }
      throw cause;
    }
  }

  async getById(runId: RunId): Promise<RunRecord | null> {
    const result = await this.executor.query(SELECT_RUN_BY_ID_SQL, { runId });
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return mapRunRow(result, row);
  }

  /**
   * Updates an existing run record with optional optimistic concurrency.
   *
   * When `expectedRevision` is provided the guarded statement only matches
   * when the stored revision is still the expected one; on zero matched
   * rows a probe distinguishes "not found" from "concurrency conflict"
   * (AC-20, AC-21).
   */
  async update(record: RunRecord, expectedRevision?: number): Promise<RunRecord> {
    const params = recordParams(record, new Date());

    if (expectedRevision === undefined) {
      const result = await this.executor.query(UPDATE_RUN_SQL, params);
      if (result.rows.length === 0) {
        throw new Error(`Record not found: ${record.runId}`);
      }
      return record;
    }

    const guarded = await this.executor.query(UPDATE_RUN_GUARDED_SQL, {
      ...params,
      expectedRevision,
    });
    if (guarded.rows.length === 0) {
      await this.throwUpdateFailure(record.runId, expectedRevision);
    }
    return record;
  }

  async list(filters?: RunListFilters): Promise<RunRecord[]> {
    const result = await this.executor.query(SELECT_RUNS_SQL, {
      brandId: filterParam(filters?.brandId),
      market: filterParam(filters?.market),
      platform: filterParam(filters?.platform),
      operation: filterParam(filters?.operation),
      state: filterParam(filters?.state),
    });
    return result.rows.map((row) => mapRunRow(result, row));
  }

  async findByIdempotencyKey(key: IdempotencyKey): Promise<RunRecord | null> {
    const result = await this.executor.query(SELECT_RUN_BY_IDEMPOTENCY_SQL, {
      idempotencyKey: key,
    });
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return mapRunRow(result, row);
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Distinguishes a failed guarded update from a missing record by probing
   * the current stored revision (AC-21).
   */
  private async throwUpdateFailure(runId: RunId, expectedRevision: number): Promise<never> {
    const probe = await this.executor.query(SELECT_RUN_REVISION_SQL, { runId });
    const row = probe.rows[0];
    if (row === undefined) {
      throw new Error(`Record not found: ${runId}`);
    }
    throw new ConcurrencyConflictError({
      recordId: runId,
      expectedRevision,
      actualRevision: Number(row[0]),
    });
  }

  /**
   * Recovery flow for a failed insert (AC-17, AC-22):
   * 1. Probe by runId — an existing run means "already exists".
   * 2. Probe by idempotency key — a winner means the caller's logical
   *    operation already succeeded; return the durable record.
   * 3. Anything else (including probe failures) returns `null` so the
   *    original driver error is rethrown by `create`.
   */
  private async recoverCreate(record: RunRecord): Promise<RunRecord | null> {
    let existing: RunRecord | null;
    try {
      existing = await this.getById(record.runId);
    } catch {
      return null;
    }
    if (existing !== null) {
      throw new Error(`Record already exists: ${record.runId}`);
    }
    try {
      return await this.findByIdempotencyKey(record.idempotencyKey);
    } catch {
      return null;
    }
  }
}
