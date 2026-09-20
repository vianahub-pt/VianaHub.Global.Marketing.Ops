import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";
import { FileRunRepository } from "./file-run-repo.js";
import { CorruptedRecordError, ConcurrencyConflictError } from "./persistence-errors.js";

// ─── Module mock for lock/unlock testing ──────────────────────────────────────

let mockWriteSyncCapturePid: string | undefined;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      // Capture PID written to lock files
      if (typeof args[1] === "string") {
        mockWriteSyncCapturePid = args[1];
      }
      return actual.writeSync(...args);
    },
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tempDir: string;

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

function writeCorruptedFile(dir: string, fileName: string, content: string): void {
  writeFileSync(join(dir, fileName), content, "utf8");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "file-run-repo-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("FileRunRepository", () => {
  describe("create", () => {
    it("persists a new run record", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      const result = await repo.create(record);

      expect(result).toEqual(record);
    });

    it("creates a JSON file named by runId", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record);

      const files = readdirSync(tempDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toBe(`${record.runId}.json`);
    });

    it("file contains schemaVersion and revision", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record);

      const content = readFileSync(join(tempDir, `${record.runId}.json`), "utf8");
      const parsed = JSON.parse(content);

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.revision).toBe(1);
      expect(parsed.storedAt).toBeDefined();
    });

    it("fails if record with same runId already exists", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record);

      await expect(repo.create(record)).rejects.toThrow(`Record already exists: ${record.runId}`);
    });

    it("handles Date serialization correctly", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord({
        createdAt: new Date("2026-06-15T12:30:45.123Z"),
        updatedAt: new Date("2026-06-15T12:30:45.456Z"),
      });

      await repo.create(record);
      const retrieved = await repo.getById(record.runId);

      expect(retrieved?.createdAt).toBeInstanceOf(Date);
      expect(retrieved?.updatedAt).toBeInstanceOf(Date);
      expect(retrieved?.createdAt?.toISOString()).toBe("2026-06-15T12:30:45.123Z");
      expect(retrieved?.updatedAt?.toISOString()).toBe("2026-06-15T12:30:45.456Z");
    });
  });

  describe("getById", () => {
    it("retrieves an existing record", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record);
      const retrieved = await repo.getById(record.runId);

      expect(retrieved).toEqual(record);
    });

    it("returns null for non-existent runId", async () => {
      const repo = new FileRunRepository(tempDir);

      const result = await repo.getById("non-existent-id" as RunId);

      expect(result).toBeNull();
    });
  });

  describe("update", () => {
    it("updates an existing record", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record);

      const updated = { ...record, state: "running" as const, attempt: 1 };
      const result = await repo.update(updated);

      expect(result.state).toBe("running");
      expect(result.attempt).toBe(1);
    });

    it("increments revision on update", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record);

      const content1 = readFileSync(join(tempDir, `${record.runId}.json`), "utf8");
      const parsed1 = JSON.parse(content1);
      expect(parsed1.revision).toBe(1);

      const updated = { ...record, state: "running" as const };
      await repo.update(updated);

      const content2 = readFileSync(join(tempDir, `${record.runId}.json`), "utf8");
      const parsed2 = JSON.parse(content2);
      expect(parsed2.revision).toBe(2);
    });

    it("fails if record does not exist", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await expect(repo.update(record)).rejects.toThrow(`Record not found: ${record.runId}`);
    });

    it("preserves schemaVersion from original file", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record);

      const updated = { ...record, state: "running" as const };
      await repo.update(updated);

      const content = readFileSync(join(tempDir, `${record.runId}.json`), "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.schemaVersion).toBe(1);
    });
  });

  describe("list", () => {
    it("returns empty array when no records exist", async () => {
      const repo = new FileRunRepository(tempDir);

      const result = await repo.list();

      expect(result).toEqual([]);
    });

    it("returns all records when no filters provided", async () => {
      const repo = new FileRunRepository(tempDir);

      await repo.create(createRunRecord({ runId: "run-1" as RunId }));
      await repo.create(createRunRecord({ runId: "run-2" as RunId }));
      await repo.create(createRunRecord({ runId: "run-3" as RunId }));

      const result = await repo.list();

      expect(result).toHaveLength(3);
    });

    it("filters by brandId", async () => {
      const repo = new FileRunRepository(tempDir);

      await repo.create(createRunRecord({ runId: "run-1" as RunId, brandId: "best-fluency" }));
      await repo.create(createRunRecord({ runId: "run-2" as RunId, brandId: "gerit" }));

      const result = await repo.list({ brandId: "best-fluency" });

      expect(result).toHaveLength(1);
      expect(result[0].brandId).toBe("best-fluency");
    });

    it("filters by market", async () => {
      const repo = new FileRunRepository(tempDir);

      await repo.create(createRunRecord({ runId: "run-1" as RunId, market: "PT" }));
      await repo.create(createRunRecord({ runId: "run-2" as RunId, market: "US" }));

      const result = await repo.list({ market: "PT" });

      expect(result).toHaveLength(1);
      expect(result[0].market).toBe("PT");
    });

    it("filters by state", async () => {
      const repo = new FileRunRepository(tempDir);

      await repo.create(createRunRecord({ runId: "run-1" as RunId, state: "queued" }));
      await repo.create(createRunRecord({ runId: "run-2" as RunId, state: "running" }));
      await repo.create(createRunRecord({ runId: "run-3" as RunId, state: "queued" }));

      const result = await repo.list({ state: "queued" });

      expect(result).toHaveLength(2);
    });

    it("applies multiple filters", async () => {
      const repo = new FileRunRepository(tempDir);

      await repo.create(
        createRunRecord({
          runId: "run-1" as RunId,
          brandId: "best-fluency",
          market: "PT",
          state: "queued",
        }),
      );
      await repo.create(
        createRunRecord({
          runId: "run-2" as RunId,
          brandId: "best-fluency",
          market: "US",
          state: "queued",
        }),
      );
      await repo.create(
        createRunRecord({
          runId: "run-3" as RunId,
          brandId: "best-fluency",
          market: "PT",
          state: "running",
        }),
      );

      const result = await repo.list({ brandId: "best-fluency", market: "PT", state: "queued" });

      expect(result).toHaveLength(1);
      expect(result[0].runId).toBe("run-1");
    });
  });

  describe("findByIdempotencyKey", () => {
    it("finds a record by idempotency key", async () => {
      const repo = new FileRunRepository(tempDir);
      const key = "unique-key-123" as IdempotencyKey;

      await repo.create(createRunRecord({ idempotencyKey: key }));

      const result = await repo.findByIdempotencyKey(key);

      expect(result).not.toBeNull();
      expect(result?.idempotencyKey).toBe(key);
    });

    it("returns null for non-existent key", async () => {
      const repo = new FileRunRepository(tempDir);

      const result = await repo.findByIdempotencyKey("non-existent" as IdempotencyKey);

      expect(result).toBeNull();
    });

    it("finds the correct record among multiple", async () => {
      const repo = new FileRunRepository(tempDir);
      const key1 = "key-1" as IdempotencyKey;
      const key2 = "key-2" as IdempotencyKey;

      await repo.create(createRunRecord({ runId: "run-1" as RunId, idempotencyKey: key1 }));
      await repo.create(createRunRecord({ runId: "run-2" as RunId, idempotencyKey: key2 }));

      const result = await repo.findByIdempotencyKey(key2);

      expect(result?.runId).toBe("run-2");
    });
  });

  describe("atomicity", () => {
    it("creates temporary files during write and cleans up on success", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record);

      // No temp files should remain after successful write
      const files = readdirSync(tempDir);
      const tempFiles = files.filter((f) => f.includes(".tmp."));
      expect(tempFiles).toHaveLength(0);
    });

    it("does not corrupt existing file when create fails on duplicate", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record);

      // Attempt to create duplicate — should fail
      try {
        await repo.create(record);
      } catch {
        // Expected error
      }

      // Original file should still be intact
      const retrieved = await repo.getById(record.runId);
      expect(retrieved).toEqual(record);

      // Only one file should exist
      const files = readdirSync(tempDir);
      expect(files).toHaveLength(1);
    });

    it("does not corrupt existing file when update fails on missing record", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      // Attempt to update non-existent record — should fail
      try {
        await repo.update(record);
      } catch {
        // Expected error
      }

      // No files should exist
      const files = readdirSync(tempDir);
      expect(files).toHaveLength(0);
    });
  });

  describe("configuration", () => {
    it("uses configurable storage directory", async () => {
      const customDir = join(tempDir, "custom-runs");
      const repo = new FileRunRepository(customDir);

      await repo.create(createRunRecord());

      const files = readdirSync(customDir);
      expect(files).toHaveLength(1);
    });

    it("creates storage directory if it does not exist", () => {
      const newDir = join(tempDir, "new-dir", "nested");
      const _repo = new FileRunRepository(newDir);

      // Directory should be created by constructor
      const files = readdirSync(newDir);
      expect(files).toEqual([]);
    });

    it("reads FILERUN_STORAGE_DIR environment variable", async () => {
      const envDir = join(tempDir, "env-dir");
      process.env["FILERUN_STORAGE_DIR"] = envDir;

      try {
        const repo = new FileRunRepository();
        await repo.create(createRunRecord());

        const files = readdirSync(envDir);
        expect(files).toHaveLength(1);
      } finally {
        delete process.env["FILERUN_STORAGE_DIR"];
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Cycle 2 — Corruption Detection (T-03)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("corruption detection (T-03)", () => {
    it("getById throws CorruptedRecordError when file has invalid JSON", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record);

      // Overwrite the file with invalid JSON
      writeCorruptedFile(tempDir, `${record.runId}.json`, "NOT VALID JSON {{{");

      await expect(repo.getById(record.runId)).rejects.toThrow(CorruptedRecordError);
    });

    it("getById throws CorruptedRecordError when file has valid JSON but wrong schema", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record);

      // Overwrite with valid JSON but wrong structure
      writeCorruptedFile(tempDir, `${record.runId}.json`, JSON.stringify({ notARecord: true }));

      await expect(repo.getById(record.runId)).rejects.toThrow(CorruptedRecordError);
    });

    it("list throws CorruptedRecordError when a file is corrupted", async () => {
      const repo = new FileRunRepository(tempDir);

      await repo.create(createRunRecord({ runId: "run-valid" as RunId }));

      // Create a corrupted file alongside valid records
      writeCorruptedFile(tempDir, "corrupted-run.json", "NOT VALID JSON");

      await expect(repo.list()).rejects.toThrow(CorruptedRecordError);
    });

    it("findByIdempotencyKey throws CorruptedRecordError when a file is corrupted", async () => {
      const repo = new FileRunRepository(tempDir);

      await repo.create(createRunRecord({ runId: "run-valid" as RunId }));

      // Create a corrupted file alongside valid records
      writeCorruptedFile(tempDir, "corrupted-run.json", "{bad json");

      await expect(repo.findByIdempotencyKey("a".repeat(64) as IdempotencyKey)).rejects.toThrow(
        CorruptedRecordError,
      );
    });

    it("getById throws CorruptedRecordError when file has missing required fields", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record);

      // Overwrite with JSON that is missing required fields
      writeCorruptedFile(
        tempDir,
        `${record.runId}.json`,
        JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          storedAt: "2026-01-01T00:00:00Z",
          record: { runId: record.runId }, // Missing most required fields
        }),
      );

      await expect(repo.getById(record.runId)).rejects.toThrow(CorruptedRecordError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Cycle 2 — Optimistic Concurrency (FR-06, FR-11)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("optimistic concurrency (FR-06, FR-11)", () => {
    it("update succeeds when expectedRevision matches current revision", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record); // revision = 1

      const updated = { ...record, state: "running" as const };
      const result = await repo.update(updated, 1); // expectedRevision = 1

      expect(result.state).toBe("running");

      // Verify revision was incremented
      const content = readFileSync(join(tempDir, `${record.runId}.json`), "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.revision).toBe(2);
    });

    it("update throws ConcurrencyConflictError when expectedRevision is stale (FR-11)", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record); // revision = 1

      // First update succeeds (revision becomes 2)
      const update1 = { ...record, state: "running" as const };
      await repo.update(update1, 1);

      // Second update with stale expectedRevision (1 instead of 2) should fail
      const update2 = { ...record, state: "running" as const, attempt: 2 };
      await expect(repo.update(update2, 1)).rejects.toThrow(ConcurrencyConflictError);
    });

    it("ConcurrencyConflictError contains correct revision info", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record); // revision = 1

      // First update succeeds (revision becomes 2)
      await repo.update({ ...record, state: "running" as const }, 1);

      // Second update with stale expectedRevision
      try {
        await repo.update({ ...record, state: "running" as const, attempt: 2 }, 1);
        expect.fail("Should have thrown ConcurrencyConflictError");
      } catch (error) {
        expect(error).toBeInstanceOf(ConcurrencyConflictError);
        const conflict = error as ConcurrencyConflictError;
        expect(conflict.expectedRevision).toBe(1);
        expect(conflict.actualRevision).toBe(2);
        expect(conflict.recordId).toBe(record.runId);
      }
    });

    it("update succeeds when expectedRevision is not provided (backward compatible)", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record); // revision = 1

      // Update without expectedRevision — should succeed
      const updated = { ...record, state: "running" as const };
      const result = await repo.update(updated);

      expect(result.state).toBe("running");

      // Verify revision was incremented
      const content = readFileSync(join(tempDir, `${record.runId}.json`), "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.revision).toBe(2);
    });

    it("multiple sequential updates each increment revision", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record); // revision = 1

      // Sequential updates
      await repo.update({ ...record, state: "running" as const }, 1); // revision → 2
      await repo.update({ ...record, state: "running" as const, attempt: 1 }, 2); // revision → 3
      await repo.update({ ...record, state: "succeeded" as const, attempt: 2 }, 3); // revision → 4

      const content = readFileSync(join(tempDir, `${record.runId}.json`), "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.revision).toBe(4);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // HUMAN-007 — Atomic concurrency lock (compare-and-write)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("atomic concurrency lock (HUMAN-007)", () => {
    it("concurrent updates with Promise.all: exactly one wins, one gets ConcurrencyConflictError", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record); // revision = 1

      // Two concurrent updates both expecting revision 1
      const updateA = { ...record, state: "running" as const, attempt: 1 };
      const updateB = { ...record, state: "running" as const, attempt: 2 };

      const results = await Promise.allSettled([repo.update(updateA, 1), repo.update(updateB, 1)]);

      // Exactly one should fulfill, one should reject
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The rejected one must be ConcurrencyConflictError
      const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectedReason).toBeInstanceOf(ConcurrencyConflictError);

      // Final revision must be exactly 2 (only one update applied)
      const content = readFileSync(join(tempDir, `${record.runId}.json`), "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.revision).toBe(2);
    });

    it("no lost update: winning record data is fully preserved", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record); // revision = 1

      // Writer A wants state=running, attempt=1
      // Writer B wants state=running, attempt=2
      const updateA = { ...record, state: "running" as const, attempt: 1 };
      const updateB = { ...record, state: "running" as const, attempt: 2 };

      const results = await Promise.allSettled([repo.update(updateA, 1), repo.update(updateB, 1)]);

      // Determine which writer won
      const winningResult = results.find((r) => r.status === "fulfilled") as
        PromiseFulfilledResult<RunRecord> | undefined;
      expect(winningResult).toBeDefined();

      // Verify the on-disk record matches the winning writer's data
      const finalRecord = await repo.getById(record.runId);
      expect(finalRecord).not.toBeNull();
      expect(finalRecord!.state).toBe("running");
      expect(finalRecord!.attempt).toBe(winningResult!.value.attempt);
    });

    it("revision counter is consistent after concurrent updates", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record); // revision = 1

      // Launch 3 concurrent updates, all expecting revision 1
      const updates = [
        { ...record, state: "running" as const, attempt: 1 },
        { ...record, state: "running" as const, attempt: 2 },
        { ...record, state: "running" as const, attempt: 3 },
      ];

      const results = await Promise.allSettled(updates.map((u) => repo.update(u, 1)));

      // Exactly one should succeed
      const succeeded = results.filter((r) => r.status === "fulfilled");
      expect(succeeded).toHaveLength(1);

      // Exactly two should fail with ConcurrencyConflictError
      const failed = results.filter((r) => r.status === "rejected");
      expect(failed).toHaveLength(2);
      for (const f of failed) {
        expect((f as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrencyConflictError);
      }

      // Final revision must be exactly 2
      const content = readFileSync(join(tempDir, `${record.runId}.json`), "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.revision).toBe(2);
    });

    it("sequential concurrent-style updates proceed correctly after lock release", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record); // revision = 1

      // First batch: two concurrent updates
      const batch1Results = await Promise.allSettled([
        repo.update({ ...record, state: "running" as const }, 1),
        repo.update({ ...record, state: "running" as const }, 1),
      ]);

      const batch1Success = batch1Results.filter((r) => r.status === "fulfilled");
      expect(batch1Success).toHaveLength(1);

      // Second batch: one update with correct revision
      const batch2Result = await repo.update(
        { ...record, state: "succeeded" as const, attempt: 1 },
        2,
      );
      expect(batch2Result.state).toBe("succeeded");

      // Final revision must be 3
      const content = readFileSync(join(tempDir, `${record.runId}.json`), "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.revision).toBe(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // HUMAN-010 — File locking cross-platform safe (O_EXCL)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("file locking cross-platform safe (HUMAN-010)", () => {
    it("O_EXCL behavior: second lock acquisition on same runId fails with EEXIST", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      await repo.create(record);

      // The repo uses file locking internally. To test O_EXCL directly,
      // we create a lock file manually and verify openSync with "wx" fails.
      const lockFile = join(tempDir, `${record.runId}.lock`);

      // First lock creation should succeed
      const fd1 = openSync(lockFile, "wx");
      closeSync(fd1);

      // Second lock creation should fail with EEXIST
      expect(() => {
        const fd2 = openSync(lockFile, "wx");
        closeSync(fd2);
      }).toThrow(/EEXIST/);

      // Cleanup
      unlinkSync(lockFile);
    });

    it("lock cleanup: no .lock files remain after repository operations", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      // Perform multiple operations
      await repo.create(record);
      const updated = { ...record, state: "running" as const };
      await repo.update(updated);
      await repo.getById(record.runId);
      await repo.list();

      // No .lock files should remain
      const files = readdirSync(tempDir);
      const lockFiles = files.filter((f) => f.endsWith(".lock"));
      expect(lockFiles).toHaveLength(0);
    });

    it("lock acquisition after release: lock can be re-acquired after release", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      // Create and update — both operations acquire and release locks
      await repo.create(record);

      const updated1 = { ...record, state: "running" as const };
      await repo.update(updated1);

      const updated2 = { ...record, state: "succeeded" as const, attempt: 1 };
      await repo.update(updated2);

      // Verify final state — lock was successfully acquired for each update
      const result = await repo.getById(record.runId);
      expect(result).not.toBeNull();
      expect(result!.state).toBe("succeeded");
      expect(result!.attempt).toBe(1);

      // Verify revision was incremented correctly
      const content = readFileSync(join(tempDir, `${record.runId}.json`), "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.revision).toBe(3);

      // No .lock files should remain
      const files = readdirSync(tempDir);
      const lockFiles = files.filter((f) => f.endsWith(".lock"));
      expect(lockFiles).toHaveLength(0);
    });

    it("acquireFileLock writes current process PID to lock file", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      // Reset capture variable
      mockWriteSyncCapturePid = undefined;

      // create() calls acquireFileLock internally, which writes the PID
      // via writeSync(fd, ...). Our vi.mock intercepts writeSync and
      // captures the string argument.
      await repo.create(record);

      // The captured value should be the current process PID
      expect(mockWriteSyncCapturePid).toBe(String(process.pid));
    });

    it("concurrent canonical lock is never deleted or renamed by acquisition", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      // Create a canonical lock file manually via O_EXCL
      const lockFile = join(tempDir, `${record.runId}.lock`);
      const fd = openSync(lockFile, "wx");
      closeSync(fd);

      // Verify lock file exists before the attempt
      expect(readdirSync(tempDir).filter((f) => f.endsWith(".lock"))).toHaveLength(1);

      // Attempt to create a record — acquisition must fail after retries
      // because the lock is held. This is a fail-closed design: the lock
      // is never deleted, renamed, or replaced.
      try {
        await repo.create(record);
        expect.fail("Should have thrown Failed to acquire file lock");
      } catch (error) {
        expect((error as Error).message).toContain("Failed to acquire file lock");
      }

      // The lock file must still exist — fail-closed means no automatic removal
      expect(readdirSync(tempDir).filter((f) => f.endsWith(".lock"))).toHaveLength(1);

      // Manual cleanup
      unlinkSync(lockFile);
    }, 60_000);

    it("exhausted retries fail with actionable error", async () => {
      const repo = new FileRunRepository(tempDir);
      const record = createRunRecord();

      // Create a canonical lock file manually via O_EXCL
      const lockFile = join(tempDir, `${record.runId}.lock`);
      const fd = openSync(lockFile, "wx");
      closeSync(fd);

      // Attempt to create a record — must fail with actionable error
      // containing the runId so the operator can identify which lock to clear.
      try {
        await repo.create(record);
        expect.fail("Should have thrown Failed to acquire file lock");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Failed to acquire file lock");
        expect(message).toContain(record.runId);
      }

      // The lock file must still exist — no stale cleanup in fail-closed design
      expect(readdirSync(tempDir).filter((f) => f.endsWith(".lock"))).toHaveLength(1);

      // Manual cleanup
      unlinkSync(lockFile);
    }, 60_000);
  });
});
