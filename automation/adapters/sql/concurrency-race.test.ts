import { describe, expect, it } from "vitest";

import type { IdempotencyKey, RunId } from "../../domain/idempotency.js";
import type { RunRecord } from "../../domain/run-record.js";
import type { ScheduleId, ScheduleRecord } from "../../domain/schedule-schema.js";
import { ConcurrencyConflictError } from "../persistence-errors.js";
import { createFakeSqlExecutor } from "./fake-sql-executor.js";
import { SqlRunRepository } from "./sql-run-repo.js";
import {
  INSERT_SCHEDULE_SQL,
  SELECT_SCHEDULE_BY_ID_SQL,
  SELECT_SCHEDULE_REVISION_SQL,
  SqlScheduleRepository,
  UPDATE_SCHEDULE_GUARDED_SQL,
} from "./sql-schedule-repo.js";
import type { SqlExecutor } from "./sql-pool.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

let nextRunSequence = 0;

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  nextRunSequence += 1;
  return {
    schemaVersion: 1,
    runId: `race-run-${nextRunSequence}` as RunId,
    brandId: "best-fluency",
    market: "PT",
    platform: "google_business_profile",
    operation: "sync_listings",
    state: "queued",
    attempt: 0,
    maxAttempts: 3,
    idempotencyKey: `race-idem-${nextRunSequence}` as IdempotencyKey,
    payloadFingerprint: "d".repeat(64) as RunRecord["payloadFingerprint"],
    createdAt: new Date("2026-06-01T12:00:00.000Z"),
    updatedAt: new Date("2026-06-01T12:00:00.000Z"),
    ...overrides,
  };
}

function newRepo() {
  const executor = createFakeSqlExecutor();
  return { executor, repo: new SqlRunRepository(executor) };
}

function reasonOf(result: PromiseSettledResult<unknown>): unknown {
  if (result.status !== "rejected") {
    throw new Error("expected a rejected promise");
  }
  return result.reason;
}

function valueOf(result: PromiseSettledResult<RunRecord>): RunRecord {
  if (result.status !== "fulfilled") {
    throw new Error(`expected a fulfilled promise, received: ${String(result.reason)}`);
  }
  return result.value;
}

// ─── Deterministic races (AC-51) ─────────────────────────────────────────────

describe("SqlRunRepository — concurrent create races (AC-22, AC-51)", () => {
  it("lets exactly one create win a same-runId race with the parity message", async () => {
    const { executor, repo } = newRepo();
    const record = makeRun();

    const results = await Promise.allSettled([repo.create(record), repo.create({ ...record })]);

    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    const error = reasonOf(results[1]) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(`Record already exists: ${record.runId}`);
    expect(executor.runs.size).toBe(1);
  });

  it("resolves an idempotent-create race to the single durable winner", async () => {
    const { executor, repo } = newRepo();
    const first = makeRun();
    const second = makeRun({ idempotencyKey: first.idempotencyKey });
    const third = makeRun({ idempotencyKey: first.idempotencyKey });

    const results = await Promise.allSettled([
      repo.create(first),
      repo.create(second),
      repo.create(third),
    ]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(valueOf(results[0]).runId).toBe(first.runId);
    expect(valueOf(results[1]).runId).toBe(first.runId);
    expect(valueOf(results[2]).runId).toBe(first.runId);
    expect(executor.runs.size).toBe(1);
  });

  it("keeps the idempotency key unique across sequential logical retries", async () => {
    const { executor, repo } = newRepo();
    const first = makeRun();
    const retry = makeRun({ idempotencyKey: first.idempotencyKey });

    await repo.create(first);
    const winner = await repo.create(retry);

    expect(winner.runId).toBe(first.runId);
    expect(executor.runs.get(first.runId)?.IdempotencyKey).toBe(first.idempotencyKey);
    expect(executor.runs.size).toBe(1);
  });
});

describe("SqlRunRepository — concurrent update races (AC-21, AC-51)", () => {
  it("applies only the first guarded update and conflicts the second", async () => {
    const { executor, repo } = newRepo();
    const record = await repo.create(makeRun());
    const toRunning: RunRecord = { ...record, state: "running" };
    const toFailed: RunRecord = { ...record, state: "failed" };

    const results = await Promise.allSettled([repo.update(toRunning, 1), repo.update(toFailed, 1)]);

    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    const conflict = reasonOf(results[1]) as ConcurrencyConflictError;
    expect(conflict).toBeInstanceOf(ConcurrencyConflictError);
    expect(conflict.recordId).toBe(record.runId);
    expect(conflict.expectedRevision).toBe(1);
    expect(conflict.actualRevision).toBe(2);

    // The winner's state survives and the revision advanced exactly once.
    expect(executor.runs.get(record.runId)?.Revision).toBe(2);
    await expect(repo.getById(record.runId)).resolves.toEqual(toRunning);
  });

  it("conflicts a stale revision after a successful serial update", async () => {
    const { repo } = newRepo();
    const record = await repo.create(makeRun());
    const toRunning: RunRecord = { ...record, state: "running" };
    const toFailed: RunRecord = { ...record, state: "failed" };

    await repo.update(toRunning, 1);

    let caught: unknown;
    try {
      await repo.update(toFailed, 1);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConcurrencyConflictError);
    expect((caught as ConcurrencyConflictError).actualRevision).toBe(2);
    await expect(repo.getById(record.runId)).resolves.toEqual(toRunning);
  });

  it("retries cleanly with the refreshed revision after a conflict", async () => {
    const { executor, repo } = newRepo();
    const record = await repo.create(makeRun());
    const toRunning: RunRecord = { ...record, state: "running" };
    const toFailed: RunRecord = { ...record, state: "failed" };

    // First update wins (revision 1 → 2); the stale attempt must conflict.
    await repo.update(toRunning, 1);
    await expect(repo.update(toFailed, 1)).rejects.toBeInstanceOf(ConcurrencyConflictError);

    // Retrying with the refreshed revision succeeds (2 → 3).
    await repo.update(toFailed, 2);

    expect(executor.runs.get(record.runId)?.Revision).toBe(3);
    await expect(repo.getById(record.runId)).resolves.toEqual(toFailed);
    await expect(repo.update(toRunning, 2)).rejects.toBeInstanceOf(ConcurrencyConflictError);
  });
});

// ─── Schedule update races (AC-51, spec §17 — REV-31) ────────────────────────

let nextScheduleSequence = 0;

/** In-variant schedule fixture (`enabled === config.enabled`, D-12). */
function makeSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  nextScheduleSequence += 1;
  const merged: ScheduleRecord = {
    schemaVersion: 1,
    scheduleId: `race-sched-${nextScheduleSequence}` as ScheduleId,
    idempotencyKey: `race-schedule:${nextScheduleSequence}`,
    config: {
      cron: "0 3 * * *",
      timezone: "Europe/Lisbon",
      brandId: "best-fluency",
      market: "PT",
      platform: "google_business_profile",
      operation: "sync_listings",
      enabled: true,
      mode: "single",
    },
    createdAt: new Date("2026-06-01T12:00:00.000Z"),
    updatedAt: new Date("2026-06-01T12:00:00.000Z"),
    enabled: true,
    revision: 0,
    ...overrides,
  };
  if (overrides.enabled !== undefined) {
    merged.config = { ...merged.config, enabled: overrides.enabled };
  } else if (overrides.config !== undefined) {
    merged.enabled = merged.config.enabled;
  }
  return merged;
}

