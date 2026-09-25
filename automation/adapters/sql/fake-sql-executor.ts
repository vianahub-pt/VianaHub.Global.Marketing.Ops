/**
 * Deterministic in-memory SQL executor for unit tests (Sprint 5 — I-2).
 *
 * Implements the injectable `SqlExecutor` contract by dispatching on the
 * exact statement text produced by the repository modules, so tests
 * exercise the real SQL strings without a live SQL Server (AC-36, AC-49).
 *
 * Simulated behavior (AC-19, AC-22, AC-36):
 * - Statement identity is matched against the exported `*_SQL` constants —
 *   never by parsing `@params` into executable SQL.
 * - Constraint failures are raised as `SqlExecutorError` with the same
 *   messages SQL Server produces for PK_Runs, UQ_Runs_IdempotencyKey,
 *   FK_Checkpoints_Runs, CK_Runs_State, CK_Runs_PayloadFingerprint,
 *   CK_Runs_MetadataJson and CK_Checkpoints_PayloadJson.
 * - `transaction()` snapshots state and restores it on failure;
 *   `close()` is a no-op (auto-tests never open sockets).
 *
 * This file is not a `*.test.ts` artifact: it ships in build/coverage so
 * repository tests can import it directly.
 */

import {
  INSERT_RUN_SQL,
  SELECT_RUN_BY_IDEMPOTENCY_SQL,
  SELECT_RUN_BY_ID_SQL,
  SELECT_RUN_REVISION_SQL,
  SELECT_RUNS_SQL,
  UPDATE_RUN_GUARDED_SQL,
  UPDATE_RUN_SQL,
} from "./sql-run-repo.js";
import {
  INSERT_CHECKPOINT_SQL,
  SELECT_CHECKPOINTS_BY_RUN_SQL,
  SELECT_LATEST_CHECKPOINT_SQL,
} from "./sql-checkpoint-repo.js";
import { SqlExecutorError } from "./sql-pool.js";
import type { SqlExecutor, SqlQueryResult, SqlStatement } from "./sql-pool.js";

// ─── Stored row shapes ───────────────────────────────────────────────────────

export interface StoredRunRow {
  RunId: string;
  SchemaVersion: number;
  BrandId: string;
  Market: string;
  Platform: string;
  Operation: string;
  State: string;
  Attempt: number;
  MaxAttempts: number;
  IdempotencyKey: string;
  PayloadFingerprint: string;
  CreatedAt: Date;
  UpdatedAt: Date;
  StartedAt: Date | null;
  FinishedAt: Date | null;
  ErrorMessage: string | null;
  ErrorCode: string | null;
  ErrorRetryable: boolean | null;
  MetadataJson: string | null;
  Revision: number;
  StoredAt: Date;
}

export interface StoredCheckpointRow {
  CheckpointId: number;
  RunId: string;
  SchemaVersion: number;
  State: string;
  Attempt: number;
  PayloadJson: string;
  CreatedAt: Date;
}

const RUN_DOMAIN_COLUMNS: readonly (keyof StoredRunRow)[] = [
  "RunId",
  "SchemaVersion",
  "BrandId",
  "Market",
  "Platform",
  "Operation",
  "State",
  "Attempt",
  "MaxAttempts",
  "IdempotencyKey",
  "PayloadFingerprint",
  "CreatedAt",
  "UpdatedAt",
  "StartedAt",
  "FinishedAt",
  "ErrorMessage",
  "ErrorCode",
  "ErrorRetryable",
  "MetadataJson",
];

const CHECKPOINT_COLUMNS: readonly (keyof StoredCheckpointRow)[] = [
  "CheckpointId",
  "RunId",
  "SchemaVersion",
  "State",
  "Attempt",
  "PayloadJson",
  "CreatedAt",
];

const RUN_STATES: readonly string[] = [
  "queued",
  "running",
  "waiting_manual",
  "succeeded",
  "failed",
  "cancelled",
];

const SET_ASSIGNMENT_PATTERN = /(\w+) = (@\w+|Revision \+ 1)/g;

// ─── Constraint messages (SQL Server wording) ────────────────────────────────

const PK_RUNS_MESSAGE =
  "Violation of PRIMARY KEY constraint 'PK_Runs'. Cannot insert duplicate key in object 'dbo.Runs'.";
