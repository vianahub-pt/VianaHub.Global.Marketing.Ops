import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { IdempotencyKey, RunId } from "../../domain/idempotency.js";
import type { RunRecord } from "../../domain/run-record.js";
import { ConcurrencyConflictError, CorruptedRecordError } from "../persistence-errors.js";
import { createFakeSqlExecutor } from "./fake-sql-executor.js";
import { SqlRunRepository } from "./sql-run-repo.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

let nextRunSequence = 0;

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  nextRunSequence += 1;
  return {
    schemaVersion: 1,
    runId: `run-${nextRunSequence}` as RunId,
    brandId: "best-fluency",
    market: "PT",
    platform: "google_business_profile",
    operation: "sync_listings",
    state: "queued",
    attempt: 0,
    maxAttempts: 3,
    idempotencyKey: `idem-${nextRunSequence}` as IdempotencyKey,
    payloadFingerprint: "a".repeat(64) as RunRecord["payloadFingerprint"],
    createdAt: new Date("2026-04-01T10:00:00.000Z"),
    updatedAt: new Date("2026-04-01T10:00:00.000Z"),
    ...overrides,
  };
}

function newRepo() {
  const executor = createFakeSqlExecutor();
  return { executor, repo: new SqlRunRepository(executor) };
}

// ─── create / getById ────────────────────────────────────────────────────────

describe("SqlRunRepository — create and getById", () => {
  it("round-trips a minimal record without optional fields", async () => {
    const { repo } = newRepo();
    const record = makeRun();

    await expect(repo.create(record)).resolves.toEqual(record);
    await expect(repo.getById(record.runId)).resolves.toEqual(record);
  });

  it("round-trips every optional field (dates, error, metadata)", async () => {
    const { repo } = newRepo();
    const record = makeRun({
      state: "failed",
      attempt: 2,
      startedAt: new Date("2026-04-01T10:00:05.123Z"),
      finishedAt: new Date("2026-04-01T10:00:09.456Z"),
      error: { message: "GBP API returned 500", code: "EHTTP", retryable: true },
      metadata: { batch: "b-42", items: 7 },
    });

    await repo.create(record);
    const fetched = await repo.getById(record.runId);

    expect(fetched).toEqual(record);
    expect(fetched?.startedAt).toBeInstanceOf(Date);
    expect(fetched?.error?.retryable).toBe(true);
    expect(fetched?.metadata).toEqual({ batch: "b-42", items: 7 });
  });

  it("returns null for an unknown runId", async () => {
    const { repo } = newRepo();
    await expect(repo.getById("run-missing" as RunId)).resolves.toBeNull();
  });

  it("rejects a duplicate runId with the file-parity message (AC-16)", async () => {
    const { repo } = newRepo();
    const record = makeRun();
    await repo.create(record);

    await expect(repo.create({ ...record })).rejects.toThrow(
      `Record already exists: ${record.runId}`,
    );
  });

  it("returns the durable winner when the idempotency key already exists (AC-22)", async () => {
    const { executor, repo } = newRepo();
    const first = makeRun();
    const second = makeRun({ idempotencyKey: first.idempotencyKey });
    await repo.create(first);

    const result = await repo.create(second);

    expect(result).toEqual(first);
    expect(result.runId).toBe(first.runId);
    expect(executor.runs.size).toBe(1);
  });

  it("rethrows the original constraint error when no durable record explains it", async () => {
    const { repo } = newRepo();
    const bad = makeRun({ payloadFingerprint: "tooshort" as RunRecord["payloadFingerprint"] });

    await expect(repo.create(bad)).rejects.toThrow(/CK_Runs_PayloadFingerprint/);
  });

  it("rethrows the original PK error when the runId probe itself is corrupted", async () => {
    const { executor, repo } = newRepo();
    executor.seedRun({ RunId: "run-corrupt", MetadataJson: "{not-json" });
    const conflicting = makeRun({ runId: "run-corrupt" as RunId });

    await expect(repo.create(conflicting)).rejects.toThrow(/PK_Runs/);
  });

  it("rethrows the original UQ error when the idempotency probe itself is corrupted", async () => {
    const { executor, repo } = newRepo();
    executor.seedRun({
      RunId: "run-corrupt-2",
      IdempotencyKey: "shared-key",
      MetadataJson: "}",
    });
    const attempt = makeRun({ idempotencyKey: "shared-key" as IdempotencyKey });

    await expect(repo.create(attempt)).rejects.toThrow(/UQ_Runs_IdempotencyKey/);
  });

  it("surfaces the state CHECK constraint from the storage layer", async () => {
    const { repo } = newRepo();
    const bad = makeRun({ state: "bogus" as RunRecord["state"] });

    await expect(repo.create(bad)).rejects.toThrow(/CK_Runs_State/);
  });

  it("never exposes the persistence-only revision on returned records (AC-15)", async () => {
    const { repo } = newRepo();
    const created = await repo.create(makeRun());
    expect(Object.hasOwn(created, "revision")).toBe(false);

    const fetched = await repo.getById(created.runId);
    expect(fetched).not.toBeNull();
    expect(Object.hasOwn(fetched as RunRecord, "revision")).toBe(false);
  });
});

