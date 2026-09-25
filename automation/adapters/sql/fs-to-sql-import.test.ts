/**
 * Tests for fs-to-sql-import module (Sprint 5 — I-4b, AC-45, AC-46, AC-48).
 *
 * Coverage:
 * 1. Full import (runs + checkpoints + schedules + audit)
 * 2. dryRun=true (no SQL writes)
 * 3. Duplicate detection (runs and schedules)
 * 4. Validation errors (Zod schema failures)
 * 5. Checkpoint ordering (CreatedAt + Attempt)
 * 6. Source .data read-only (no FS mutations)
 * 7. Empty scenario
 */

import { describe, it, expect } from "vitest";
import type { RunId, IdempotencyKey, PayloadFingerprint } from "../../domain/idempotency.js";
import type { CheckpointDto } from "../checkpoint-repository.js";
import type { RunRecord } from "../../domain/run-record.js";
import type { ScheduleRecord } from "../../domain/schedule-schema.js";
import type { AuditEntry, AuditEntryId } from "../../domain/audit-entry.js";
import { runFsToSqlImport, type ImportOptions } from "./fs-to-sql-import.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const run1: RunRecord = {
  schemaVersion: 1,
  runId: "run-001" as RunId,
  brandId: "best-fluency",
  market: "PT",
  platform: "instagram",
  operation: "post",
  state: "succeeded",
  attempt: 1,
  maxAttempts: 3,
  idempotencyKey: "key-001" as IdempotencyKey,
  payloadFingerprint: "fp-001" as PayloadFingerprint,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:01:00Z"),
};

const run2: RunRecord = {
  ...run1,
  runId: "run-002" as RunId,
  idempotencyKey: "key-002" as IdempotencyKey,
  payloadFingerprint: "fp-002" as PayloadFingerprint,
};

const cp1: CheckpointDto = {
  runId: "run-001" as RunId,
  state: "running",
  attempt: 1,
  payload: { step: "init" },
  createdAt: "2026-01-01T00:00:10Z",
};

const cp2: CheckpointDto = {
  runId: "run-001" as RunId,
  state: "succeeded",
  attempt: 2,
  payload: { step: "done" },
  createdAt: "2026-01-01T00:00:20Z",
};

const cp3: CheckpointDto = {
  runId: "run-002" as RunId,
  state: "running",
  attempt: 1,
  payload: { step: "init" },
  createdAt: "2026-01-01T00:00:15Z",
};

const schedule1: ScheduleRecord = {
  schemaVersion: 1,
  scheduleId: "sched-001",
  idempotencyKey: "schedule:abc",
  config: {
    cron: "0 9 * * 1-5",
    timezone: "Europe/Lisbon",
    brandId: "best-fluency",
    market: "PT",
    platform: "instagram",
    operation: "post",
    enabled: true,
    mode: "single",
  },
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  enabled: true,
  revision: 0,
};

const audit1: AuditEntry = {
  entryId: "audit-001" as AuditEntryId,
  timestamp: new Date("2026-01-01T00:00:00Z"),
  category: "run",
  action: "created",
  actor: "system",
  correlationIds: { runId: "run-001" },
};

