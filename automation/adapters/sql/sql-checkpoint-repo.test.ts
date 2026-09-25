import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { RunId } from "../../domain/idempotency.js";
import type { CheckpointDto } from "../checkpoint-repository.js";
import { CorruptedRecordError } from "../persistence-errors.js";
import { createFakeSqlExecutor } from "./fake-sql-executor.js";
import { SqlCheckpointRepository } from "./sql-checkpoint-repo.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

let nextCheckpointSequence = 0;

function makeCheckpoint(overrides: Partial<CheckpointDto> = {}): CheckpointDto {
  nextCheckpointSequence += 1;
  return {
    runId: `run-ckpt-${nextCheckpointSequence}` as RunId,
    state: "running",
    attempt: 0,
    payload: { step: "fetch", cursor: `c-${nextCheckpointSequence}` },
    createdAt: "2026-04-02T09:00:00.000Z",
    ...overrides,
  };
}

function newRepo() {
  const executor = createFakeSqlExecutor();
  return { executor, repo: new SqlCheckpointRepository(executor) };
}

// ─── create / getLatest / listByRunId ────────────────────────────────────────

describe("SqlCheckpointRepository — round-trips", () => {
  it("round-trips a checkpoint through create and getLatest", async () => {
    const { executor, repo } = newRepo();
    const checkpoint = makeCheckpoint();
    executor.seedRun({ RunId: checkpoint.runId });

    await expect(repo.create(checkpoint)).resolves.toEqual(checkpoint);
    await expect(repo.getLatest(checkpoint.runId)).resolves.toEqual(checkpoint);
  });

  it("round-trips payload and every field through listByRunId", async () => {
    const { executor, repo } = newRepo();
    const checkpoint = makeCheckpoint({
      state: "waiting_manual",
      attempt: 3,
      payload: { step: "approve", reason: "manual review", nested: { a: 1 } },
      createdAt: "2026-04-02T10:30:45.789Z",
    });
    executor.seedRun({ RunId: checkpoint.runId });
    await repo.create(checkpoint);

    const all = await repo.listByRunId(checkpoint.runId);

    expect(all).toEqual([checkpoint]);
    expect(all[0].payload).toEqual({ step: "approve", reason: "manual review", nested: { a: 1 } });
    expect(all[0].createdAt).toBe("2026-04-02T10:30:45.789Z");
  });

  it("returns null and [] for a run without checkpoints", async () => {
    const { repo } = newRepo();
    const unknown = "run-without-checkpoints" as RunId;

    await expect(repo.getLatest(unknown)).resolves.toBeNull();
    await expect(repo.listByRunId(unknown)).resolves.toEqual([]);
  });
});

// ─── Ordering (AC-25) ────────────────────────────────────────────────────────

describe("SqlCheckpointRepository — ordering (AC-25)", () => {
  it("orders by CreatedAt ASC, then Attempt ASC", async () => {
    const { executor, repo } = newRepo();
    const runId = "run-order" as RunId;
    executor.seedRun({ RunId: runId });
    const later = makeCheckpoint({ runId, createdAt: "2026-04-02T09:00:01.000Z", attempt: 2 });
    const sameMomentSecond = makeCheckpoint({
      runId,
      createdAt: "2026-04-02T09:00:01.000Z",
      attempt: 1,
    });
    const first = makeCheckpoint({ runId, createdAt: "2026-04-02T09:00:00.000Z", attempt: 5 });
    for (const checkpoint of [later, sameMomentSecond, first]) {
      await repo.create(checkpoint);
    }

    expect(await repo.listByRunId(runId)).toEqual([first, sameMomentSecond, later]);
    expect(await repo.getLatest(runId)).toEqual(later);
  });

  it("breaks full ties by insertion order (CheckpointId ASC) and prefers the newest", async () => {
    const { executor, repo } = newRepo();
    const runId = "run-tie" as RunId;
    executor.seedRun({ RunId: runId });
    const tieMoment = "2026-04-02T09:00:02.000Z";
    const first = makeCheckpoint({ runId, createdAt: tieMoment, attempt: 0 });
    const second = makeCheckpoint({ runId, createdAt: tieMoment, attempt: 0 });
    await repo.create(first);
    await repo.create(second);

    expect(await repo.listByRunId(runId)).toEqual([first, second]);
    expect(await repo.getLatest(runId)).toEqual(second);
  });
});

// ─── FK enforcement (AC-24) ──────────────────────────────────────────────────

describe("SqlCheckpointRepository — foreign key", () => {
  it("rejects a checkpoint whose run does not exist", async () => {
    const { repo } = newRepo();
    const orphan = makeCheckpoint({ runId: "run-missing" as RunId });

    await expect(repo.create(orphan)).rejects.toThrow(/FK_Checkpoints_Runs/);
  });
});