// ─── update ──────────────────────────────────────────────────────────────────

describe("SqlRunRepository — update", () => {
  it("applies an unconditional update and increments the stored revision", async () => {
    const { executor, repo } = newRepo();
    const record = await repo.create(makeRun());
    const next: RunRecord = {
      ...record,
      state: "running",
      updatedAt: new Date("2026-04-01T11:00:00.000Z"),
    };

    const result = await repo.update(next);

    expect(result).toEqual(next);
    expect(executor.runs.get(record.runId)?.Revision).toBe(2);
    await expect(repo.getById(record.runId)).resolves.toEqual(next);
  });

  it("throws the file-parity not-found message without a revision guard", async () => {
    const { repo } = newRepo();
    await expect(repo.update(makeRun())).rejects.toThrow(/^Record not found: /);
  });

  it("applies a guarded update when the expected revision matches (AC-21)", async () => {
    const { executor, repo } = newRepo();
    const record = await repo.create(makeRun());
    const next: RunRecord = { ...record, state: "running" };

    await repo.update(next, 1);

    expect(executor.runs.get(record.runId)?.Revision).toBe(2);
    await expect(repo.getById(record.runId)).resolves.toEqual(next);
  });

  it("throws ConcurrencyConflictError with the actual stored revision (AC-21)", async () => {
    const { repo } = newRepo();
    const record = await repo.create(makeRun());
    const next: RunRecord = { ...record, state: "running" };

    let caught: unknown;
    try {
      await repo.update(next, 99);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConcurrencyConflictError);
    const conflict = caught as ConcurrencyConflictError;
    expect(conflict.recordId).toBe(record.runId);
    expect(conflict.expectedRevision).toBe(99);
    expect(conflict.actualRevision).toBe(1);
    // The stored row must be untouched after the conflict.
    expect((await repo.getById(record.runId))?.state).toBe("queued");
  });

  it("throws the not-found message when the guarded target does not exist", async () => {
    const { repo } = newRepo();
    await expect(repo.update(makeRun(), 1)).rejects.toThrow(/^Record not found: /);
  });
});

// ─── list ────────────────────────────────────────────────────────────────────

