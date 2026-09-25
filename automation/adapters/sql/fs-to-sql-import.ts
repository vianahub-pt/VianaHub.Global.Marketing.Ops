/**
 * FS→SQL import module (Sprint 5 — I-4a, AC-45, AC-46, AC-48).
 *
 * Reads data from FS repositories, validates each record with the
 * existing Zod schemas, and inserts via SQL repositories.
 *
 * Design principles:
 * - **AC-45:** explicit, non-destructive FS→SQL transition. Source `.data`
 *   is read-only — the module never deletes or modifies FS files.
 * - **AC-46:** preserves IDs, states, UTC timestamps, idempotency keys,
 *   and checkpoint order (CreatedAt + Attempt).
 * - **AC-48:** no delete/write operations on the FS source.
 *
 * All dependencies are injected via interfaces — FS and SQL repos are
 * never imported directly.
 *
 * Duplicate detection: `sqlRunRepo.getById(id)` is checked before insert;
 * existing records are recorded as conflicts (never overwritten).
 */

import type { RunId } from "../../domain/idempotency.js";
import { runRecordSchema } from "../../domain/run-record.js";
import type { RunRecord } from "../../domain/run-record.js";
import { scheduleRecordSchema } from "../../domain/schedule-schema.js";
import type { ScheduleRecord } from "../../domain/schedule-schema.js";
import { auditEntrySchema, redactAuditEntry } from "../../domain/audit-entry.js";
import type { AuditEntry, AuditEntryId } from "../../domain/audit-entry.js";
import type { CheckpointDto } from "../checkpoint-repository.js";
import { checkpointDtoSchema } from "./sql-checkpoint-repo.js";

// ─── Result types ────────────────────────────────────────────────────────────

/**
 * Conflict detected during import: a record with the same ID already
 * exists in the SQL store.
 */
export interface Conflict {
  readonly id: string;
  readonly entity: "run" | "schedule" | "audit";
}

/**
 * Per-entity import counters for partial import tracking.
 */
export interface EntityCounters {
  readonly imported: number;
  readonly skipped: number;
}

/**
 * Result of a single `runFsToSqlImport` invocation.
 *
 * The import is **partial** — there is no transactional boundary across
 * entity types. If one entity type fails after another has succeeded, the
 * successfully imported records remain in SQL. Use `byEntity` to determine
 * exactly which entity types were imported or skipped.
 */
export interface ImportResult {
  readonly imported: number;
  readonly skipped: number;
  readonly conflicts: Conflict[];
  readonly errors: Error[];
  readonly byEntity: {
    readonly runs: EntityCounters;
    readonly checkpoints: EntityCounters;
    readonly schedules: EntityCounters;
    readonly audit: EntityCounters;
  };
}

/**
 * Mutable version of `ImportResult` used internally during import.
 * Returned as `ImportResult` to the caller.
 */
interface MutableImportResult {
  imported: number;
  skipped: number;
  conflicts: Conflict[];
  errors: Error[];
  byEntity: {
    runs: { imported: number; skipped: number };
    checkpoints: { imported: number; skipped: number };
    schedules: { imported: number; skipped: number };
    audit: { imported: number; skipped: number };
  };
}

// ─── Injected dependency interfaces ──────────────────────────────────────────

/**
 * Minimal FS repository contracts for reading data.
 * Only the methods used by the import are declared.
 */
export interface FsRunRepo {
  list(): Promise<RunRecord[]>;
}

export interface FsCheckpointRepo {
  listByRunId(runId: RunId): Promise<CheckpointDto[]>;
}

export interface FsScheduleRepo {
  list(): Promise<ScheduleRecord[]>;
}

export interface FsAuditRepo {
  readAll(): Promise<AuditEntry[]>;
}

/**
 * Minimal SQL repository contracts for writing data.
 * `getById` is used for duplicate detection.
 */
export interface SqlRunRepo {
  create(record: RunRecord): Promise<RunRecord>;
  getById(runId: RunId): Promise<RunRecord | null>;
}

export interface SqlCheckpointRepo {
  create(checkpoint: CheckpointDto): Promise<CheckpointDto>;
}

export interface SqlScheduleRepo {
  create(record: ScheduleRecord): Promise<ScheduleRecord>;
  getById(scheduleId: string): Promise<ScheduleRecord | null>;
}

export interface SqlAuditRepo {
  append(entry: AuditEntry): Promise<AuditEntry>;
}

// ─── Import options ──────────────────────────────────────────────────────────

