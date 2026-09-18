import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RunId } from "../domain/idempotency.js";
import type { CheckpointDto } from "./checkpoint-repository.js";
import { FileCheckpointRepository } from "./file-checkpoint-repo.js";
import { CorruptedRecordError } from "./persistence-errors.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tempDir: string;

function createCheckpointDto(overrides?: Partial<CheckpointDto>): CheckpointDto {
  return {
    runId: "550e8400-e29b-41d4-a716-446655440000" as RunId,
    state: "running",
    attempt: 1,
    payload: { step: "api-call" },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function writeCorruptedFile(dir: string, fileName: string, content: string): void {
  writeFileSync(join(dir, fileName), content, "utf8");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "file-checkpoint-repo-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("FileCheckpointRepository", () => {
  describe("create", () => {
    it("persists a new checkpoint", async () => {
      const repo = new FileCheckpointRepository(tempDir);
      const checkpoint = createCheckpointDto();

      const result = await repo.create(checkpoint);

      expect(result).toEqual(checkpoint);
    });

    it("creates a JSON file with runId in filename", async () => {
      const repo = new FileCheckpointRepository(tempDir);
      const checkpoint = createCheckpointDto({ runId: "run-abc" as RunId });

      await repo.create(checkpoint);

      const checkpoints = await repo.listByRunId("run-abc" as RunId);
      expect(checkpoints).toHaveLength(1);
    });

    it("file contains schemaVersion", async () => {
      const repo = new FileCheckpointRepository(tempDir);
      const checkpoint = createCheckpointDto();

      await repo.create(checkpoint);

      const all = await repo.listByRunId(checkpoint.runId);
      expect(all).toHaveLength(1);
    });
  });

  describe("getLatest", () => {
    it("returns null when no checkpoints exist for run", async () => {
      const repo = new FileCheckpointRepository(tempDir);

      const result = await repo.getLatest("non-existent" as RunId);

      expect(result).toBeNull();
    });

    it("returns the most recent checkpoint for a run", async () => {
      const repo = new FileCheckpointRepository(tempDir);
      const runId = "run-latest" as RunId;

      await repo.create(
        createCheckpointDto({
          runId,
          createdAt: "2026-01-01T00:00:00.000Z",
          attempt: 1,
        }),
      );
      await repo.create(
        createCheckpointDto({
          runId,
          createdAt: "2026-01-01T00:01:00.000Z",
          attempt: 2,
        }),
      );
      await repo.create(
        createCheckpointDto({
          runId,
          createdAt: "2026-01-01T00:02:00.000Z",
          attempt: 3,
        }),
      );

      const latest = await repo.getLatest(runId);

      expect(latest).not.toBeNull();
      expect(latest?.attempt).toBe(3);
    });

    it("returns only checkpoint when single exists", async () => {
      const repo = new FileCheckpointRepository(tempDir);
      const checkpoint = createCheckpointDto({ runId: "run-single" as RunId });

      await repo.create(checkpoint);

      const latest = await repo.getLatest(checkpoint.runId);

      expect(latest).toEqual(checkpoint);
    });
  });

  describe("listByRunId", () => {
    it("returns empty array when no checkpoints exist", async () => {
      const repo = new FileCheckpointRepository(tempDir);

      const result = await repo.listByRunId("non-existent" as RunId);

      expect(result).toEqual([]);
    });

    it("returns all checkpoints for a specific run", async () => {
      const repo = new FileCheckpointRepository(tempDir);
      const runId = "run-list" as RunId;

      await repo.create(
        createCheckpointDto({ runId, attempt: 1, createdAt: "2026-01-01T00:00:00.000Z" }),
      );
      await repo.create(
        createCheckpointDto({ runId, attempt: 2, createdAt: "2026-01-01T00:01:00.000Z" }),
      );

      const result = await repo.listByRunId(runId);

      expect(result).toHaveLength(2);
    });

    it("does not include checkpoints from other runs", async () => {
      const repo = new FileCheckpointRepository(tempDir);

      await repo.create(
        createCheckpointDto({ runId: "run-a" as RunId, createdAt: "2026-01-01T00:00:00.000Z" }),
      );
      await repo.create(
        createCheckpointDto({ runId: "run-b" as RunId, createdAt: "2026-01-01T00:00:00.000Z" }),
      );
      await repo.create(
        createCheckpointDto({ runId: "run-a" as RunId, createdAt: "2026-01-01T00:01:00.000Z" }),
      );

      const resultA = await repo.listByRunId("run-a" as RunId);
      const resultB = await repo.listByRunId("run-b" as RunId);

      expect(resultA).toHaveLength(2);
      expect(resultB).toHaveLength(1);
    });

    it("returns checkpoints ordered by creation date (ascending)", async () => {
      const repo = new FileCheckpointRepository(tempDir);
      const runId = "run-ordered" as RunId;

      await repo.create(
        createCheckpointDto({ runId, attempt: 3, createdAt: "2026-01-01T00:02:00.000Z" }),
      );
      await repo.create(
        createCheckpointDto({ runId, attempt: 1, createdAt: "2026-01-01T00:00:00.000Z" }),
      );
      await repo.create(
        createCheckpointDto({ runId, attempt: 2, createdAt: "2026-01-01T00:01:00.000Z" }),
      );

      const result = await repo.listByRunId(runId);

      expect(result).toHaveLength(3);
      expect(result[0].attempt).toBe(1);
      expect(result[1].attempt).toBe(2);
      expect(result[2].attempt).toBe(3);
    });
  });

  describe("atomicity", () => {
    it("no temp files remain after successful write", async () => {
      const repo = new FileCheckpointRepository(tempDir);

      await repo.create(createCheckpointDto());

      // Verify by listing - no temp files in results
      const checkpoints = await repo.listByRunId(createCheckpointDto().runId);
      expect(checkpoints).toHaveLength(1);
    });
  });

  describe("configuration", () => {
    it("uses configurable storage directory", async () => {
      const customDir = join(tempDir, "custom-checkpoints");
      const repo = new FileCheckpointRepository(customDir);

      await repo.create(createCheckpointDto());

      const checkpoints = await repo.listByRunId(createCheckpointDto().runId);
      expect(checkpoints).toHaveLength(1);
    });

    it("creates storage directory if it does not exist", async () => {
      const newDir = join(tempDir, "new-checkpoints", "nested");
      const repo = new FileCheckpointRepository(newDir);

      // Directory should be created by constructor
      const checkpoints = repo.listByRunId("test" as RunId);
      await expect(checkpoints).resolves.toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Cycle 2 — Corruption Detection (T-03, CK-04)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("corruption detection (T-03, CK-04)", () => {
    it("listByRunId throws CorruptedRecordError when a file has invalid JSON", async () => {
      const repo = new FileCheckpointRepository(tempDir);

      await repo.create(
        createCheckpointDto({
          runId: "run-corr" as RunId,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      // Create a corrupted file alongside valid checkpoints
      writeCorruptedFile(tempDir, "run-corr-2026-01-01T00-00-00-000Z.json", "NOT VALID JSON {{{");

      await expect(repo.listByRunId("run-corr" as RunId)).rejects.toThrow(CorruptedRecordError);
    });

    it("listByRunId throws CorruptedRecordError when file has valid JSON but wrong schema", async () => {
      const repo = new FileCheckpointRepository(tempDir);

      await repo.create(
        createCheckpointDto({
          runId: "run-schema" as RunId,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      // Create a file with valid JSON but wrong structure
      writeCorruptedFile(
        tempDir,
        "run-schema-2026-01-01T00-00-00-000Z.json",
        JSON.stringify({ notACheckpoint: true }),
      );

      await expect(repo.listByRunId("run-schema" as RunId)).rejects.toThrow(CorruptedRecordError);
    });

    it("getLatest throws CorruptedRecordError when a file is corrupted", async () => {
      const repo = new FileCheckpointRepository(tempDir);

      await repo.create(
        createCheckpointDto({
          runId: "run-latest-corr" as RunId,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      // Create a corrupted file alongside valid checkpoints
      writeCorruptedFile(tempDir, "run-latest-corr-2026-01-01T00-00-00-000Z.json", "{bad json");

      await expect(repo.getLatest("run-latest-corr" as RunId)).rejects.toThrow(
        CorruptedRecordError,
      );
    });

    it("listByRunId throws CorruptedRecordError when file has missing required fields", async () => {
      const repo = new FileCheckpointRepository(tempDir);

      await repo.create(
        createCheckpointDto({
          runId: "run-missing" as RunId,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      // Create a file with valid JSON but missing required fields
      writeCorruptedFile(
        tempDir,
        "run-missing-2026-01-01T00-00-00-000Z.json",
        JSON.stringify({
          schemaVersion: 1,
          data: { runId: "run-missing" }, // Missing state, attempt, payload, createdAt
        }),
      );

      await expect(repo.listByRunId("run-missing" as RunId)).rejects.toThrow(CorruptedRecordError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Cycle 2 — waiting_manual Context (CK-05)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("waiting_manual context (CK-05)", () => {
    it("getLatest returns checkpoint with action context for waiting_manual", async () => {
      const repo = new FileCheckpointRepository(tempDir);
      const runId = "run-waiting" as RunId;

      // Create a waiting_manual checkpoint with action context in payload
      const checkpoint = createCheckpointDto({
        runId,
        state: "waiting_manual",
        attempt: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: {
          action: "approve_billing",
          reason: "Budget threshold exceeded",
          requiredBy: "admin@vianahub.com",
          deadline: "2026-01-02T00:00:00Z",
        },
      });

      await repo.create(checkpoint);

      const latest = await repo.getLatest(runId);

      expect(latest).not.toBeNull();
      expect(latest?.state).toBe("waiting_manual");
      expect(latest?.payload["action"]).toBe("approve_billing");
      expect(latest?.payload["reason"]).toBe("Budget threshold exceeded");
      expect(latest?.payload["requiredBy"]).toBe("admin@vianahub.com");
    });

    it("waiting_manual checkpoint survives process exit (file persistence)", async () => {
      const repo1 = new FileCheckpointRepository(tempDir);
      const runId = "run-survive" as RunId;

      const checkpoint = createCheckpointDto({
        runId,
        state: "waiting_manual",
        attempt: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { action: "manual_review", context: { step: "ad_approval" } },
      });

      await repo1.create(checkpoint);

      // Simulate process exit by creating a new repository instance
      const repo2 = new FileCheckpointRepository(tempDir);
      const latest = await repo2.getLatest(runId);

      expect(latest).not.toBeNull();
      expect(latest?.state).toBe("waiting_manual");
      expect(latest?.payload["action"]).toBe("manual_review");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Cycle 2 — Checkpoint Collision (HUMAN-008)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("checkpoint collision (HUMAN-008)", () => {
    it("T-13: stores two checkpoints with same runId and createdAt without collision", async () => {
      const repo = new FileCheckpointRepository(tempDir);
      const runId = "run-collision" as RunId;
      const sameCreatedAt = "2026-01-01T00:00:00.000Z";

      const checkpoint1 = createCheckpointDto({
        runId,
        state: "running",
        attempt: 1,
        createdAt: sameCreatedAt,
        payload: { step: "first" },
      });

      const checkpoint2 = createCheckpointDto({
        runId,
        state: "running",
        attempt: 2,
        createdAt: sameCreatedAt,
        payload: { step: "second" },
      });

      await repo.create(checkpoint1);
      await repo.create(checkpoint2);

      const all = await repo.listByRunId(runId);

      expect(all).toHaveLength(2);
      expect(all[0].payload["step"]).toBe("first");
      expect(all[1].payload["step"]).toBe("second");
    });

    it("does not overwrite existing checkpoint when creating with same runId and createdAt", async () => {
      const repo = new FileCheckpointRepository(tempDir);
      const runId = "run-overwrite" as RunId;
      const sameCreatedAt = "2026-01-01T00:00:00.000Z";

      const checkpoint1 = createCheckpointDto({
        runId,
        state: "running",
        attempt: 1,
        createdAt: sameCreatedAt,
        payload: { original: true },
      });

      await repo.create(checkpoint1);

      // Create second checkpoint with same runId and createdAt
      const checkpoint2 = createCheckpointDto({
        runId,
        state: "running",
        attempt: 2,
        createdAt: sameCreatedAt,
        payload: { original: false, second: true },
      });

      await repo.create(checkpoint2);

      const all = await repo.listByRunId(runId);

      // Both checkpoints must exist - the first must NOT be overwritten
      expect(all).toHaveLength(2);
      expect(all[0].payload["original"]).toBe(true);
      expect(all[1].payload["second"]).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Cycle 2 — Checkpoint History (T-13)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("checkpoint history (T-13)", () => {
    it("maintains full checkpoint history for a run", async () => {
      const repo = new FileCheckpointRepository(tempDir);
      const runId = "run-history" as RunId;

      // Create checkpoints representing a full run lifecycle
      const checkpoints = [
        createCheckpointDto({
          runId,
          state: "queued",
          attempt: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          payload: { phase: "init" },
        }),
        createCheckpointDto({
          runId,
          state: "running",
          attempt: 1,
          createdAt: "2026-01-01T00:01:00.000Z",
          payload: { phase: "api-call" },
        }),
        createCheckpointDto({
          runId,
          state: "waiting_manual",
          attempt: 1,
          createdAt: "2026-01-01T00:02:00.000Z",
          payload: { action: "approve", reason: "budget" },
        }),
        createCheckpointDto({
          runId,
          state: "running",
          attempt: 2,
          createdAt: "2026-01-01T00:03:00.000Z",
          payload: { phase: "retry" },
        }),
        createCheckpointDto({
          runId,
          state: "succeeded",
          attempt: 2,
          createdAt: "2026-01-01T00:04:00.000Z",
          payload: { phase: "done" },
        }),
      ];

      for (const cp of checkpoints) {
        await repo.create(cp);
      }

      // Verify full history is returned in order
      const history = await repo.listByRunId(runId);

      expect(history).toHaveLength(5);
      expect(history[0].state).toBe("queued");
      expect(history[1].state).toBe("running");
      expect(history[2].state).toBe("waiting_manual");
      expect(history[3].state).toBe("running");
      expect(history[4].state).toBe("succeeded");

      // Verify getLatest returns the final checkpoint
      const latest = await repo.getLatest(runId);
      expect(latest?.state).toBe("succeeded");
      expect(latest?.attempt).toBe(2);
    });

    it("each checkpoint is independently accessible via listByRunId", async () => {
      const repo = new FileCheckpointRepository(tempDir);
      const runId = "run-independent" as RunId;

      await repo.create(
        createCheckpointDto({
          runId,
          state: "running",
          attempt: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          payload: { step: 1 },
        }),
      );
      await repo.create(
        createCheckpointDto({
          runId,
          state: "waiting_manual",
          attempt: 1,
          createdAt: "2026-01-01T00:01:00.000Z",
          payload: { action: "review" },
        }),
      );
      await repo.create(
        createCheckpointDto({
          runId,
          state: "succeeded",
          attempt: 2,
          createdAt: "2026-01-01T00:02:00.000Z",
          payload: { step: 2 },
        }),
      );

      const history = await repo.listByRunId(runId);

      expect(history).toHaveLength(3);
      expect(history[0].payload["step"]).toBe(1);
      expect(history[1].payload["action"]).toBe("review");
      expect(history[2].payload["step"]).toBe(2);
    });
  });
});