const SCHEDULE_COLUMNS = [
  "ScheduleId",
  "SchemaVersion",
  "IdempotencyKey",
  "Cron",
  "Timezone",
  "BrandId",
  "Market",
  "Platform",
  "Operation",
  "Mode",
  "Enabled",
  "CreatedAt",
  "UpdatedAt",
  "LastRunAt",
  "NextRunAt",
  "Revision",
  "MetadataJson",
] as const;

const PK_SCHEDULES_MESSAGE =
  "Violation of PRIMARY KEY constraint 'PK_Schedules'. Cannot insert duplicate key in object 'dbo.Schedules'.";

/** Schedule race executor: `schedules` is exposed for row-level assertions. */
interface ScheduleRaceExecutor extends SqlExecutor {
  readonly schedules: Map<string, Record<string, unknown>>;
}

/**
 * Minimal schedule dispatch for the race below: the shared fake executor
 * only models dbo.Runs/dbo.Checkpoints, so the four dbo.Schedules statements
 * exercised here (insert, select by id, guarded update, revision probe) are
 * served by an in-memory Map with the same statement-identity semantics the
 * adapter relies on. Anything else falls through to the shared fake.
 */
function createScheduleRaceExecutor(): ScheduleRaceExecutor {
  const base = createFakeSqlExecutor();
  const schedules = new Map<string, Record<string, unknown>>();

  const projectRow = (row: Record<string, unknown>): unknown[] =>
    SCHEDULE_COLUMNS.map((column) => row[column]);

  return {
    schedules,

    async query(text, params) {
      const bound = params ?? {};

      if (text === INSERT_SCHEDULE_SQL) {
        const scheduleId = bound["scheduleId"] as string;
        if (schedules.has(scheduleId)) {
          throw new Error(PK_SCHEDULES_MESSAGE);
        }
        schedules.set(scheduleId, {
          ScheduleId: scheduleId,
          SchemaVersion: bound["schemaVersion"],
          IdempotencyKey: bound["idempotencyKey"],
          Cron: bound["cron"],
          Timezone: bound["timezone"],
          BrandId: bound["brandId"],
          Market: bound["market"],
          Platform: bound["platform"],
          Operation: bound["operation"],
          Mode: bound["mode"],
          Enabled: bound["enabled"],
          CreatedAt: bound["createdAt"],
          UpdatedAt: bound["updatedAt"],
          LastRunAt: bound["lastRunAt"],
          NextRunAt: bound["nextRunAt"],
          Revision: bound["revision"],
          MetadataJson: bound["metadataJson"],
        });
        return { columns: [], rows: [] };
      }

      if (text === SELECT_SCHEDULE_BY_ID_SQL) {
        const row = schedules.get(bound["scheduleId"] as string);
        return row === undefined
          ? { columns: SCHEDULE_COLUMNS, rows: [] }
          : { columns: SCHEDULE_COLUMNS, rows: [projectRow(row)] };
      }

      if (text === UPDATE_SCHEDULE_GUARDED_SQL) {
        const scheduleId = bound["scheduleId"] as string;
        const row = schedules.get(scheduleId);
        if (row === undefined || row["Revision"] !== bound["expectedRevision"]) {
          return { columns: [], rows: [] };
        }
        const nextRevision = (row["Revision"] as number) + 1;
        schedules.set(scheduleId, {
          ...row,
          SchemaVersion: bound["schemaVersion"],
          IdempotencyKey: bound["idempotencyKey"],
          Cron: bound["cron"],
          Timezone: bound["timezone"],
          BrandId: bound["brandId"],
          Market: bound["market"],
          Platform: bound["platform"],
          Operation: bound["operation"],
          Mode: bound["mode"],
          Enabled: bound["enabled"],
          CreatedAt: bound["createdAt"],
          UpdatedAt: bound["updatedAt"],
          LastRunAt: bound["lastRunAt"],
          NextRunAt: bound["nextRunAt"],
          MetadataJson: bound["metadataJson"],
          Revision: nextRevision,
        });
        return { columns: ["Revision"], rows: [[nextRevision]] };
      }

      if (text === SELECT_SCHEDULE_REVISION_SQL) {
        const row = schedules.get(bound["scheduleId"] as string);
        return row === undefined
          ? { columns: ["Revision"], rows: [] }
          : { columns: ["Revision"], rows: [[row["Revision"]]] };
      }

      return base.query(text, params);
    },

    transaction: (statements) => base.transaction(statements),
    close: () => base.close(),
  };
}

