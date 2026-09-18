import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";
import type { CheckpointDto } from "./checkpoint-repository.js";
import { FileRunRepository } from "./file-run-repo.js";
import { FileCheckpointRepository } from "./file-checkpoint-repo.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let runRepoDir: string;
let checkpointRepoDir: string;

function createRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return {
    schemaVersion: 1,
    runId: "550e8400-e29b-41d4-a716-446655440000" as RunId,
    brandId: "best-fluency",
    market: "PT",
    platform: "google-business-profile",
    operation: "createLocalPost",
    state: "queued",
    attempt: 0,
    maxAttempts: 3,
    idempotencyKey: "a".repeat(64) as IdempotencyKey,
    payloadFingerprint: "b".repeat(64) as PayloadFingerprint,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function createCheckpointDto(runId: RunId, overrides?: Partial<CheckpointDto>): CheckpointDto {
  return {
    runId,
    state: "running",
    attempt: 1,
    payload: { step: "api-call" },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  runRepoDir = mkdtempSync(join(tmpdir(), "file-repo-integration-run-"));
  checkpointRepoDir = mkdtempSync(join(tmpdir(), "file-repo-integration-checkpoint-"));
});

afterEach(() => {
  rmSync(runRepoDir, { recursive: true, force: true });
  rmSync(checkpointRepoDir, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("FileRunRepository + FileCheckpointRepository integration (T-06)", () => {
  it("creates, reads, and updates a run with checkpoints", async () => {
    const runRepo = new FileRunRepository(runRepoDir);
    const checkpointRepo = new FileCheckpointRepository(checkpointRepoDir);

    const runId = "integration-run-1" as RunId;
    const record = createRunRecord({ runId });

    // 1. Create a run record
    const created = await runRepo.create(record);
    expect(created.runId).toBe(runId);

    // 2. Create checkpoints for the run
    const cp1 = createCheckpointDto(runId, {
      state: "running",
      attempt: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { phase: "start" },
    });
    await checkpointRepo.create(cp1);

    const cp2 = createCheckpointDto(runId, {
      state: "running",
      attempt: 2,
      createdAt: "2026-01-01T00:01:00.000Z",
      payload: { phase: "retry" },
    });
    await checkpointRepo.create(cp2);

    // 3. Read the run record
    const retrieved = await runRepo.getById(runId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.runId).toBe(runId);
    expect(retrieved?.state).toBe("queued");

    // 4. Verify checkpoints are accessible
    const checkpoints = await checkpointRepo.listByRunId(runId);
    expect(checkpoints).toHaveLength(2);

    const latestCp = await checkpointRepo.getLatest(runId);
    expect(latestCp?.payload["phase"]).toBe("retry");

    // 5. Update the run record
    const updated = {
      ...record,
      state: "running" as const,
      attempt: 1,
      updatedAt: new Date("2026-01-01T00:02:00Z"),
    };
    const result = await runRepo.update(updated, 1);
    expect(result.state).toBe("running");
    expect(result.attempt).toBe(1);

    // 6. Verify the run record was updated
    const afterUpdate = await runRepo.getById(runId);
    expect(afterUpdate?.state).toBe("running");
    expect(afterUpdate?.attempt).toBe(1);

    // 7. Verify checkpoints are still accessible after run update
    const checkpointsAfter = await checkpointRepo.listByRunId(runId);
    expect(checkpointsAfter).toHaveLength(2);
  });

  it("multiple runs have independent checkpoints", async () => {
    const runRepo = new FileRunRepository(runRepoDir);
    const checkpointRepo = new FileCheckpointRepository(checkpointRepoDir);

    const runId1 = "run-alpha" as RunId;
    const runId2 = "run-beta" as RunId;

    // Create two different runs
    await runRepo.create(createRunRecord({ runId: runId1 }));
    await runRepo.create(createRunRecord({ runId: runId2 }));

    // Create checkpoints for each run
    await checkpointRepo.create(
      createCheckpointDto(runId1, {
        state: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { project: "alpha" },
      }),
    );
    await checkpointRepo.create(
      createCheckpointDto(runId2, {
        state: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { project: "beta" },
      }),
    );
    await checkpointRepo.create(
      createCheckpointDto(runId1, {
        state: "succeeded",
        createdAt: "2026-01-01T00:01:00.000Z",
        payload: { project: "alpha", result: "ok" },
      }),
    );

    // Verify independent checkpoint histories
    const alphaCheckpoints = await checkpointRepo.listByRunId(runId1);
    const betaCheckpoints = await checkpointRepo.listByRunId(runId2);

    expect(alphaCheckpoints).toHaveLength(2);
    expect(betaCheckpoints).toHaveLength(1);

    expect(alphaCheckpoints[0].payload["project"]).toBe("alpha");
    expect(alphaCheckpoints[1].payload["project"]).toBe("alpha");
    expect(betaCheckpoints[0].payload["project"]).toBe("beta");

    // Verify latest for each run
    const alphaLatest = await checkpointRepo.getLatest(runId1);
    const betaLatest = await checkpointRepo.getLatest(runId2);

    expect(alphaLatest?.state).toBe("succeeded");
    expect(betaLatest?.state).toBe("running");
  });

  it("run update with optimistic concurrency and checkpoint creation", async () => {
    const runRepo = new FileRunRepository(runRepoDir);
    const checkpointRepo = new FileCheckpointRepository(checkpointRepoDir);

    const runId = "concurrent-run" as RunId;
    const record = createRunRecord({ runId });

    // Create run (revision = 1)
    await runRepo.create(record);

    // Create initial checkpoint
    await checkpointRepo.create(
      createCheckpointDto(runId, {
        state: "running",
        attempt: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { phase: "start" },
      }),
    );

    // Update run with correct revision (revision → 2)
    await runRepo.update({ ...record, state: "running" as const, attempt: 1 }, 1);

    // Create another checkpoint
    await checkpointRepo.create(
      createCheckpointDto(runId, {
        state: "running",
        attempt: 2,
        createdAt: "2026-01-01T00:01:00.000Z",
        payload: { phase: "continue" },
      }),
    );

    // Final update
    await runRepo.update({ ...record, state: "succeeded" as const, attempt: 2 }, 2);

    // Verify final state
    const finalRun = await runRepo.getById(runId);
    expect(finalRun?.state).toBe("succeeded");

    const allCheckpoints = await checkpointRepo.listByRunId(runId);
    expect(allCheckpoints).toHaveLength(2);
    expect(allCheckpoints[0].payload["phase"]).toBe("start");
    expect(allCheckpoints[1].payload["phase"]).toBe("continue");

    const latestCp = await checkpointRepo.getLatest(runId);
    expect(latestCp?.attempt).toBe(2);
  });
});