export interface ImportOptions {
  readonly fsRunRepo: FsRunRepo;
  readonly fsCheckpointRepo: FsCheckpointRepo;
  readonly fsScheduleRepo: FsScheduleRepo;
  readonly fsAuditRepo: FsAuditRepo;
  readonly sqlRunRepo: SqlRunRepo;
  readonly sqlCheckpointRepo: SqlCheckpointRepo;
  readonly sqlScheduleRepo: SqlScheduleRepo;
  readonly sqlAuditRepo: SqlAuditRepo;
  /**
   * When `true`, reads and validates all data but does NOT write to SQL.
   * Conflicts are still detected via `getById` (AC-45).
   */
  readonly dryRun?: boolean;
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Performs an FS→SQL data import for all entity types.
 *
 * Reads from the injected FS repositories, validates each record with
 * the domain Zod schemas, detects duplicates via `getById`, and inserts
 * into the SQL repositories.
 *
 * The FS source is never modified (AC-48).
 *
 * @param options Injected FS/SQL repositories and configuration.
 * @returns Summary of the import operation.
 */
export async function runFsToSqlImport(options: ImportOptions): Promise<ImportResult> {
  const {
    fsRunRepo,
    fsCheckpointRepo,
    fsScheduleRepo,
    fsAuditRepo,
    sqlRunRepo,
    sqlCheckpointRepo,
    sqlScheduleRepo,
    sqlAuditRepo,
    dryRun = false,
  } = options;

  const result: MutableImportResult = {
    imported: 0,
    skipped: 0,
    conflicts: [],
    errors: [],
    byEntity: {
      runs: { imported: 0, skipped: 0 },
      checkpoints: { imported: 0, skipped: 0 },
      schedules: { imported: 0, skipped: 0 },
      audit: { imported: 0, skipped: 0 },
    },
  };

  // ── Runs (AC-45, AC-46) ────────────────────────────────────────────────────
  const {
    imported: runImported,
    skipped: runSkipped,
    runIds,
  } = await importRuns(fsRunRepo, sqlRunRepo, dryRun, result);
  result.imported += runImported;
  result.skipped += runSkipped;
  result.byEntity.runs = { imported: runImported, skipped: runSkipped };

  // ── Checkpoints (AC-46: order by CreatedAt + Attempt) ───────────────────────
  const { imported: checkpointImported, skipped: checkpointSkipped } = await importCheckpoints(
    runIds,
    fsCheckpointRepo,
    sqlCheckpointRepo,
    dryRun,
    result,
  );
  result.imported += checkpointImported;
  result.skipped += checkpointSkipped;
  result.byEntity.checkpoints = { imported: checkpointImported, skipped: checkpointSkipped };

  // ── Schedules (AC-45, AC-46) ───────────────────────────────────────────────
  const { imported: scheduleImported, skipped: scheduleSkipped } = await importSchedules(
    fsScheduleRepo,
    sqlScheduleRepo,
    dryRun,
    result,
  );
  result.imported += scheduleImported;
  result.skipped += scheduleSkipped;
  result.byEntity.schedules = { imported: scheduleImported, skipped: scheduleSkipped };

  // ── Audit entries (AC-46) ──────────────────────────────────────────────────
  const { imported: auditImported, skipped: auditSkipped } = await importAuditEntries(
    fsAuditRepo,
    sqlAuditRepo,
    dryRun,
    result,
  );
  result.imported += auditImported;
  result.skipped += auditSkipped;
  result.byEntity.audit = { imported: auditImported, skipped: auditSkipped };

  return result as ImportResult;
}

// ─── Run import ──────────────────────────────────────────────────────────────

/**
 * Imports runs from FS to SQL.
 *
 * - Validates each record with `runRecordSchema`.
 * - Checks for duplicates via `sqlRunRepo.getById(runId)`.
 * - Preserves IDs, states, timestamps, idempotency keys (AC-46).
 * - Does NOT modify the FS source (AC-48).
 */
async function importRuns(
  fsRepo: FsRunRepo,
  sqlRepo: SqlRunRepo,
  dryRun: boolean,
  result: MutableImportResult,
): Promise<{ imported: number; skipped: number; runIds: RunId[] }> {
  const runs = await fsRepo.list();
  let imported = 0;
  let skipped = 0;
  const runIds: RunId[] = [];

  for (const run of runs) {
    try {
      // Validate with domain schema
      const validated = runRecordSchema.parse(run);

      // Duplicate detection (AC-45)
      const existing = await sqlRepo.getById(validated.runId);
      if (existing !== null) {
        result.conflicts.push({ id: validated.runId, entity: "run" });
        skipped++;
        runIds.push(validated.runId);
        continue;
      }

      if (!dryRun) {
        await sqlRepo.create(validated);
      }
      imported++;
      runIds.push(validated.runId);
    } catch (error: unknown) {
      result.errors.push(
        error instanceof Error
          ? error
          : new Error(`Failed to import run ${String(run.runId)}: ${String(error)}`),
      );
    }
  }

  return { imported, skipped, runIds };
}

// ─── Checkpoint import ───────────────────────────────────────────────────────

/**
 * Imports checkpoints for each run from FS to SQL.
 *
 * - `listByRunId` returns checkpoints sorted by CreatedAt ASC, Attempt ASC
 *   (matching FileCheckpointRepository order — AC-46).
 * - Validates each with `checkpointDtoSchema`.
 * - Checkpoints are append-only; no duplicate detection needed.
 * - Does NOT modify the FS source (AC-48).
 */
async function importCheckpoints(
  runIds: RunId[],
  fsRepo: FsCheckpointRepo,
  sqlRepo: SqlCheckpointRepo,
  dryRun: boolean,
  result: MutableImportResult,
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  const skipped = 0;

  for (const runId of runIds) {
    try {
      const checkpoints = await fsRepo.listByRunId(runId);

      for (const checkpoint of checkpoints) {
        try {
          // Validate the checkpoint DTO
          const validated = checkpointDtoSchema.parse(checkpoint);

          if (!dryRun) {
            await sqlRepo.create({ ...validated, runId: validated.runId as RunId });
          }
          imported++;
        } catch (error: unknown) {
          result.errors.push(
            error instanceof Error
              ? error
              : new Error(
                  `Failed to import checkpoint for run ${String(runId)}, attempt ${String(checkpoint.attempt)}: ${String(error)}`,
                ),
          );
        }
      }
    } catch (error: unknown) {
      result.errors.push(
        error instanceof Error
          ? error
          : new Error(`Failed to list checkpoints for run ${String(runId)}: ${String(error)}`),
      );
    }
  }

  return { imported, skipped };
}

// ─── Schedule import ─────────────────────────────────────────────────────────

/**
 * Imports schedules from FS to SQL.
 *
 * - Validates each record with `scheduleRecordSchema`.
 * - Checks for duplicates via `sqlScheduleRepo.getById(scheduleId)`.
 * - Preserves IDs, idempotency keys, timestamps (AC-46).
 * - Does NOT modify the FS source (AC-48).
 */
async function importSchedules(
  fsRepo: FsScheduleRepo,
  sqlRepo: SqlScheduleRepo,
  dryRun: boolean,
  result: MutableImportResult,
): Promise<{ imported: number; skipped: number }> {
  const schedules = await fsRepo.list();
  let imported = 0;
  let skipped = 0;

  for (const schedule of schedules) {
    try {
      // Validate with domain schema
      const validated = scheduleRecordSchema.parse(schedule);

      // Duplicate detection (AC-45)
      const existing = await sqlRepo.getById(validated.scheduleId);
      if (existing !== null) {
        result.conflicts.push({ id: validated.scheduleId, entity: "schedule" });
        skipped++;
        continue;
      }

      if (!dryRun) {
        await sqlRepo.create(validated);
      }
      imported++;
    } catch (error: unknown) {
      result.errors.push(
        error instanceof Error
          ? error
          : new Error(`Failed to import schedule ${String(schedule.scheduleId)}: ${String(error)}`),
      );
    }
  }

  return { imported, skipped };
}

// ─── Audit entry import ──────────────────────────────────────────────────────

/**
 * Imports audit entries from FS to SQL.
 *
 * - Validates each entry with `auditEntrySchema`.
 * - Audit entries are append-only; no duplicate detection needed.
 * - Preserves entryId, timestamps, correlation IDs (AC-46).
 * - Does NOT modify the FS source (AC-48).
 */
async function importAuditEntries(
  fsRepo: FsAuditRepo,
  sqlRepo: SqlAuditRepo,
  dryRun: boolean,
  result: MutableImportResult,
): Promise<{ imported: number; skipped: number }> {
  const entries = await fsRepo.readAll();
  let imported = 0;
  const skipped = 0;

  for (const entry of entries) {
    try {
      // Validate with domain schema
      const validated = auditEntrySchema.parse(entry);

      // Redact sensitive metadata before persisting (F-01)
      const redacted = redactAuditEntry({
        ...validated,
        entryId: validated.entryId as AuditEntryId,
      });

      if (!dryRun) {
        await sqlRepo.append(redacted);
      }
      imported++;
    } catch (error: unknown) {
      result.errors.push(
        error instanceof Error
          ? error
          : new Error(`Failed to import audit entry ${String(entry.entryId)}: ${String(error)}`),
      );
    }
  }

  return { imported, skipped };
}