// Invalid run for validation error test (state not in enum)
const invalidRun = {
  schemaVersion: 1,
  runId: "run-invalid",
  brandId: "best-fluency",
  market: "PT",
  platform: "instagram",
  operation: "post",
  state: "INVALID_STATE",
  attempt: 1,
  maxAttempts: 3,
  idempotencyKey: "key-invalid",
  payloadFingerprint: "fp-invalid",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:01:00Z"),
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function createOptions(overrides: {
  fsRuns?: RunRecord[];
  fsCheckpoints?: Record<string, CheckpointDto[]>;
  fsSchedules?: ScheduleRecord[];
  fsAudit?: AuditEntry[];
  existingRunIds?: Set<string>;
  existingScheduleIds?: Set<string>;
  dryRun?: boolean;
  checkpointCreateError?: Error;
  scheduleCreateError?: Error;
  auditAppendError?: Error;
}): {
  options: ImportOptions;
  sqlRunCreates: RunRecord[];
  sqlCheckpointCreates: CheckpointDto[];
  sqlScheduleCreates: ScheduleRecord[];
  sqlAuditAppends: AuditEntry[];
} {
  const sqlRunCreates: RunRecord[] = [];
  const sqlCheckpointCreates: CheckpointDto[] = [];
  const sqlScheduleCreates: ScheduleRecord[] = [];
  const sqlAuditAppends: AuditEntry[] = [];

  const fsRuns = overrides.fsRuns ?? [];
  const fsCheckpoints = overrides.fsCheckpoints ?? {};
  const fsSchedules = overrides.fsSchedules ?? [];
  const fsAudit = overrides.fsAudit ?? [];
  const existingRunIds = overrides.existingRunIds ?? new Set<string>();
  const existingScheduleIds = overrides.existingScheduleIds ?? new Set<string>();

  const options: ImportOptions = {
    fsRunRepo: {
      list: async () => fsRuns,
    },
    fsCheckpointRepo: {
      listByRunId: async (runId: RunId) => fsCheckpoints[runId] ?? [],
    },
    fsScheduleRepo: {
      list: async () => fsSchedules,
    },
    fsAuditRepo: {
      readAll: async () => fsAudit,
    },
    sqlRunRepo: {
      create: async (record: RunRecord) => {
        sqlRunCreates.push(record);
        return record;
      },
      getById: async (runId: RunId) => {
        if (existingRunIds.has(runId)) {
          return run1;
        }
        return null;
      },
    },
    sqlCheckpointRepo: {
      create: async (checkpoint: CheckpointDto) => {
        if (overrides.checkpointCreateError) {
          throw overrides.checkpointCreateError;
        }
        sqlCheckpointCreates.push(checkpoint);
        return checkpoint;
      },
    },
    sqlScheduleRepo: {
      create: async (record: ScheduleRecord) => {
        if (overrides.scheduleCreateError) {
          throw overrides.scheduleCreateError;
        }
        sqlScheduleCreates.push(record);
        return record;
      },
      getById: async (scheduleId: string) => {
        if (existingScheduleIds.has(scheduleId)) {
          return schedule1;
        }
        return null;
      },
    },
    sqlAuditRepo: {
      append: async (entry: AuditEntry) => {
        if (overrides.auditAppendError) {
          throw overrides.auditAppendError;
        }
        sqlAuditAppends.push(entry);
        return entry;
      },
    },
    dryRun: overrides.dryRun,
  };

  return { options, sqlRunCreates, sqlCheckpointCreates, sqlScheduleCreates, sqlAuditAppends };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runFsToSqlImport", () => {
  // AC-45/AC-46/AC-48: Import completo
  it("imports runs, checkpoints, schedules, and audit entries", async () => {
    const { options, sqlRunCreates, sqlCheckpointCreates, sqlScheduleCreates, sqlAuditAppends } =
      createOptions({
        fsRuns: [run1, run2],
        fsCheckpoints: {
          "run-001": [cp1, cp2],
          "run-002": [cp3],
        },
        fsSchedules: [schedule1],
        fsAudit: [audit1],
      });

    const result = await runFsToSqlImport(options);

    expect(result.imported).toBe(2 + 3 + 1 + 1);
    expect(result.skipped).toBe(0);
    expect(result.conflicts).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.byEntity).toEqual({
      runs: { imported: 2, skipped: 0 },
      checkpoints: { imported: 3, skipped: 0 },
      schedules: { imported: 1, skipped: 0 },
      audit: { imported: 1, skipped: 0 },
    });

    expect(sqlRunCreates).toHaveLength(2);
    expect(sqlCheckpointCreates).toHaveLength(3);
    expect(sqlScheduleCreates).toHaveLength(1);
    expect(sqlAuditAppends).toHaveLength(1);
  });

  // AC-45: dryRun=true
  it("does not write to SQL when dryRun is true", async () => {
    const { options, sqlRunCreates, sqlCheckpointCreates, sqlScheduleCreates, sqlAuditAppends } =
      createOptions({
        fsRuns: [run1],
        fsCheckpoints: { "run-001": [cp1] },
        fsSchedules: [schedule1],
        fsAudit: [audit1],
        dryRun: true,
      });

    const result = await runFsToSqlImport(options);

    // imported counts validated records even in dryRun (no SQL writes)
    expect(result.imported).toBe(4);
    expect(sqlRunCreates).toHaveLength(0);
    expect(sqlCheckpointCreates).toHaveLength(0);
    expect(sqlScheduleCreates).toHaveLength(0);
    expect(sqlAuditAppends).toHaveLength(0);
  });

  // AC-45: Duplicata (runs)
  it("detects duplicate runs and records conflicts without altering existing", async () => {
    const { options, sqlRunCreates } = createOptions({
      fsRuns: [run1],
      existingRunIds: new Set(["run-001"]),
    });

    const result = await runFsToSqlImport(options);

    expect(result.imported).toBe(0);
    expect(result.conflicts).toEqual([{ id: "run-001", entity: "run" }]);
    expect(result.skipped).toBe(1);
    expect(result.byEntity.runs).toEqual({ imported: 0, skipped: 1 });
    expect(sqlRunCreates).toHaveLength(0);
  });

  // AC-45: Duplicata (schedules)
  it("detects duplicate schedules and records conflicts without altering existing", async () => {
    const { options, sqlScheduleCreates } = createOptions({
      fsSchedules: [schedule1],
      existingScheduleIds: new Set(["sched-001"]),
    });

    const result = await runFsToSqlImport(options);

    expect(result.imported).toBe(0);
    expect(result.conflicts).toEqual([{ id: "sched-001", entity: "schedule" }]);
    expect(result.skipped).toBe(1);
    expect(result.byEntity.schedules).toEqual({ imported: 0, skipped: 1 });
    expect(sqlScheduleCreates).toHaveLength(0);
  });

  // AC-45/AC-46: Erro de validação (Zod)
  it("records validation errors and continues import", async () => {
    const { options, sqlRunCreates } = createOptions({
      fsRuns: [invalidRun as unknown as RunRecord, run1],
    });

    const result = await runFsToSqlImport(options);

    expect(result.errors).toHaveLength(1);
    expect(result.imported).toBe(1);
    expect(result.byEntity.runs).toEqual({ imported: 1, skipped: 0 });
    expect(sqlRunCreates).toHaveLength(1);
  });

  // AC-46: Checkpoints ordenados (CreatedAt + Attempt)
  it("imports checkpoints preserving listByRunId order", async () => {
    const cpSameTime: CheckpointDto = {
      runId: "run-001" as RunId,
      state: "running",
      attempt: 2,
      payload: { step: "retry" },
      createdAt: "2026-01-01T00:00:10Z",
    };

    const ordered = [cp1, cpSameTime, cp2];
    const { options, sqlCheckpointCreates } = createOptions({
      fsRuns: [run1],
      fsCheckpoints: { "run-001": ordered },
    });

    await runFsToSqlImport(options);

    expect(sqlCheckpointCreates).toEqual([cp1, cpSameTime, cp2]);
  });

  // AC-48: Fonte .data read-only
  it("only reads from FS repos, never writes", async () => {
    const { options, sqlRunCreates, sqlCheckpointCreates, sqlScheduleCreates, sqlAuditAppends } =
      createOptions({
        fsRuns: [run1],
        fsCheckpoints: { "run-001": [cp1] },
        fsSchedules: [schedule1],
        fsAudit: [audit1],
      });

    expect(typeof options.fsRunRepo.list).toBe("function");
    expect(typeof options.fsCheckpointRepo.listByRunId).toBe("function");
    expect(typeof options.fsScheduleRepo.list).toBe("function");
    expect(typeof options.fsAuditRepo.readAll).toBe("function");

    expect((options.fsRunRepo as unknown as Record<string, unknown>).delete).toBeUndefined();
    expect((options.fsRunRepo as unknown as Record<string, unknown>).write).toBeUndefined();
    expect((options.fsRunRepo as unknown as Record<string, unknown>).update).toBeUndefined();

    await runFsToSqlImport(options);

    expect(sqlRunCreates).toHaveLength(1);
    expect(sqlCheckpointCreates).toHaveLength(1);
    expect(sqlScheduleCreates).toHaveLength(1);
    expect(sqlAuditAppends).toHaveLength(1);
  });

  // AC-45/AC-46/AC-48: Cenário vazio
  it("returns empty result when no data exists", async () => {
    const { options } = createOptions({});

    const result = await runFsToSqlImport(options);

    expect(result).toEqual({
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
    });
  });

  // REV-61: Importação parcial — schedules falha após runs+checkpoints sucesso
  it("reports partial import via byEntity when schedules fail after runs+checkpoints succeed", async () => {
    const scheduleError = new Error("SQL connection lost");
    const { options, sqlRunCreates, sqlCheckpointCreates, sqlScheduleCreates, sqlAuditAppends } =
      createOptions({
        fsRuns: [run1],
        fsCheckpoints: { "run-001": [cp1, cp2] },
        fsSchedules: [schedule1],
        fsAudit: [audit1],
        scheduleCreateError: scheduleError,
      });

    const result = await runFsToSqlImport(options);

    // runs and checkpoints succeeded, schedules failed, audit succeeded
    expect(result.byEntity.runs).toEqual({ imported: 1, skipped: 0 });
    expect(result.byEntity.checkpoints).toEqual({ imported: 2, skipped: 0 });
    expect(result.byEntity.schedules).toEqual({ imported: 0, skipped: 0 });
    expect(result.byEntity.audit).toEqual({ imported: 1, skipped: 0 });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe("SQL connection lost");

    expect(sqlRunCreates).toHaveLength(1);
    expect(sqlCheckpointCreates).toHaveLength(2);
    expect(sqlScheduleCreates).toHaveLength(0);
    expect(sqlAuditAppends).toHaveLength(1);
  });

  // REV-63: Error path — sqlCheckpointRepo.create lança erro
  it("records checkpoint creation errors and continues import", async () => {
    const cpError = new Error("checkpoint write failed");
    const { options, sqlRunCreates, sqlCheckpointCreates, sqlScheduleCreates, sqlAuditAppends } =
      createOptions({
        fsRuns: [run1],
        fsCheckpoints: { "run-001": [cp1, cp2] },
        fsSchedules: [schedule1],
        fsAudit: [audit1],
        checkpointCreateError: cpError,
      });

    const result = await runFsToSqlImport(options);

    expect(result.byEntity.runs).toEqual({ imported: 1, skipped: 0 });
    expect(result.byEntity.checkpoints).toEqual({ imported: 0, skipped: 0 });
    expect(result.byEntity.schedules).toEqual({ imported: 1, skipped: 0 });
    expect(result.byEntity.audit).toEqual({ imported: 1, skipped: 0 });

    // 2 checkpoint errors (one per checkpoint)
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].message).toBe("checkpoint write failed");
    expect(result.errors[1].message).toBe("checkpoint write failed");

    expect(sqlRunCreates).toHaveLength(1);
    expect(sqlCheckpointCreates).toHaveLength(0);
    expect(sqlScheduleCreates).toHaveLength(1);
    expect(sqlAuditAppends).toHaveLength(1);
  });

  // REV-63: Error path — sqlScheduleRepo.create lança erro
  it("records schedule creation errors and continues import", async () => {
    const schedError = new Error("schedule write failed");
    const { options, sqlRunCreates, sqlCheckpointCreates, sqlScheduleCreates, sqlAuditAppends } =
      createOptions({
        fsRuns: [run1],
        fsCheckpoints: { "run-001": [cp1] },
        fsSchedules: [schedule1],
        fsAudit: [audit1],
        scheduleCreateError: schedError,
      });

    const result = await runFsToSqlImport(options);

    expect(result.byEntity.runs).toEqual({ imported: 1, skipped: 0 });
    expect(result.byEntity.checkpoints).toEqual({ imported: 1, skipped: 0 });
    expect(result.byEntity.schedules).toEqual({ imported: 0, skipped: 0 });
    expect(result.byEntity.audit).toEqual({ imported: 1, skipped: 0 });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe("schedule write failed");

    expect(sqlRunCreates).toHaveLength(1);
    expect(sqlCheckpointCreates).toHaveLength(1);
    expect(sqlScheduleCreates).toHaveLength(0);
    expect(sqlAuditAppends).toHaveLength(1);
  });

  // REV-63: Error path — sqlAuditRepo.append lança erro
  it("records audit append errors and continues import", async () => {
    const auditError = new Error("audit write failed");
    const { options, sqlRunCreates, sqlCheckpointCreates, sqlScheduleCreates, sqlAuditAppends } =
      createOptions({
        fsRuns: [run1],
        fsCheckpoints: { "run-001": [cp1] },
        fsSchedules: [schedule1],
        fsAudit: [audit1],
        auditAppendError: auditError,
      });

    const result = await runFsToSqlImport(options);

    expect(result.byEntity.runs).toEqual({ imported: 1, skipped: 0 });
    expect(result.byEntity.checkpoints).toEqual({ imported: 1, skipped: 0 });
    expect(result.byEntity.schedules).toEqual({ imported: 1, skipped: 0 });
    expect(result.byEntity.audit).toEqual({ imported: 0, skipped: 0 });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe("audit write failed");

    expect(sqlRunCreates).toHaveLength(1);
    expect(sqlCheckpointCreates).toHaveLength(1);
    expect(sqlScheduleCreates).toHaveLength(1);
    expect(sqlAuditAppends).toHaveLength(0);
  });
});