const UQ_IDEMPOTENCY_MESSAGE =
  "Violation of UNIQUE KEY constraint 'UQ_Runs_IdempotencyKey'. Cannot insert duplicate key in object 'dbo.Runs'.";
const FK_CHECKPOINTS_MESSAGE =
  'The INSERT statement conflicted with the FOREIGN KEY constraint "FK_Checkpoints_Runs".';
const CK_RUN_STATE_MESSAGE =
  'The INSERT statement conflicted with the CHECK constraint "CK_Runs_State".';
const CK_FINGERPRINT_MESSAGE =
  'The INSERT statement conflicted with the CHECK constraint "CK_Runs_PayloadFingerprint".';
const CK_METADATA_MESSAGE =
  'The INSERT statement conflicted with the CHECK constraint "CK_Runs_MetadataJson".';
const CK_CHECKPOINT_PAYLOAD_MESSAGE =
  'The INSERT statement conflicted with the CHECK constraint "CK_Checkpoints_PayloadJson".';

function constraintError(message: string): SqlExecutorError {
  return new SqlExecutorError({
    code: "EREQUEST",
    message,
    action:
      "Verify the failing row against the constraints declared in database/migrations/001_initial_schema.sql.",
  });
}

function unsupportedStatementError(text: string): SqlExecutorError {
  return new SqlExecutorError({
    code: "EREQUEST",
    message: `Statement not supported by the fake SQL executor: ${text.slice(0, 160)}`,
    action:
      "Issue only the statements exported by sql-run-repo.ts / sql-checkpoint-repo.ts, or use createSqlExecutor for the real driver.",
  });
}

