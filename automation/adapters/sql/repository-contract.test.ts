import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IdempotencyKey, RunId } from "../../domain/idempotency.js";
import type { RunRecord } from "../../domain/run-record.js";
import type { RunRepository } from "../../domain/repository.js";
import type { ScheduleId, ScheduleRecord } from "../../domain/schedule-schema.js";
import type { ScheduleConfig } from "../../domain/schedule-schema.js";
import type { ScheduleRepository } from "../../domain/schedule-repository.js";
import type { CheckpointDto, CheckpointRepository } from "../checkpoint-repository.js";
import { FileCheckpointRepository } from "../file-checkpoint-repo.js";
import { FileRunRepository } from "../file-run-repo.js";
import { FileScheduleRepository } from "../file-schedule-repo.js";
import { ConcurrencyConflictError } from "../persistence-errors.js";
import { createFakeSqlExecutor, type FakeSqlExecutor } from "./fake-sql-executor.js";
import { INSERT_CHECKPOINT_SQL, SqlCheckpointRepository } from "./sql-checkpoint-repo.js";
import { INSERT_RUN_SQL, SqlRunRepository } from "./sql-run-repo.js";
import {
  INSERT_SCHEDULE_SQL,
  SELECT_SCHEDULE_BY_IDEMPOTENCY_SQL,
  SELECT_SCHEDULE_BY_ID_SQL,
  SELECT_SCHEDULES_SQL,
  SELECT_SCHEDULE_REVISION_SQL,
  SqlScheduleRepository,
  UPDATE_SCHEDULE_GUARDED_SQL,
} from "./sql-schedule-repo.js";
import { SqlExecutorError } from "./sql-pool.js";
import type { SqlExecutor } from "./sql-pool.js";

// ─── Deliberate FS×SQL divergences (REV-13 → decision D-12) ─────────────────
//
// This battery runs against BOTH backends and asserts only what BOTH
// guarantee. Three divergences are deliberate and must not be unified:
//
// 1. IdempotencyKey uniqueness — SQL Server enforces
//    `UQ_Runs_IdempotencyKey`: a create whose key already exists returns
//    the durable winner and never stores a second row. The filesystem
//    backend keys records by runId only, so the same idempotency key with a
//    distinct runId is persisted as a second record, and
//    `findByIdempotencyKey` returns a non-deterministic match.
// 2. Checkpoint foreign key — SQL rejects an orphan checkpoint through
//    `FK_Checkpoints_Runs`; the filesystem backend has no cross-entity
//    constraint and accepts it.
// 3. Ordering — SQL guarantees `list()` ordering (`ORDER BY RunId ASC`);
//    the filesystem backend reads with `readdirSync` without ordering, so
//    its order is unspecified (FS `listByRunId` for checkpoints DOES sort by
//    createdAt/attempt, so AC-25 ordering holds for both backends).
//
// Consequently the shared battery asserts membership + length for `list()`
// and asserts runId order only for the SQL backend (REV-12); the per-backend
// expectations above are covered by the dedicated describes at the bottom of
// this file, outside the shared battery.

// ─── Shared contract shapes ─────────────────────────────────────────────────

/** RunRepository plus the revision-aware update both adapters implement. */
type ContractRunRepository = RunRepository & {
  update(record: RunRecord, expectedRevision?: number): Promise<RunRecord>;
};

interface ContractRepos {
  readonly runs: ContractRunRepository;
  readonly checkpoints: CheckpointRepository;
  dispose(): Promise<void>;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let nextRunSequence = 0;

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  nextRunSequence += 1;
  return {
    schemaVersion: 1,
    runId: `contract-run-${nextRunSequence}` as RunId,
    brandId: "best-fluency",
    market: "PT",
    platform: "google_business_profile",
    operation: "sync_listings",
    state: "queued",
    attempt: 0,
    maxAttempts: 3,
    idempotencyKey: `contract-idem-${nextRunSequence}` as IdempotencyKey,
    payloadFingerprint: "b".repeat(64) as RunRecord["payloadFingerprint"],
    createdAt: new Date("2026-05-01T08:00:00.000Z"),
    updatedAt: new Date("2026-05-01T08:00:00.000Z"),
    ...overrides,
  };
}

function makeCheckpoint(runId: RunId, overrides: Partial<CheckpointDto> = {}): CheckpointDto {
  return {
    runId,
    state: "running",
    attempt: 0,
    payload: { step: "fetch" },
    createdAt: "2026-05-01T08:00:00.000Z",
    ...overrides,
  };
}

// ─── Backend factories ───────────────────────────────────────────────────────