describe("SqlRunRepository — list", () => {
  it("returns every record ordered by runId when no filters are given", async () => {
    const { repo } = newRepo();
    const runB = makeRun({ runId: "run-b" as RunId });
    const runA = makeRun({ runId: "run-a" as RunId });
    const runC = makeRun({ runId: "run-c" as RunId });
    for (const record of [runB, runA, runC]) {
      await repo.create(record);
    }

    const all = await repo.list();

    expect(all.map((record) => record.runId)).toEqual(["run-a", "run-b", "run-c"]);
  });

  it("applies every supported filter and returns [] for non-matches", async () => {
    const { repo } = newRepo();
    const base = makeRun({ runId: "run-a" as RunId });
    const spanish = makeRun({ runId: "run-b" as RunId, market: "ES" });
    const otherBrand = makeRun({ runId: "run-c" as RunId, brandId: "other-brand" });
    const otherPlatform = makeRun({ runId: "run-d" as RunId, platform: "gbp_other" });
    const otherOperation = makeRun({ runId: "run-e" as RunId, operation: "refresh_place" });
    const done = makeRun({ runId: "run-f" as RunId, state: "succeeded" });
    for (const record of [base, spanish, otherBrand, otherPlatform, otherOperation, done]) {
      await repo.create(record);
    }

    expect(await repo.list({ market: "ES" })).toEqual([spanish]);
    expect(await repo.list({ brandId: "other-brand" })).toEqual([otherBrand]);
    expect(await repo.list({ platform: "gbp_other" })).toEqual([otherPlatform]);
    expect(await repo.list({ operation: "refresh_place" })).toEqual([otherOperation]);
    expect(await repo.list({ state: "succeeded" })).toEqual([done]);
    expect(await repo.list({ market: "PT", state: "queued" })).toEqual([
      base,
      otherBrand,
      otherPlatform,
      otherOperation,
    ]);
    expect(await repo.list({ market: "FR" })).toEqual([]);
  });

  it("treats an empty-string filter as no match, like the file adapter", async () => {
    const { repo } = newRepo();
    await repo.create(makeRun());

    expect(await repo.list({ brandId: "" })).toEqual([]);
    expect(await repo.list({ market: "", platform: "", operation: "" })).toEqual([]);
    expect(await repo.list({ state: "" as RunRecord["state"] })).toEqual([]);
  });
});

// ─── findByIdempotencyKey ────────────────────────────────────────────────────

describe("SqlRunRepository — findByIdempotencyKey", () => {
  it("finds a record by its idempotency key (FR-09)", async () => {
    const { repo } = newRepo();
    const record = makeRun();
    await repo.create(record);

    await expect(repo.findByIdempotencyKey(record.idempotencyKey)).resolves.toEqual(record);
  });

  it("returns null for an unknown key", async () => {
    const { repo } = newRepo();
    await expect(repo.findByIdempotencyKey("unknown-key" as IdempotencyKey)).resolves.toBeNull();
  });
});

// ─── Corrupted rows (FR-07/FR-08 parity) ─────────────────────────────────────

describe("SqlRunRepository — corrupted storage", () => {
  it("throws CorruptedRecordError when MetadataJson is not valid JSON", async () => {
    const { executor, repo } = newRepo();
    executor.seedRun({ RunId: "run-1", MetadataJson: "{not-json" });

    await expect(repo.getById("run-1" as RunId)).rejects.toBeInstanceOf(CorruptedRecordError);
  });

  it("throws CorruptedRecordError when MetadataJson is not text", async () => {
    const { executor, repo } = newRepo();
    executor.seedRun({ RunId: "run-2", MetadataJson: 42 as unknown as string });

    await expect(repo.getById("run-2" as RunId)).rejects.toBeInstanceOf(CorruptedRecordError);
  });

  it("throws CorruptedRecordError when a datetime column is not a Date", async () => {
    const { executor, repo } = newRepo();
    executor.seedRun({
      RunId: "run-3",
      CreatedAt: "2026-01-01T00:00:00.000Z" as unknown as Date,
    });

    await expect(repo.getById("run-3" as RunId)).rejects.toBeInstanceOf(CorruptedRecordError);
  });

  it("throws CorruptedRecordError when State fails the domain enum", async () => {
    const { executor, repo } = newRepo();
    executor.seedRun({ RunId: "run-4", State: "bogus" });

    await expect(repo.getById("run-4" as RunId)).rejects.toBeInstanceOf(CorruptedRecordError);
  });

  it("throws CorruptedRecordError when ErrorCode has the wrong type", async () => {
    const { executor, repo } = newRepo();
    executor.seedRun({
      RunId: "run-5",
      ErrorMessage: "boom",
      ErrorCode: 123 as unknown as string,
    });

    await expect(repo.getById("run-5" as RunId)).rejects.toBeInstanceOf(CorruptedRecordError);
  });

  it("propagates corruption during list, matching FR-08 behavior", async () => {
    const { executor, repo } = newRepo();
    executor.seedRun({ RunId: "run-6", MetadataJson: "{" });

    await expect(repo.list()).rejects.toBeInstanceOf(CorruptedRecordError);
  });
});