// ─── Corrupted rows (CK-04 parity) ──────────────────────────────────────────

describe("SqlCheckpointRepository — corrupted storage", () => {
  it("throws CorruptedRecordError when PayloadJson is not valid JSON", async () => {
    const { executor, repo } = newRepo();
    executor.seedCheckpoint({ RunId: "run-1", PayloadJson: "{broken" });

    await expect(repo.getLatest("run-1" as RunId)).rejects.toBeInstanceOf(CorruptedRecordError);
  });

  it("throws CorruptedRecordError when PayloadJson is not a JSON object", async () => {
    const { executor, repo } = newRepo();
    executor.seedCheckpoint({ RunId: "run-2", PayloadJson: '["array-not-object"]' });

    await expect(repo.listByRunId("run-2" as RunId)).rejects.toBeInstanceOf(CorruptedRecordError);
  });

  it("throws CorruptedRecordError when CreatedAt is not a Date", async () => {
    const { executor, repo } = newRepo();
    executor.seedCheckpoint({
      RunId: "run-3",
      CreatedAt: "2026-01-01T00:00:00.000Z" as unknown as Date,
    });

    await expect(repo.getLatest("run-3" as RunId)).rejects.toBeInstanceOf(CorruptedRecordError);
  });

  it("throws CorruptedRecordError when State fails the domain enum", async () => {
    const { executor, repo } = newRepo();
    executor.seedCheckpoint({ RunId: "run-4", State: "bogus" });

    await expect(repo.getLatest("run-4" as RunId)).rejects.toBeInstanceOf(CorruptedRecordError);
  });
});

// ─── Append-only surface (AC-23) ────────────────────────────────────────────

describe("SqlCheckpointRepository — append-only surface (AC-23)", () => {
  it("exposes only create/getLatest/listByRunId", () => {
    const methods = Object.getOwnPropertyNames(SqlCheckpointRepository.prototype);

    expect(methods).toEqual(expect.arrayContaining(["create", "getLatest", "listByRunId"]));
    expect(methods).not.toContain("update");
    expect(methods).not.toContain("upsert");
    expect(methods).not.toContain("delete");
    expect(methods).not.toContain("remove");
  });
});

// ─── DDL assertions (static, no live database) ───────────────────────────────

describe("dbo.Checkpoints DDL (AC-24, AC-25, AC-26)", () => {
  const migrationSql = readFileSync(
    fileURLToPath(new URL("../../../database/migrations/001_initial_schema.sql", import.meta.url)),
    "utf8",
  );

  it("declares columns, surrogate PK and the FK to dbo.Runs", () => {
    expect(migrationSql).toContain("CheckpointId BIGINT IDENTITY(1, 1) NOT NULL");
    expect(migrationSql).toContain("RunId NVARCHAR(64) NOT NULL");
    expect(migrationSql).toContain("SchemaVersion INT NOT NULL");
    expect(migrationSql).toContain("State NVARCHAR(32) NOT NULL");
    expect(migrationSql).toContain("Attempt INT NOT NULL");
    expect(migrationSql).toContain("PayloadJson NVARCHAR(MAX) NOT NULL");
    expect(migrationSql).toContain("CreatedAt DATETIME2(3) NOT NULL");
    expect(migrationSql).toContain(
      "CONSTRAINT PK_Checkpoints PRIMARY KEY CLUSTERED (CheckpointId)",
    );
    expect(migrationSql).toContain(
      "CONSTRAINT FK_Checkpoints_Runs FOREIGN KEY (RunId) REFERENCES dbo.Runs (RunId)",
    );
  });

  it("declares the payload check and the chronological index (AC-24, AC-25)", () => {
    expect(migrationSql).toContain(
      "CONSTRAINT CK_Checkpoints_PayloadJson CHECK (ISJSON(PayloadJson) = 1)",
    );
    expect(migrationSql).toContain("IX_Checkpoints_RunId_CreatedAt_Attempt");
    expect(migrationSql).toContain("ON dbo.Checkpoints (RunId, CreatedAt, Attempt)");
  });

  it("never mutates or deletes checkpoints in the migration (AC-23)", () => {
    expect(migrationSql).not.toContain("UPDATE dbo.Checkpoints");
    expect(migrationSql).not.toContain("DELETE FROM dbo.Checkpoints");
    expect(migrationSql).not.toContain("TRUNCATE TABLE dbo.Checkpoints");
    expect(migrationSql).not.toContain("DROP TABLE dbo.Checkpoints");
  });
});