describe("SqlScheduleRepository — concurrent schedule update races (AC-51, spec §17)", () => {
  it("lets exactly one of two updates from the same revision win, in either call order", async () => {
    for (const first of ["cron", "disable"] as const) {
      const executor = createScheduleRaceExecutor();
      const repo = new SqlScheduleRepository(executor);
      const created = await repo.create(makeSchedule());

      const toCron: ScheduleRecord = {
        ...created,
        config: { ...created.config, cron: "0 4 * * *" },
        updatedAt: new Date("2026-06-01T12:05:00.000Z"),
      };
      const toDisable: ScheduleRecord = {
        ...created,
        enabled: false,
        config: { ...created.config, enabled: false },
        updatedAt: new Date("2026-06-01T12:06:00.000Z"),
      };
      const attempts = first === "cron" ? [toCron, toDisable] : [toDisable, toCron];

      const results = await Promise.allSettled(attempts.map((record) => repo.update(record)));

      // Exactly one winner: the first call lands its guarded UPDATE, the
      // second matches zero rows and falls through to the revision probe.
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);

      const conflict = reasonOf(results[1]) as ConcurrencyConflictError;
      expect(conflict).toBeInstanceOf(ConcurrencyConflictError);
      expect(conflict.recordId).toBe(created.scheduleId);
      expect(conflict.expectedRevision).toBe(0);
      expect(conflict.actualRevision).toBe(1);

      // The revision advanced exactly once and the winner's state survives.
      expect(executor.schedules.get(created.scheduleId)?.["Revision"]).toBe(1);
      await expect(repo.getById(created.scheduleId as ScheduleId)).resolves.toEqual({
        ...attempts[0],
        revision: 1,
      });
    }
  });

  it("conflicts a stale schedule update after the winner and succeeds on retry", async () => {
    const executor = createScheduleRaceExecutor();
    const repo = new SqlScheduleRepository(executor);
    const created = await repo.create(makeSchedule());
    const winner: ScheduleRecord = {
      ...created,
      config: { ...created.config, cron: "0 5 * * *" },
    };
    const loser: ScheduleRecord = {
      ...created,
      enabled: false,
      config: { ...created.config, enabled: false },
    };

    const first = await repo.update(winner);
    expect(first.revision).toBe(1);

    let caught: unknown;
    try {
      await repo.update(loser);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConcurrencyConflictError);
    const conflict = caught as ConcurrencyConflictError;
    expect(conflict.recordId).toBe(created.scheduleId);
    expect(conflict.expectedRevision).toBe(0);
    expect(conflict.actualRevision).toBe(1);

    // A retry with the refreshed revision succeeds (1 → 2).
    const retried = await repo.update({ ...loser, revision: 1 });
    expect(retried.revision).toBe(2);
    expect(executor.schedules.get(created.scheduleId)?.["Revision"]).toBe(2);
    await expect(repo.getById(created.scheduleId as ScheduleId)).resolves.toEqual(retried);
  });
});