async function createFsRepos(): Promise<ContractRepos> {
  const root = mkdtempSync(join(tmpdir(), "sprint5-contract-fs-"));
  return {
    runs: new FileRunRepository(join(root, "runs")) as unknown as ContractRunRepository,
    checkpoints: new FileCheckpointRepository(join(root, "checkpoints")),
    async dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function createSqlRepos(): Promise<ContractRepos> {
  const executor = createFakeSqlExecutor();
  return {
    runs: new SqlRunRepository(executor) as unknown as ContractRunRepository,
    checkpoints: new SqlCheckpointRepository(executor),
    dispose: () => executor.close(),
  };
}

const backends: readonly {
  readonly name: string;
  readonly create: () => Promise<ContractRepos>;
  /**
   * Whether `list()` order is guaranteed by the backend. SQL has
   * `ORDER BY RunId ASC`; the FS backend uses `readdirSync` without
   * ordering (ext4 enumerates by creation order), so the shared battery
   * asserts order only where it is part of the contract (REV-12).
   */
  readonly listOrderedByRunId: boolean;
}[] = [
  { name: "filesystem", create: createFsRepos, listOrderedByRunId: false },
  { name: "sqlserver (fake executor)", create: createSqlRepos, listOrderedByRunId: true },
];

// ─── ScheduleRepository contract (AC-27..AC-29 → REV-29) ────────────────────
//
// The same golden cases run against BOTH ScheduleRepository backends and
// assert only what BOTH guarantee (pattern of the Run battery above):
//
// 1. Ordering — SQL guarantees `list()` order (`ORDER BY ScheduleId ASC`);
//    FileScheduleRepository enumerates with `readdirSync` without sorting,
//    so only membership + length are portable there (REV-12 / D-12
//    divergence 3). Order is asserted only behind `listOrderedByScheduleId`.
// 2. Enabled storage — the FS backend persists `enabled` and
//    `config.enabled` as two independent JSON fields and round-trips a
//    divergent pair untouched; the SQL backend has ONE frozen `Enabled` BIT
//    column (DDL 001) and therefore fails fast on a divergent pair instead
//    of collapsing it (D-12 / REV-30). The shared battery feeds only
//    in-variant records — exactly what `createScheduleRecord` produces —
//    and the per-backend expectations live in the dedicated describes at
//    the bottom of the schedule section.

/** Stored `dbo.Schedules` row shape (fake dispatch for the contract run). */
type StoredScheduleRow = Record<string, unknown>;

/** Column order of every SELECT exported by sql-schedule-repo.ts. */
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

function byScheduleIdAscending(a: StoredScheduleRow, b: StoredScheduleRow): number {
  const left = String(a["ScheduleId"]);
  const right = String(b["ScheduleId"]);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Minimal in-memory dispatcher for the `dbo.Schedules` statements issued by
 * `SqlScheduleRepository`, layered over the shared fake executor (which only
 * models `dbo.Runs`/`dbo.Checkpoints`). Statement-identity dispatch with the
 * exact SQL Server semantics the adapter relies on — guarded UPDATE with
 * `Revision + 1`, `TOP (1) ... ORDER BY ScheduleId ASC`, sentinel-free
 * string filters and the BIT `enabled` filter. No live SQL Server (AC-49).
 */
function createScheduleContractExecutor(): SqlExecutor {
  const base = createFakeSqlExecutor();
  const schedules = new Map<string, StoredScheduleRow>();

  const projectRow = (row: StoredScheduleRow): unknown[] =>
    SCHEDULE_COLUMNS.map((column) => row[column]);

  return {
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

      if (text === SELECT_SCHEDULE_BY_IDEMPOTENCY_SQL) {
        const key = bound["idempotencyKey"];
        const match = [...schedules.values()]
          .filter((row) => row["IdempotencyKey"] === key)
          .sort(byScheduleIdAscending)[0];
        return match === undefined
          ? { columns: SCHEDULE_COLUMNS, rows: [] }
          : { columns: SCHEDULE_COLUMNS, rows: [projectRow(match)] };
      }

      if (text === SELECT_SCHEDULES_SQL) {
        const brandId = bound["brandId"] as string;
        const market = bound["market"] as string;
        const platform = bound["platform"] as string;
        const enabledFilter = bound["enabledFilter"] as string;
        const enabled = bound["enabled"] as boolean;
        const rows = [...schedules.values()]
          .filter(
            (row) =>
              (brandId === "" || row["BrandId"] === brandId) &&
              (market === "" || row["Market"] === market) &&
              (platform === "" || row["Platform"] === platform) &&
              (enabledFilter === "" || row["Enabled"] === enabled),
          )
          .sort(byScheduleIdAscending);
        return { columns: SCHEDULE_COLUMNS, rows: rows.map(projectRow) };
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

let nextContractScheduleSequence = 0;

function makeContractConfig(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    cron: "0 3 * * *",
    timezone: "Europe/Lisbon",
    brandId: "best-fluency",
    market: "PT",
    platform: "google_business_profile",
    operation: "sync_listings",
    enabled: true,
    mode: "single",
    ...overrides,
  };
}

/**
 * Builds an in-variant `ScheduleRecord` (`enabled === config.enabled`, as
 * `createScheduleRecord` produces). Divergent fixtures are assembled
 * explicitly in the dedicated divergence describes below.
 */
function makeContractSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  nextContractScheduleSequence += 1;
  const merged: ScheduleRecord = {
    schemaVersion: 1,
    scheduleId: `contract-sched-${nextContractScheduleSequence}` as ScheduleId,
    idempotencyKey: `contract-schedule:${nextContractScheduleSequence}`,
    config: makeContractConfig(),
    createdAt: new Date("2026-05-01T09:00:00.000Z"),
    updatedAt: new Date("2026-05-01T09:00:00.000Z"),
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

interface ContractScheduleRepos {
  readonly schedules: ScheduleRepository;
  dispose(): Promise<void>;
}

async function createFsScheduleRepos(): Promise<ContractScheduleRepos> {
  const root = mkdtempSync(join(tmpdir(), "sprint5-contract-schedule-fs-"));
  return {
    schedules: new FileScheduleRepository(join(root, "schedules")),
    async dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function createSqlScheduleRepos(): Promise<ContractScheduleRepos> {
  const executor = createScheduleContractExecutor();
  return {
    schedules: new SqlScheduleRepository(executor),
    dispose: () => executor.close(),
  };
}

const scheduleBackends: readonly {
  readonly name: string;
  readonly create: () => Promise<ContractScheduleRepos>;
  /**
   * SQL pins `ORDER BY ScheduleId ASC`; the FS backend reads with
   * `readdirSync` without ordering, so the shared battery asserts order
   * only where the backend guarantees it (REV-12 / D-12).
   */
  readonly listOrderedByScheduleId: boolean;
}[] = [
  { name: "filesystem", create: createFsScheduleRepos, listOrderedByScheduleId: false },
  {
    name: "sqlserver (fake executor)",
    create: createSqlScheduleRepos,
    listOrderedByScheduleId: true,
  },
];

// ─── Shared battery (AC-49) ──────────────────────────────────────────────────

for (const backend of backends) {
  describe(`repository contract — ${backend.name}`, () => {
    let repos: ContractRepos;

    beforeEach(async () => {
      repos = await backend.create();
    });

    afterEach(async () => {
      await repos.dispose();
    });

    // ── RunRepository ───────────────────────────────────────────────────────

    it("round-trips a complete record through create and getById", async () => {
      const record = makeRun({
        state: "succeeded",
        attempt: 1,
        startedAt: new Date("2026-05-01T08:00:01.000Z"),
        finishedAt: new Date("2026-05-01T08:00:02.000Z"),
        error: { message: "transient failure", code: "ETIMEDOUT", retryable: true },
        metadata: { attemptNote: "ok" },
      });

      await repos.runs.create(record);
      const fetched = await repos.runs.getById(record.runId);

      expect(fetched).toEqual(record);
    });

    it("rejects a duplicate runId with the shared parity message", async () => {
      const record = makeRun();
      await repos.runs.create(record);

      await expect(repos.runs.create({ ...record })).rejects.toThrow(
        `Record already exists: ${record.runId}`,
      );
    });

    it("persists an unconditional update and reflects it in getById", async () => {
      const record = await repos.runs.create(makeRun());
      const next: RunRecord = {
        ...record,
        state: "running",
        attempt: 1,
        updatedAt: new Date("2026-05-01T08:05:00.000Z"),
      };

      const result = await repos.runs.update(next);

      expect(result).toEqual(next);
      await expect(repos.runs.getById(record.runId)).resolves.toEqual(next);
    });

    it("throws the shared not-found message when updating a missing record", async () => {
      const missing = makeRun();
      await expect(repos.runs.update(missing)).rejects.toThrow(
        `Record not found: ${missing.runId}`,
      );
    });

    it("accepts a guarded update when the stored revision matches (AC-21)", async () => {
      const record = await repos.runs.create(makeRun());
      const next: RunRecord = { ...record, state: "running" };

      await expect(repos.runs.update(next, 1)).resolves.toEqual(next);
      await expect(repos.runs.getById(record.runId)).resolves.toEqual(next);
    });

    it("throws ConcurrencyConflictError with expected and actual revisions (AC-21)", async () => {
      const record = await repos.runs.create(makeRun());
      const next: RunRecord = { ...record, state: "running" };

      let caught: unknown;
      try {
        await repos.runs.update(next, 99);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const conflict = caught as {
        name: string;
        recordId: string;
        expectedRevision: number;
        actualRevision: number;
      };
      expect(conflict.name).toBe("ConcurrencyConflictError");
      expect(conflict.recordId).toBe(record.runId);
      expect(conflict.expectedRevision).toBe(99);
      expect(conflict.actualRevision).toBe(1);
      await expect(repos.runs.getById(record.runId)).resolves.toEqual(record);
    });

    it("returns [] from list on an empty store", async () => {
      await expect(repos.runs.list()).resolves.toEqual([]);
    });

    it("returns every record (ordered by runId on SQL) and supports each filter", async () => {
      const alpha = makeRun({ runId: "list-a" as RunId });
      const beta = makeRun({ runId: "list-b" as RunId, market: "ES" });
      const gamma = makeRun({
        runId: "list-c" as RunId,
        state: "succeeded",
        brandId: "other-brand",
        platform: "gbp_other",
        operation: "refresh_place",
      });
      for (const record of [beta, alpha, gamma]) {
        await repos.runs.create(record);
      }

      const all = await repos.runs.list();
      const runIds = all.map((record) => record.runId);

      // Membership + length hold for both backends: the sorted comparison is
      // the portable expectation because FS `readdirSync` order is not
      // guaranteed (REV-12).
      expect([...runIds].sort()).toEqual(["list-a", "list-b", "list-c"]);
      // Deterministic `ORDER BY RunId ASC` is a SQL-only contract guarantee.
      if (backend.listOrderedByRunId) {
        expect(runIds).toEqual(["list-a", "list-b", "list-c"]);
      }

      // Every filter below returns at most one record, so the assertions are
      // order-independent for the FS backend as well.
      expect(await repos.runs.list({ market: "ES" })).toEqual([beta]);
      expect(await repos.runs.list({ state: "succeeded" })).toEqual([gamma]);
      expect(await repos.runs.list({ brandId: "other-brand" })).toEqual([gamma]);
      expect(await repos.runs.list({ platform: "gbp_other" })).toEqual([gamma]);
      expect(await repos.runs.list({ operation: "refresh_place" })).toEqual([gamma]);
      expect(await repos.runs.list({ market: "PT", state: "queued" })).toEqual([alpha]);
      expect(await repos.runs.list({ market: "FR" })).toEqual([]);
    });

    it("treats an empty-string filter as no match in both backends", async () => {
      await repos.runs.create(makeRun());
      expect(await repos.runs.list({ brandId: "" })).toEqual([]);
      expect(await repos.runs.list({ market: "", operation: "" })).toEqual([]);
    });

    it("finds records by idempotency key and returns null for unknown keys", async () => {
      const record = makeRun();
      await repos.runs.create(record);

      await expect(repos.runs.findByIdempotencyKey(record.idempotencyKey)).resolves.toEqual(record);
      await expect(
        repos.runs.findByIdempotencyKey("unknown" as IdempotencyKey),
      ).resolves.toBeNull();
    });

    it("never exposes the persistence-only revision on returned records (AC-15)", async () => {
      const created = await repos.runs.create(makeRun());
      const fetched = await repos.runs.getById(created.runId);

      expect(Object.hasOwn(created, "revision")).toBe(false);
      expect(fetched).not.toBeNull();
      expect(Object.hasOwn(fetched as RunRecord, "revision")).toBe(false);
    });

    // ── CheckpointRepository ────────────────────────────────────────────────

    it("round-trips checkpoints through create, getLatest and listByRunId", async () => {
      const run = await repos.runs.create(makeRun());
      const checkpoint = makeCheckpoint(run.runId, {
        payload: { step: "approve", nested: { a: 1 } },
        createdAt: "2026-05-01T08:00:00.500Z",
      });

      await repos.checkpoints.create(checkpoint);

      await expect(repos.checkpoints.getLatest(run.runId)).resolves.toEqual(checkpoint);
      await expect(repos.checkpoints.listByRunId(run.runId)).resolves.toEqual([checkpoint]);
    });

    it("returns null and [] when the run has no checkpoints", async () => {
      const run = await repos.runs.create(makeRun());

      await expect(repos.checkpoints.getLatest(run.runId)).resolves.toBeNull();
      await expect(repos.checkpoints.listByRunId(run.runId)).resolves.toEqual([]);
    });

    it("orders checkpoints by createdAt ascending with attempt tie-break (AC-25)", async () => {
      const run = await repos.runs.create(makeRun());
      const later = makeCheckpoint(run.runId, {
        createdAt: "2026-05-01T08:00:02.000Z",
        attempt: 1,
      });
      const sameMoment = makeCheckpoint(run.runId, {
        createdAt: "2026-05-01T08:00:02.000Z",
        attempt: 0,
      });
      const first = makeCheckpoint(run.runId, {
        createdAt: "2026-05-01T08:00:01.000Z",
        attempt: 2,
      });
      for (const checkpoint of [later, sameMoment, first]) {
        await repos.checkpoints.create(checkpoint);
      }

      await expect(repos.checkpoints.listByRunId(run.runId)).resolves.toEqual([
        first,
        sameMoment,
        later,
      ]);
      await expect(repos.checkpoints.getLatest(run.runId)).resolves.toEqual(later);
    });
  });
}

// ─── ScheduleRepository shared battery (AC-27..AC-29 → REV-29) ──────────────

for (const backend of scheduleBackends) {
  describe(`schedule repository contract — ${backend.name}`, () => {
    let repos: ContractScheduleRepos;

    beforeEach(async () => {
      repos = await backend.create();
    });

    afterEach(async () => {
      await repos.dispose();
    });

    /** Seeded standard set: ids are explicit so expectations read clearly. */
    async function seedStandardSet() {
      const alpha = makeContractSchedule({
        scheduleId: "sched-a" as ScheduleId,
        idempotencyKey: "contract-schedule:a",
      });
      const beta = makeContractSchedule({
        scheduleId: "sched-b" as ScheduleId,
        idempotencyKey: "contract-schedule:b",
        enabled: false,
      });
      const gamma = makeContractSchedule({
        scheduleId: "sched-c" as ScheduleId,
        idempotencyKey: "contract-schedule:c",
        config: makeContractConfig({ brandId: "gerit", market: "ES" }),
      });
      const delta = makeContractSchedule({
        scheduleId: "sched-d" as ScheduleId,
        idempotencyKey: "contract-schedule:d",
        config: makeContractConfig({ platform: "gbp_other" }),
      });
      // Inserted out of ScheduleId order: SQL must still return ASC order.
      for (const record of [delta, gamma, beta, alpha]) {
        await repos.schedules.create(record);
      }
      return { alpha, beta, gamma, delta };
    }

    it("round-trips a complete schedule through create and getById (AC-27)", async () => {
      const record = makeContractSchedule({
        config: makeContractConfig({
          cron: "@daily",
          mode: "batch",
          enabled: false,
          metadata: { owner: "ops", tags: ["daily", "pt"] },
        }),
        enabled: false,
        lastRunAt: new Date("2026-05-02T03:00:00.000Z"),
        nextRunAt: new Date("2026-05-03T03:00:00.000Z"),
        revision: 3,
      });

      await repos.schedules.create(record);
      const fetched = await repos.schedules.getById(record.scheduleId as ScheduleId);

      expect(fetched).toEqual(record);
      expect(fetched?.lastRunAt).toBeInstanceOf(Date);
      expect(fetched?.nextRunAt).toBeInstanceOf(Date);
      expect(fetched?.config.metadata).toEqual({ owner: "ops", tags: ["daily", "pt"] });
      expect(fetched?.config.enabled).toBe(fetched?.enabled);
    });

    it("rejects a duplicate scheduleId with the shared parity message", async () => {
      const record = makeContractSchedule();
      await repos.schedules.create(record);

      await expect(repos.schedules.create({ ...record })).rejects.toThrow(
        `Record already exists: ${record.scheduleId}`,
      );
    });

    it("returns [] from list on an empty store", async () => {
      await expect(repos.schedules.list()).resolves.toEqual([]);
      await expect(repos.schedules.list({})).resolves.toEqual([]);
    });

    it("returns every schedule (ordered by ScheduleId on SQL) and honours brandId/market/platform", async () => {
      const { gamma, delta } = await seedStandardSet();

      const all = await repos.schedules.list();
      const scheduleIds = all.map((record) => record.scheduleId);

      // Membership + length hold for both backends; FS `readdirSync` order is
      // not guaranteed, so the sorted comparison is the portable expectation.
      expect([...scheduleIds].sort()).toEqual(["sched-a", "sched-b", "sched-c", "sched-d"]);
      // Deterministic `ORDER BY ScheduleId ASC` is a SQL-only guarantee.
      if (backend.listOrderedByScheduleId) {
        expect(scheduleIds).toEqual(["sched-a", "sched-b", "sched-c", "sched-d"]);
      }

      // Single-match filters are order-independent for both backends.
      expect(await repos.schedules.list({ brandId: "gerit" })).toEqual([gamma]);
      expect(await repos.schedules.list({ market: "ES" })).toEqual([gamma]);
      expect(await repos.schedules.list({ market: "FR" })).toEqual([]);
      expect(await repos.schedules.list({ platform: "gbp_other" })).toEqual([delta]);
      expect(
        await repos.schedules.list({ brandId: "best-fluency", platform: "gbp_other" }),
      ).toEqual([delta]);

      // Multi-match filter: compare membership, order only where guaranteed.
      const ptIds = (await repos.schedules.list({ market: "PT" }))
        .map((record) => record.scheduleId)
        .sort();
      expect(ptIds).toEqual(["sched-a", "sched-b", "sched-d"]);
      expect(
        (await repos.schedules.list({ brandId: "best-fluency", market: "PT" }))
          .map((record) => record.scheduleId)
          .sort(),
      ).toEqual(["sched-a", "sched-b", "sched-d"]);
    });

    it("filters enabled=true, enabled=false and treats an absent enabled filter as no filter (AC-29)", async () => {
      const { beta } = await seedStandardSet();

      const enabledIds = (await repos.schedules.list({ enabled: true }))
        .map((record) => record.scheduleId)
        .sort();
      expect(enabledIds).toEqual(["sched-a", "sched-c", "sched-d"]);
      expect(await repos.schedules.list({ enabled: false })).toEqual([beta]);

      // Absent `enabled` ({} / undefined) matches everything — parity with
      // FileScheduleRepository, where the filter is skipped when undefined.
      const allIds = (await repos.schedules.list({})).map((record) => record.scheduleId).sort();
      expect(allIds).toEqual(["sched-a", "sched-b", "sched-c", "sched-d"]);
      expect((await repos.schedules.list()).map((record) => record.scheduleId).sort()).toEqual(
        allIds,
      );

      // Combined string + enabled filters stay order-independent.
      const bfEnabled = (await repos.schedules.list({ brandId: "best-fluency", enabled: true }))
        .map((record) => record.scheduleId)
        .sort();
      expect(bfEnabled).toEqual(["sched-a", "sched-d"]);
    });

    it("finds a schedule by its unique idempotency key and returns null for unknown keys", async () => {
      const record = makeContractSchedule();
      await repos.schedules.create(record);

      await expect(repos.schedules.findByIdempotencyKey(record.idempotencyKey)).resolves.toEqual(
        record,
      );
      await expect(
        repos.schedules.findByIdempotencyKey("contract-schedule:unknown"),
      ).resolves.toBeNull();
    });

    it("persists an update, returns revision + 1 and reflects it in getById (AC-28)", async () => {
      const created = await repos.schedules.create(makeContractSchedule());
      const next: ScheduleRecord = {
        ...created,
        config: { ...created.config, cron: "0 4 * * *" },
        updatedAt: new Date("2026-05-01T10:00:00.000Z"),
      };

      const result = await repos.schedules.update(next);

      expect(result).toEqual({ ...next, revision: created.revision + 1 });
      expect(result.revision).toBe(1);
      await expect(repos.schedules.getById(created.scheduleId as ScheduleId)).resolves.toEqual(
        result,
      );
    });

    it("throws ConcurrencyConflictError with expected and actual revisions on a stale update (AC-28)", async () => {
      const created = await repos.schedules.create(makeContractSchedule());

      let caught: unknown;
      try {
        await repos.schedules.update({ ...created, revision: 99 });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ConcurrencyConflictError);
      const conflict = caught as ConcurrencyConflictError;
      expect(conflict.recordId).toBe(created.scheduleId);
      expect(conflict.expectedRevision).toBe(99);
      expect(conflict.actualRevision).toBe(0);
      await expect(repos.schedules.getById(created.scheduleId as ScheduleId)).resolves.toEqual(
        created,
      );
    });

    it("throws the shared not-found message when updating a missing schedule", async () => {
      const missing = makeContractSchedule({ scheduleId: "sched-absent" as ScheduleId });

      await expect(repos.schedules.update(missing)).rejects.toThrow(
        `Record not found: ${missing.scheduleId}`,
      );
    });
  });
}

// ─── Schedule divergence — Enabled storage (D-12 / REV-30) ──────────────────
// Per-backend expectations: FileScheduleRepository (authoritative for
// divergence) persists `enabled` and `config.enabled` independently, while
// the SQL backend has one frozen `Enabled` BIT column and fails fast instead
// of collapsing the pair.

describe("schedule divergence — filesystem preserves a divergent Enabled pair (D-12)", () => {
  let repos: ContractScheduleRepos;

  beforeEach(async () => {
    repos = await createFsScheduleRepos();
  });

  afterEach(async () => {
    await repos.dispose();
  });

  it("round-trips config.enabled and enabled as two independent fields", async () => {
    const base = makeContractSchedule();
    const divergent: ScheduleRecord = {
      ...base,
      enabled: false,
      config: { ...base.config, enabled: true },
    };

    await repos.schedules.create(divergent);
    const fetched = await repos.schedules.getById(divergent.scheduleId as ScheduleId);

    expect(fetched).toEqual(divergent);
    expect(fetched?.enabled).toBe(false);
    expect(fetched?.config.enabled).toBe(true);
  });
});

describe("schedule divergence — sqlserver rejects a divergent Enabled pair (D-12, REV-30)", () => {
  let repos: ContractScheduleRepos;

  beforeEach(async () => {
    repos = await createSqlScheduleRepos();
  });

  afterEach(async () => {
    await repos.dispose();
  });

  it("rejects create with a clear invariant error and persists nothing", async () => {
    const base = makeContractSchedule();
    const divergent: ScheduleRecord = {
      ...base,
      enabled: false,
      config: { ...base.config, enabled: true },
    };

    await expect(repos.schedules.create(divergent)).rejects.toThrow(
      `Enabled invariant violated for schedule ${base.scheduleId}`,
    );
    await expect(repos.schedules.list()).resolves.toEqual([]);
    await expect(repos.schedules.getById(base.scheduleId as ScheduleId)).resolves.toBeNull();
  });

  it("rejects update with the invariant error and leaves the stored row untouched", async () => {
    const created = await repos.schedules.create(makeContractSchedule());
    const divergent: ScheduleRecord = {
      ...created,
      enabled: true,
      config: { ...created.config, enabled: false },
    };

    await expect(repos.schedules.update(divergent)).rejects.toThrow(
      `Enabled invariant violated for schedule ${created.scheduleId}`,
    );
    await expect(repos.schedules.getById(created.scheduleId as ScheduleId)).resolves.toEqual(
      created,
    );
  });
});

// ─── Deliberate divergence tests (REV-13 → decision D-12) ───────────────────
// These expectations are intentionally different per backend and therefore
// live OUTSIDE the shared battery above.

describe("deliberate divergence — filesystem backend (D-12)", () => {
  let repos: ContractRepos;

  beforeEach(async () => {
    repos = await createFsRepos();
  });

  afterEach(async () => {
    await repos.dispose();
  });

  it("persists a second run when only the idempotency key repeats", async () => {
    const first = makeRun();
    const second = makeRun({ idempotencyKey: first.idempotencyKey });

    await repos.runs.create(first);
    await repos.runs.create(second);

    const stored = await repos.runs.list();
    expect([...stored.map((record) => record.runId)].sort()).toEqual(
      [first.runId, second.runId].sort(),
    );
    // FS has no unique index on idempotencyKey: the winner of a lookup is
    // whichever record `readdirSync` enumerates first (non-deterministic).
    const match = await repos.runs.findByIdempotencyKey(first.idempotencyKey);
    expect([first.runId, second.runId]).toContain(match?.runId);
  });

  it("accepts a checkpoint whose parent run does not exist", async () => {
    const orphan = makeCheckpoint("orphan-run" as RunId);

    await expect(repos.checkpoints.create(orphan)).resolves.toEqual(orphan);
    await expect(repos.checkpoints.listByRunId("orphan-run" as RunId)).resolves.toEqual([orphan]);
  });

  it("enumerates list() without any ordering guarantee (D-12, divergence 3)", async () => {
    // Divergence 3 (D-12): `FileRunRepository.list()` reads with `readdirSync`
    // without sorting, so raw enumeration order is NOT part of the FS contract
    // and is deliberately not asserted here — unlike the SQL describe below,
    // which pins `ORDER BY RunId ASC`. Only membership is portable, hence the
    // sorted comparison (REV-12).
    const first = makeRun({ runId: "order-c" as RunId });
    const second = makeRun({ runId: "order-a" as RunId });
    const third = makeRun({ runId: "order-b" as RunId });
    for (const record of [first, second, third]) {
      await repos.runs.create(record);
    }

    const stored = await repos.runs.list();
    expect([...stored.map((record) => record.runId)].sort()).toEqual([
      "order-a",
      "order-b",
      "order-c",
    ]);
  });
});

describe("deliberate divergence — sqlserver backend (D-12)", () => {
  let executor: FakeSqlExecutor;
  let repos: ContractRepos;

  beforeEach(async () => {
    executor = createFakeSqlExecutor();
    repos = {
      runs: new SqlRunRepository(executor) as unknown as ContractRunRepository,
      checkpoints: new SqlCheckpointRepository(executor),
      dispose: () => executor.close(),
    };
  });

  afterEach(async () => {
    await repos.dispose();
  });

  it("returns the durable winner and never stores a duplicate idempotency key", async () => {
    const first = makeRun();
    const second = makeRun({ idempotencyKey: first.idempotencyKey });

    await repos.runs.create(first);
    const winner = await repos.runs.create(second);

    expect(winner).toEqual(first);
    expect(winner.runId).toBe(first.runId);
    expect(executor.runs.size).toBe(1);
  });

  it("rejects a checkpoint whose parent run does not exist (FK_Checkpoints_Runs)", async () => {
    const orphan = makeCheckpoint("orphan-run" as RunId);

    await expect(repos.checkpoints.create(orphan)).rejects.toThrow(/FK_Checkpoints_Runs/);
    await expect(repos.checkpoints.listByRunId("orphan-run" as RunId)).resolves.toEqual([]);
  });

  it("returns list() ordered by RunId ascending even when inserted out of order (D-12, divergence 3)", async () => {
    // Divergence 3 (D-12): `SELECT_RUNS_SQL` carries `ORDER BY RunId ASC`
    // (sql-run-repo.ts) and the fake executor models it (selectRuns sorts by
    // RunId), so the SQL backend is the ONLY one where `list()` order is a
    // contract guarantee — the filesystem describe above asserts membership
    // only.
    const first = makeRun({ runId: "order-c" as RunId });
    const second = makeRun({ runId: "order-a" as RunId });
    const third = makeRun({ runId: "order-b" as RunId });
    for (const record of [first, second, third]) {
      await repos.runs.create(record);
    }

    const stored = await repos.runs.list();
    expect(stored.map((record) => record.runId)).toEqual(["order-a", "order-b", "order-c"]);
  });
});

// ─── Fake executor self-tests ────────────────────────────────────────────────

function runInsertParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "run-self",
    schemaVersion: 1,
    brandId: "best-fluency",
    market: "PT",
    platform: "google_business_profile",
    operation: "sync_listings",
    state: "queued",
    attempt: 0,
    maxAttempts: 3,
    idempotencyKey: "idem-self",
    payloadFingerprint: "c".repeat(64),
    createdAt: new Date("2026-05-02T08:00:00.000Z"),
    updatedAt: new Date("2026-05-02T08:00:00.000Z"),
    startedAt: null,
    finishedAt: null,
    errorMessage: null,
    errorCode: null,
    errorRetryable: null,
    metadataJson: null,
    storedAt: new Date("2026-05-02T08:00:00.000Z"),
    ...overrides,
  };
}

function checkpointInsertParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "run-self",
    state: "running",
    attempt: 0,
    payloadJson: "{}",
    createdAt: new Date("2026-05-02T08:00:00.000Z"),
    ...overrides,
  };
}

describe("fake SQL executor self-tests", () => {
  it("rejects unknown statements with an actionable SqlExecutorError", async () => {
    const executor = createFakeSqlExecutor();

    let caught: unknown;
    try {
      await executor.query("DECLARE @x INT");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SqlExecutorError);
    expect((caught as SqlExecutorError).message).toContain(
      "Statement not supported by the fake SQL executor",
    );
  });

  it("applies transaction statements sequentially", async () => {
    const executor = createFakeSqlExecutor();

    await executor.transaction([{ text: INSERT_RUN_SQL, params: runInsertParams() }]);

    expect(executor.runs.size).toBe(1);
  });

  it("restores the pre-transaction state when a statement fails", async () => {
    const executor = createFakeSqlExecutor();
    executor.seedRun({ RunId: "run-existing" });

    await expect(
      executor.transaction([
        { text: INSERT_RUN_SQL, params: runInsertParams() },
        { text: "DECLARE @boom INT" },
      ]),
    ).rejects.toThrow(SqlExecutorError);

    expect(executor.runs.size).toBe(1);
    expect(executor.runs.has("run-existing")).toBe(true);
    expect(executor.runs.has("run-self")).toBe(false);
  });

  it("close() resolves without touching stored rows", async () => {
    const executor = createFakeSqlExecutor();
    executor.seedRun({ RunId: "run-existing" });

    await executor.close();

    expect(executor.runs.size).toBe(1);
  });

  it("raises CK_Runs_MetadataJson for a non-text metadata column", async () => {
    const executor = createFakeSqlExecutor();

    await expect(
      executor.query(INSERT_RUN_SQL, runInsertParams({ metadataJson: 42 })),
    ).rejects.toThrow(/CK_Runs_MetadataJson/);
  });

  it("raises CK_Runs_MetadataJson for invalid JSON metadata", async () => {
    const executor = createFakeSqlExecutor();

    await expect(
      executor.query(INSERT_RUN_SQL, runInsertParams({ metadataJson: "{nope" })),
    ).rejects.toThrow(/CK_Runs_MetadataJson/);
  });

  it("raises CK_Runs_PayloadFingerprint for a non-text fingerprint", async () => {
    const executor = createFakeSqlExecutor();

    await expect(
      executor.query(INSERT_RUN_SQL, runInsertParams({ payloadFingerprint: 123 })),
    ).rejects.toThrow(/CK_Runs_PayloadFingerprint/);
  });

  it("raises FK_Checkpoints_Runs for a checkpoint without its parent run", async () => {
    const executor = createFakeSqlExecutor();

    await expect(
      executor.query(INSERT_CHECKPOINT_SQL, checkpointInsertParams({ runId: "run-absent" })),
    ).rejects.toThrow(/FK_Checkpoints_Runs/);
  });

  it("raises CK_Checkpoints_PayloadJson for non-text and invalid payloads", async () => {
    const executor = createFakeSqlExecutor();
    executor.seedRun({ RunId: "run-self" });

    await expect(
      executor.query(INSERT_CHECKPOINT_SQL, checkpointInsertParams({ payloadJson: 7 })),
    ).rejects.toThrow(/CK_Checkpoints_PayloadJson/);
    await expect(
      executor.query(INSERT_CHECKPOINT_SQL, checkpointInsertParams({ payloadJson: "{" })),
    ).rejects.toThrow(/CK_Checkpoints_PayloadJson/);
  });

  it("accepts valid inserts and seeds bypass constraint checks", async () => {
    const executor = createFakeSqlExecutor();
    executor.seedRun({ RunId: "run-self" });
    executor.seedRun({ RunId: "run-invalid-state", State: "bogus" });

    await expect(executor.query(INSERT_CHECKPOINT_SQL, checkpointInsertParams())).resolves.toEqual({
      columns: [],
      rows: [],
    });
    expect(executor.runs.get("run-invalid-state")?.State).toBe("bogus");
  });
});