// ─── DDL assertions (static, no live database) ───────────────────────────────

describe("dbo.Runs DDL (AC-16, AC-17, AC-18, AC-19, AC-21, AC-35)", () => {
  const migrationSql = readFileSync(
    fileURLToPath(new URL("../../../database/migrations/001_initial_schema.sql", import.meta.url)),
    "utf8",
  );

  it("declares RunId as primary key and IdempotencyKey as unique (AC-16, AC-17)", () => {
    expect(migrationSql).toContain("CONSTRAINT PK_Runs PRIMARY KEY CLUSTERED (RunId)");
    expect(migrationSql).toContain("CONSTRAINT UQ_Runs_IdempotencyKey UNIQUE (IdempotencyKey)");
  });

  it("declares revision, storedAt and every RunRecord column", () => {
    expect(migrationSql).toContain("RunId NVARCHAR(64) NOT NULL");
    expect(migrationSql).toContain("SchemaVersion INT NOT NULL");
    expect(migrationSql).toContain("IdempotencyKey NVARCHAR(128) NOT NULL");
    expect(migrationSql).toContain("PayloadFingerprint NVARCHAR(64) NOT NULL");
    expect(migrationSql).toContain("CreatedAt DATETIME2(3) NOT NULL");
    expect(migrationSql).toContain("UpdatedAt DATETIME2(3) NOT NULL");
    expect(migrationSql).toContain("StartedAt DATETIME2(3) NULL");
    expect(migrationSql).toContain("FinishedAt DATETIME2(3) NULL");
    expect(migrationSql).toContain("ErrorMessage NVARCHAR(MAX) NULL");
    expect(migrationSql).toContain("ErrorCode NVARCHAR(100) NULL");
    expect(migrationSql).toContain("ErrorRetryable BIT NULL");
    expect(migrationSql).toContain("MetadataJson NVARCHAR(MAX) NULL");
    expect(migrationSql).toContain("Revision INT NOT NULL");
    expect(migrationSql).toContain("StoredAt DATETIME2(3) NOT NULL");
  });

  it("declares the concurrency and data checks (AC-21, AC-35, AC-39)", () => {
    expect(migrationSql).toContain("CONSTRAINT CK_Runs_Revision CHECK (Revision >= 1)");
    expect(migrationSql).toContain("CK_Runs_State");
    expect(migrationSql).toContain("CK_Runs_PayloadFingerprint");
    expect(migrationSql).toContain("LEN(PayloadFingerprint) = 64");
    expect(migrationSql).toContain("CK_Runs_MetadataJson");
    expect(migrationSql).toContain("ISJSON(MetadataJson) = 1");
  });

  it("declares the filter indexes backing list() (AC-19)", () => {
    expect(migrationSql).toContain("IX_Runs_Filters");
    expect(migrationSql).toContain("ON dbo.Runs (BrandId, Market, Platform, Operation, State)");
    expect(migrationSql).toContain("IX_Runs_State");
    expect(migrationSql).toContain("ON dbo.Runs (State)");
  });

  it("declares exactly one unique constraint over IdempotencyKey (AC-18)", () => {
    // Static proxy for AC-18: the `UQ_Runs_IdempotencyKey` constraint declared
    // in database/migrations/001_initial_schema.sql generates a unique index
    // (SQL Server creates one for every UNIQUE constraint), so
    // findByIdempotencyKey is index-backed. The live `sys.indexes` /
    // `sys.index_columns` verification that the engine exposes that unique
    // index needs a real database and therefore runs in the env-gated
    // `index-sql-integration.test.ts` (SQL_INTEGRATION_URL — AC-50, cycle I-4);
    // ordinary PR CI never opens a connection, so this check stays static here.
    const uniqueConstraints =
      migrationSql.match(/CONSTRAINT\s+UQ_\w+\s+UNIQUE\s*\(\s*IdempotencyKey\s*\)/g) ?? [];
    expect(uniqueConstraints).toEqual([
      "CONSTRAINT UQ_Runs_IdempotencyKey UNIQUE (IdempotencyKey)",
    ]);
    expect(migrationSql).toContain("IdempotencyKey NVARCHAR(128) NOT NULL");
  });
});
