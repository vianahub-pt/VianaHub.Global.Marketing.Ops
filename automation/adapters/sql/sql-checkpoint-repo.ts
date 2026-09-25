/**
 * SQL Server implementation of CheckpointRepository (Sprint 5 — I-2, AC-23..AC-26).
 *
 * Rows map to `dbo.Checkpoints` (database/migrations/001_initial_schema.sql):
 * - Append-only by contract (AC-23): only `create`, `getLatest` and
 *   `listByRunId` exist — there is no update or delete path, and the
 *   adapter never issues destructive statements against dbo.Checkpoints.
 * - `CheckpointId` is a surrogate key; ordering is
 *   `CreatedAt ASC, Attempt ASC, CheckpointId ASC` (AC-25), matching the
 *   chronological order produced by FileCheckpointRepository.
 * - `PayloadJson` is validated JSON on read (AC-24, AC-35): a row that
 *   fails parsing or schema validation throws `CorruptedRecordError`.
 *
 * All statements are static string constants — never built from
 * interpolated or concatenated input (AC-36).
 */

import { z } from "zod";

import type { RunId } from "../../domain/idempotency.js";
import type { RunState } from "../../domain/run-state.js";
import type { CheckpointDto, CheckpointRepository } from "../checkpoint-repository.js";
import { CorruptedRecordError } from "../persistence-errors.js";
import type { SqlExecutor, SqlQueryResult } from "./sql-pool.js";
import { parseJsonColumn, rowToObject, toDate } from "./sql-row-helpers.js";

// ─── Static statements (AC-36: no interpolation, no concatenation) ───────────

export const INSERT_CHECKPOINT_SQL =
  "INSERT INTO dbo.Checkpoints (RunId, SchemaVersion, State, Attempt, PayloadJson, CreatedAt) VALUES (@runId, 1, @state, @attempt, @payloadJson, @createdAt)";

export const SELECT_LATEST_CHECKPOINT_SQL =
  "SELECT TOP (1) CheckpointId, RunId, SchemaVersion, State, Attempt, PayloadJson, CreatedAt FROM dbo.Checkpoints WHERE RunId = @runId ORDER BY CreatedAt DESC, Attempt DESC, CheckpointId DESC";

export const SELECT_CHECKPOINTS_BY_RUN_SQL =
  "SELECT CheckpointId, RunId, SchemaVersion, State, Attempt, PayloadJson, CreatedAt FROM dbo.Checkpoints WHERE RunId = @runId ORDER BY CreatedAt ASC, Attempt ASC, CheckpointId ASC";

// ─── Validation ──────────────────────────────────────────────────────────────

const runStateSchema = z.enum([
  "queued",
  "running",
  "waiting_manual",
  "succeeded",
  "failed",
  "cancelled",
]);

export const checkpointDtoSchema = z
  .object({
    runId: z.string(),
    state: runStateSchema,
    attempt: z.number(),
    payload: z.record(z.unknown()),
    createdAt: z.string(),
  })
  .strict();

// ─── Row helpers ─────────────────────────────────────────────────────────────

/**
 * Validates the `PayloadJson` column: the generic text/JSON conversion
 * errors come from the shared `parseJsonColumn` (context `checkpoint of
 * run`, `empty: "none"` — even SQL `NULL` is corruption here), and only
 * the record-shape validation stays local.
 */
function parsePayloadJson(value: unknown, runId: unknown): Record<string, unknown> {
  const parsed = parseJsonColumn(value, "PayloadJson", runId, {
    noun: "checkpoint of run",
    empty: "none",
  });
  const validated = z.record(z.unknown()).safeParse(parsed);
  if (!validated.success) {
    throw new CorruptedRecordError(
      `Invalid PayloadJson for checkpoint of run ${String(runId)}: ${validated.error.message}`,
    );
  }
  return validated.data;
}

/**
 * Maps a `dbo.Checkpoints` row (positional) to a validated `CheckpointDto`.
 *
 * @throws {CorruptedRecordError} when a column cannot be interpreted or
 *   the assembled DTO fails schema validation (CK-04 parity).
 */
function mapCheckpointRow(result: SqlQueryResult, row: readonly unknown[]): CheckpointDto {
  const raw = rowToObject(result.columns, row);
  const createdAt = toDate(raw.CreatedAt, {
    column: "CreatedAt",
    noun: "checkpoint of run",
    recordId: raw.RunId,
  });
  const candidate = {
    runId: raw.RunId as RunId,
    state: raw.State as RunState,
    attempt: raw.Attempt as number,
    payload: parsePayloadJson(raw.PayloadJson, raw.RunId),
    createdAt: createdAt.toISOString(),
  };
  const parsed = checkpointDtoSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CorruptedRecordError(
      `Invalid checkpoint for run ${String(raw.RunId)}: ${parsed.error.message}`,
    );
  }
  return parsed.data as CheckpointDto;
}

// ─── SqlCheckpointRepository ─────────────────────────────────────────────────

/**
 * `CheckpointRepository` backed by a `SqlExecutor` over `dbo.Checkpoints`.
 *
 * The executor is injected, so unit tests exercise this adapter against
 * the deterministic fake without a live SQL Server (AC-36, AC-49).
 */
export class SqlCheckpointRepository implements CheckpointRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async create(checkpoint: CheckpointDto): Promise<CheckpointDto> {
    await this.executor.query(INSERT_CHECKPOINT_SQL, {
      runId: checkpoint.runId,
      state: checkpoint.state,
      attempt: checkpoint.attempt,
      payloadJson: JSON.stringify(checkpoint.payload),
      createdAt: new Date(checkpoint.createdAt),
    });
    return checkpoint;
  }

  async getLatest(runId: RunId): Promise<CheckpointDto | null> {
    const result = await this.executor.query(SELECT_LATEST_CHECKPOINT_SQL, { runId });
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return mapCheckpointRow(result, row);
  }

  async listByRunId(runId: RunId): Promise<CheckpointDto[]> {
    const result = await this.executor.query(SELECT_CHECKPOINTS_BY_RUN_SQL, { runId });
    return result.rows.map((row) => mapCheckpointRow(result, row));
  }
}