function isValidJson(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function projectRow<T>(row: T, columns: readonly (keyof T)[]): unknown[] {
  const values: unknown[] = [];
  for (const column of columns) {
    values.push(row[column]);
  }
  return values;
}

function setClauseOf(text: string): string {
  return text.slice(text.indexOf(" SET ") + 5, text.indexOf(" OUTPUT "));
}

// ─── FakeSqlExecutor ─────────────────────────────────────────────────────────

export interface FakeSqlExecutor extends SqlExecutor {
  /** Direct read access for assertions and seeding. */
  readonly runs: Map<string, StoredRunRow>;
  readonly checkpoints: StoredCheckpointRow[];
  /** Inserts a run row bypassing constraint checks (corruption seeds). */
  seedRun(overrides: Partial<StoredRunRow> & { readonly RunId: string }): StoredRunRow;
  /** Inserts a checkpoint row bypassing constraint checks. */
  seedCheckpoint(overrides: Partial<StoredCheckpointRow>): StoredCheckpointRow;
}

/**
 * Creates a deterministic in-memory executor over the repository SQL
 * statements. Dispatch is synchronous inside `async query()` — rows are
 * plain objects, so no I/O ordering can interleave between calls.
 */
export function createFakeSqlExecutor(): FakeSqlExecutor {
  const runs = new Map<string, StoredRunRow>();
  const checkpoints: StoredCheckpointRow[] = [];
  let nextCheckpointId = 1;

  function insertRun(bound: Readonly<Record<string, unknown>>): SqlQueryResult {
    const runId = bound["runId"] as string;
    if (runs.has(runId)) {
      throw constraintError(PK_RUNS_MESSAGE);
    }
    const idempotencyKey = bound["idempotencyKey"] as string;
    for (const row of runs.values()) {
      if (row.IdempotencyKey === idempotencyKey) {
        throw constraintError(UQ_IDEMPOTENCY_MESSAGE);
      }
    }
    const state = bound["state"] as string;
    if (!RUN_STATES.includes(state)) {
      throw constraintError(CK_RUN_STATE_MESSAGE);
    }
    const fingerprint = bound["payloadFingerprint"];
    if (typeof fingerprint !== "string" || fingerprint.length !== 64) {
      throw constraintError(CK_FINGERPRINT_MESSAGE);
    }
    const metadataJson = bound["metadataJson"] as string | null;
    if (metadataJson !== null && !isValidJson(metadataJson)) {
      throw constraintError(CK_METADATA_MESSAGE);
    }
    runs.set(runId, {
      RunId: runId,
      SchemaVersion: bound["schemaVersion"] as number,
      BrandId: bound["brandId"] as string,
      Market: bound["market"] as string,
      Platform: bound["platform"] as string,
      Operation: bound["operation"] as string,
      State: state,
      Attempt: bound["attempt"] as number,
      MaxAttempts: bound["maxAttempts"] as number,
      IdempotencyKey: idempotencyKey,
      PayloadFingerprint: fingerprint,
      CreatedAt: bound["createdAt"] as Date,
      UpdatedAt: bound["updatedAt"] as Date,
      StartedAt: bound["startedAt"] as Date | null,
      FinishedAt: bound["finishedAt"] as Date | null,
      ErrorMessage: bound["errorMessage"] as string | null,
      ErrorCode: bound["errorCode"] as string | null,
      ErrorRetryable: bound["errorRetryable"] as boolean | null,
      MetadataJson: metadataJson,
      Revision: 1,
      StoredAt: bound["storedAt"] as Date,
    });
    return { columns: [], rows: [] };
  }

  function updateRun(text: string, bound: Readonly<Record<string, unknown>>): SqlQueryResult {
    const runId = bound["runId"] as string;
    const row = runs.get(runId);
    if (row === undefined) {
      return { columns: [], rows: [] };
    }
    if (text === UPDATE_RUN_GUARDED_SQL && row.Revision !== (bound["expectedRevision"] as number)) {
      return { columns: [], rows: [] };
    }

    const next = { ...row } as unknown as Record<string, unknown>;
    for (const match of setClauseOf(text).matchAll(SET_ASSIGNMENT_PATTERN)) {
      const column = match[1];
      const expression = match[2];
      next[column] = expression === "Revision + 1" ? row.Revision + 1 : bound[expression.slice(1)];
    }
    runs.set(runId, next as unknown as StoredRunRow);
    return { columns: ["Revision"], rows: [[next["Revision"]]] };
  }

  function selectRuns(bound: Readonly<Record<string, unknown>>): SqlQueryResult {
    const filters: readonly (readonly [keyof StoredRunRow, unknown])[] = [
      ["BrandId", bound["brandId"]],
      ["Market", bound["market"]],
      ["Platform", bound["platform"]],
      ["Operation", bound["operation"]],
      ["State", bound["state"]],
    ];
    const rows = [...runs.values()]
      .filter((row) => filters.every(([column, value]) => value === "" || row[column] === value))
      .sort((a, b) => a.RunId.localeCompare(b.RunId));
    return {
      columns: RUN_DOMAIN_COLUMNS,
      rows: rows.map((row) => projectRow(row, RUN_DOMAIN_COLUMNS)),
    };
  }

  function insertCheckpoint(bound: Readonly<Record<string, unknown>>): SqlQueryResult {
    const runId = bound["runId"] as string;
    if (!runs.has(runId)) {
      throw constraintError(FK_CHECKPOINTS_MESSAGE);
    }
    const payloadJson = bound["payloadJson"];
    if (!isValidJson(payloadJson)) {
      throw constraintError(CK_CHECKPOINT_PAYLOAD_MESSAGE);
    }
    checkpoints.push({
      CheckpointId: nextCheckpointId,
      RunId: runId,
      SchemaVersion: 1,
      State: bound["state"] as string,
      Attempt: bound["attempt"] as number,
      PayloadJson: payloadJson as string,
      CreatedAt: bound["createdAt"] as Date,
    });
    nextCheckpointId += 1;
    return { columns: [], rows: [] };
  }

  function checkpointsOfRun(runId: string, descending: boolean): StoredCheckpointRow[] {
    const rows = checkpoints.filter((row) => row.RunId === runId);
    return rows.sort((a, b) => {
      const byDate = descending
        ? b.CreatedAt.getTime() - a.CreatedAt.getTime()
        : a.CreatedAt.getTime() - b.CreatedAt.getTime();
      if (byDate !== 0) {
        return byDate;
      }
      const byAttempt = descending ? b.Attempt - a.Attempt : a.Attempt - b.Attempt;
      if (byAttempt !== 0) {
        return byAttempt;
      }
      return descending ? b.CheckpointId - a.CheckpointId : a.CheckpointId - b.CheckpointId;
    });
  }

  function selectCheckpointRows(rows: readonly StoredCheckpointRow[]): SqlQueryResult {
    return {
      columns: CHECKPOINT_COLUMNS,
      rows: rows.map((row) => projectRow(row, CHECKPOINT_COLUMNS)),
    };
  }

  const executor: FakeSqlExecutor = {
    runs,
    checkpoints,

    seedRun(overrides) {
      const row: StoredRunRow = {
        SchemaVersion: 1,
        BrandId: "best-fluency",
        Market: "PT",
        Platform: "google_business_profile",
        Operation: "sync_listings",
        State: "queued",
        Attempt: 0,
        MaxAttempts: 3,
        IdempotencyKey: `seed-idem-${overrides.RunId}`,
        PayloadFingerprint: "f".repeat(64),
        CreatedAt: new Date("2026-01-01T00:00:00.000Z"),
        UpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
        StartedAt: null,
        FinishedAt: null,
        ErrorMessage: null,
        ErrorCode: null,
        ErrorRetryable: null,
        MetadataJson: null,
        Revision: 1,
        StoredAt: new Date("2026-01-01T00:00:00.000Z"),
        ...overrides,
        RunId: overrides.RunId,
      };
      runs.set(row.RunId, row);
      return row;
    },

    seedCheckpoint(overrides) {
      const row: StoredCheckpointRow = {
        CheckpointId: nextCheckpointId,
        RunId: "seed-run",
        SchemaVersion: 1,
        State: "running",
        Attempt: 0,
        PayloadJson: "{}",
        CreatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...overrides,
      };
      nextCheckpointId += 1;
      checkpoints.push(row);
      return row;
    },

    async query(text, params) {
      const bound = params ?? {};

      if (text === INSERT_RUN_SQL) {
        return insertRun(bound);
      }
      if (text === UPDATE_RUN_SQL || text === UPDATE_RUN_GUARDED_SQL) {
        return updateRun(text, bound);
      }
      if (text === SELECT_RUN_BY_ID_SQL) {
        const row = runs.get(bound["runId"] as string);
        if (row === undefined) {
          return { columns: RUN_DOMAIN_COLUMNS, rows: [] };
        }
        return { columns: RUN_DOMAIN_COLUMNS, rows: [projectRow(row, RUN_DOMAIN_COLUMNS)] };
      }
      if (text === SELECT_RUN_BY_IDEMPOTENCY_SQL) {
        const key = bound["idempotencyKey"] as string;
        for (const row of runs.values()) {
          if (row.IdempotencyKey === key) {
            return { columns: RUN_DOMAIN_COLUMNS, rows: [projectRow(row, RUN_DOMAIN_COLUMNS)] };
          }
        }
        return { columns: RUN_DOMAIN_COLUMNS, rows: [] };
      }
      if (text === SELECT_RUN_REVISION_SQL) {
        const row = runs.get(bound["runId"] as string);
        if (row === undefined) {
          return { columns: ["Revision"], rows: [] };
        }
        return { columns: ["Revision"], rows: [[row.Revision]] };
      }
      if (text === SELECT_RUNS_SQL) {
        return selectRuns(bound);
      }
      if (text === INSERT_CHECKPOINT_SQL) {
        return insertCheckpoint(bound);
      }
      if (text === SELECT_CHECKPOINTS_BY_RUN_SQL) {
        return selectCheckpointRows(checkpointsOfRun(bound["runId"] as string, false));
      }
      if (text === SELECT_LATEST_CHECKPOINT_SQL) {
        const rows = checkpointsOfRun(bound["runId"] as string, true);
        const first = rows[0];
        return selectCheckpointRows(first === undefined ? [] : [first]);
      }

      throw unsupportedStatementError(text);
    },

    async transaction(statements) {
      const runsSnapshot = new Map<string, StoredRunRow>();
      for (const [key, value] of runs) {
        runsSnapshot.set(key, { ...value });
      }
      const checkpointsSnapshot = checkpoints.map((row) => ({ ...row }));
      const counterSnapshot = nextCheckpointId;

      try {
        for (const statement of statements) {
          await executor.query(statement.text, statement.params);
        }
      } catch (error) {
        runs.clear();
        for (const [key, value] of runsSnapshot) {
          runs.set(key, value);
        }
        checkpoints.splice(0, checkpoints.length, ...checkpointsSnapshot);
        nextCheckpointId = counterSnapshot;
        throw error;
      }
    },

    close(): Promise<void> {
      return Promise.resolve();
    },
  };

  return executor;
}

// Re-exported for statement-identity assertions in tests.
export type { SqlStatement };
