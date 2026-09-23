import { describe, expect, it, beforeEach, afterEach } from "vitest";
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

import type { ScheduleId, ScheduleRecord, ScheduleConfig } from "../domain/schedule-schema.js";
import { createScheduleRecord } from "../domain/schedule-schema.js";
import { FileScheduleRepository } from "./file-schedule-repo.js";
import { CorruptedRecordError, ConcurrencyConflictError } from "./persistence-errors.js";
import { OperationalError, ERROR_CODES } from "../domain/errors.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tempDir: string;

const validConfig: ScheduleConfig = {
  cron: "*/15 * * * *",
  timezone: "Europe/Lisbon",
  brandId: "best-fluency",
  market: "PT",
  platform: "google-business-profile",
  operation: "createLocalPost",
  enabled: true,
  mode: "single",
};

function createRecord(overrides?: Partial<ScheduleRecord>): ScheduleRecord {
  const base = createScheduleRecord(validConfig);
  return { ...base, ...overrides };
}

function writeCorruptedFile(dir: string, fileName: string, content: string): void {
  writeFileSync(join(dir, fileName), content, "utf8");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "file-schedule-repo-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("FileScheduleRepository", () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // AC-07 — Scenario 1: create() persists file
  // ═══════════════════════════════════════════════════════════════════════════

  describe("create", () => {
    it("persists a schedule record as a JSON file", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord();

      const result = await repo.create(record);

      expect(result).toEqual(record);

      const files = readdirSync(tempDir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      expect(files[0]).toBe(`${record.scheduleId}.json`);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // AC-07 — Scenario 2: create() duplicate → throws "Record already exists"
    // ═══════════════════════════════════════════════════════════════════════════

    it("throws when schedule with same scheduleId already exists", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord();

      await repo.create(record);

      await expect(repo.create(record)).rejects.toThrow(
        `Record already exists: ${record.scheduleId}`,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-07 — Scenario 3: getById() existing → returns correct ScheduleRecord
  // ═══════════════════════════════════════════════════════════════════════════

  describe("getById", () => {
    it("retrieves an existing schedule record by scheduleId", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord();

      await repo.create(record);
      const retrieved = await repo.getById(record.scheduleId as ScheduleId);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.scheduleId).toBe(record.scheduleId);
      expect(retrieved!.idempotencyKey).toBe(record.idempotencyKey);
      expect(retrieved!.config).toEqual(record.config);
      expect(retrieved!.enabled).toBe(record.enabled);
      expect(retrieved!.revision).toBe(record.revision);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // AC-07 — Scenario 4: getById() non-existent → returns null
    // ═══════════════════════════════════════════════════════════════════════════

    it("returns null for non-existent scheduleId", async () => {
      const repo = new FileScheduleRepository(tempDir);

      const result = await repo.getById("non-existent-id" as ScheduleId);

      expect(result).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-07 — Scenario 5: update() with correct revision → file updated,
  //                       revision incremented
  // ═══════════════════════════════════════════════════════════════════════════

  describe("update", () => {
    it("updates file and increments revision when revision matches", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord(); // revision = 0

      await repo.create(record);

      const updated = { ...record, enabled: false };
      const result = await repo.update(updated);

      expect(result.enabled).toBe(false);
      expect(result.revision).toBe(1); // incremented

      // Verify on disk
      const content = readFileSync(join(tempDir, `${record.scheduleId}.json`), "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.revision).toBe(1);
      expect(parsed.enabled).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // AC-07 — Scenario 6: update() with incorrect revision →
    //                       ConcurrencyConflictError
    // ═══════════════════════════════════════════════════════════════════════════

    it("throws ConcurrencyConflictError when revision does not match", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord(); // revision = 0

      await repo.create(record);

      // Simulate a concurrent update that bumped revision
      await repo.update({ ...record, enabled: false }); // revision → 1

      // Now try to update with stale revision (0 instead of 1)
      const staleUpdate = { ...record, enabled: true };
      await expect(repo.update(staleUpdate)).rejects.toThrow(ConcurrencyConflictError);
    });

    it("ConcurrencyConflictError contains correct revision info", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord(); // revision = 0

      await repo.create(record);
      await repo.update({ ...record, enabled: false }); // revision → 1

      try {
        await repo.update({ ...record, enabled: true }); // stale revision 0
        expect.fail("Should have thrown ConcurrencyConflictError");
      } catch (error) {
        expect(error).toBeInstanceOf(ConcurrencyConflictError);
        const conflict = error as ConcurrencyConflictError;
        expect(conflict.expectedRevision).toBe(0);
        expect(conflict.actualRevision).toBe(1);
        expect(conflict.recordId).toBe(record.scheduleId);
      }
    });

    it("throws when record does not exist", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord();

      await expect(repo.update(record)).rejects.toThrow(`Record not found: ${record.scheduleId}`);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-07 — Scenario 7: list() without filters → returns all records
  // ═══════════════════════════════════════════════════════════════════════════

  describe("list", () => {
    it("returns all records when no filters provided", async () => {
      const repo = new FileScheduleRepository(tempDir);

      await repo.create(createRecord());
      await repo.create(createRecord());
      await repo.create(createRecord());

      const result = await repo.list();

      expect(result).toHaveLength(3);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // AC-07 — Scenario 8: list({ enabled: true }) → filters correctly
    // ═══════════════════════════════════════════════════════════════════════════

    it("filters by enabled", async () => {
      const repo = new FileScheduleRepository(tempDir);

      await repo.create(createRecord({ enabled: true }));
      await repo.create(createRecord({ enabled: false }));
      await repo.create(createRecord({ enabled: true }));

      const result = await repo.list({ enabled: true });

      expect(result).toHaveLength(2);
      for (const r of result) {
        expect(r.enabled).toBe(true);
      }
    });

    it("filters by brandId", async () => {
      const repo = new FileScheduleRepository(tempDir);

      const configA: ScheduleConfig = { ...validConfig, brandId: "best-fluency" };
      const configB: ScheduleConfig = { ...validConfig, brandId: "gerit" };

      await repo.create(createScheduleRecord(configA));
      await repo.create(createScheduleRecord(configB));

      const result = await repo.list({ brandId: "best-fluency" });

      expect(result).toHaveLength(1);
      expect(result[0].config.brandId).toBe("best-fluency");
    });

    it("filters by market", async () => {
      const repo = new FileScheduleRepository(tempDir);

      const configA: ScheduleConfig = { ...validConfig, market: "PT" };
      const configB: ScheduleConfig = { ...validConfig, market: "US" };

      await repo.create(createScheduleRecord(configA));
      await repo.create(createScheduleRecord(configB));

      const result = await repo.list({ market: "PT" });

      expect(result).toHaveLength(1);
      expect(result[0].config.market).toBe("PT");
    });

    it("filters by platform", async () => {
      const repo = new FileScheduleRepository(tempDir);

      const configA: ScheduleConfig = { ...validConfig, platform: "instagram" };
      const configB: ScheduleConfig = { ...validConfig, platform: "facebook" };

      await repo.create(createScheduleRecord(configA));
      await repo.create(createScheduleRecord(configB));

      const result = await repo.list({ platform: "instagram" });

      expect(result).toHaveLength(1);
      expect(result[0].config.platform).toBe("instagram");
    });

    it("applies multiple filters", async () => {
      const repo = new FileScheduleRepository(tempDir);

      await repo.create(
        createScheduleRecord({
          ...validConfig,
          brandId: "best-fluency",
          market: "PT",
          enabled: true,
        }),
      );
      await repo.create(
        createScheduleRecord({
          ...validConfig,
          brandId: "best-fluency",
          market: "US",
          enabled: true,
        }),
      );
      await repo.create(
        createScheduleRecord({
          ...validConfig,
          brandId: "best-fluency",
          market: "PT",
          enabled: false,
        }),
      );

      const result = await repo.list({ brandId: "best-fluency", market: "PT", enabled: true });

      expect(result).toHaveLength(1);
      expect(result[0].config.brandId).toBe("best-fluency");
      expect(result[0].config.market).toBe("PT");
      expect(result[0].enabled).toBe(true);
    });

    it("returns empty array when no records exist", async () => {
      const repo = new FileScheduleRepository(tempDir);

      const result = await repo.list();

      expect(result).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-07 — Scenario 9: findByIdempotencyKey() → finds record by key
  // ═══════════════════════════════════════════════════════════════════════════

  describe("findByIdempotencyKey", () => {
    it("finds a record by its idempotency key", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord();

      await repo.create(record);

      const result = await repo.findByIdempotencyKey(record.idempotencyKey);

      expect(result).not.toBeNull();
      expect(result!.scheduleId).toBe(record.scheduleId);
      expect(result!.idempotencyKey).toBe(record.idempotencyKey);
    });

    it("returns null for non-existent key", async () => {
      const repo = new FileScheduleRepository(tempDir);

      const result = await repo.findByIdempotencyKey("schedule:nonexistent");

      expect(result).toBeNull();
    });

    it("finds correct record among multiple", async () => {
      const repo = new FileScheduleRepository(tempDir);

      const configA: ScheduleConfig = { ...validConfig, operation: "createLocalPost" };
      const configB: ScheduleConfig = { ...validConfig, operation: "deleteLocalPost" };

      const recordA = createScheduleRecord(configA);
      const recordB = createScheduleRecord(configB);

      await repo.create(recordA);
      await repo.create(recordB);

      const result = await repo.findByIdempotencyKey(recordB.idempotencyKey);

      expect(result).not.toBeNull();
      expect(result!.scheduleId).toBe(recordB.scheduleId);
      expect(result!.config.operation).toBe("deleteLocalPost");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-07 — Scenario 10: Atomic write → tmp file + rename
  // ═══════════════════════════════════════════════════════════════════════════

  describe("atomicity", () => {
    it("no temp files remain after successful write", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord();

      await repo.create(record);

      const files = readdirSync(tempDir).filter((f) => f.endsWith(".json") && !f.includes(".tmp."));
      expect(files).toHaveLength(1);

      // No temp files should remain
      const allFiles = readdirSync(tempDir);
      const tempFiles = allFiles.filter((f) => f.includes(".tmp."));
      expect(tempFiles).toHaveLength(0);
    });

    it("does not corrupt existing file when create fails on duplicate", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord();

      await repo.create(record);

      try {
        await repo.create(record);
      } catch {
        // Expected error
      }

      // Original file should still be intact
      const retrieved = await repo.getById(record.scheduleId as ScheduleId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.scheduleId).toBe(record.scheduleId);

      // Only one file should exist
      const files = readdirSync(tempDir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-07 — Scenario 11: Fail-closed lock → existing lock → acquisition fails
  // ═══════════════════════════════════════════════════════════════════════════

  describe("fail-closed locks", () => {
    it("existing lock prevents acquisition (O_EXCL behavior)", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord();

      // Create a lock file manually in the .locks directory
      const locksDir = join(tempDir, ".locks");
      const lockFile = join(locksDir, `${record.scheduleId}.lock`);

      const fd = openSync(lockFile, "wx");
      closeSync(fd);

      // Attempt to create — lock acquisition must fail immediately (fail-closed)
      try {
        await repo.create(record);
        expect.fail("Should have thrown OperationalError with LOCK_CONTENTION");
      } catch (error) {
        expect(error).toBeInstanceOf(OperationalError);
        expect((error as OperationalError).code).toBe(ERROR_CODES.LOCK_CONTENTION);
        expect((error as OperationalError).message).toContain("Lock contention for scheduleId");
      }

      // The lock file must still exist — fail-closed
      expect(readdirSync(locksDir).filter((f) => f.endsWith(".lock"))).toHaveLength(1);

      // Manual cleanup
      unlinkSync(lockFile);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // AC-07 — Scenario 12: Lock release → lock file removed after operation
    // ═══════════════════════════════════════════════════════════════════════════

    it("lock file is removed after successful operation", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord();

      await repo.create(record);

      // No .lock files should remain after create
      const locksDir = join(tempDir, ".locks");
      const lockFiles = readdirSync(locksDir).filter((f) => f.endsWith(".lock"));
      expect(lockFiles).toHaveLength(0);
    });

    it("lock file is removed after update", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord();

      await repo.create(record);
      await repo.update({ ...record, enabled: false });

      const locksDir = join(tempDir, ".locks");
      const lockFiles = readdirSync(locksDir).filter((f) => f.endsWith(".lock"));
      expect(lockFiles).toHaveLength(0);
    });

    it("lock can be re-acquired after release", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord();

      await repo.create(record);
      await repo.update({ ...record, enabled: false });
      await repo.update({ ...record, enabled: false, revision: 1 });

      const retrieved = await repo.getById(record.scheduleId as ScheduleId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.revision).toBe(2);

      const locksDir = join(tempDir, ".locks");
      const lockFiles = readdirSync(locksDir).filter((f) => f.endsWith(".lock"));
      expect(lockFiles).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-07 — Scenario 13: Corrupted file → CorruptedRecordError
  // ═══════════════════════════════════════════════════════════════════════════

  describe("corruption detection", () => {
    it("getById throws CorruptedRecordError when file has invalid JSON", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord();

      await repo.create(record);

      writeCorruptedFile(tempDir, `${record.scheduleId}.json`, "NOT VALID JSON {{{");

      await expect(repo.getById(record.scheduleId as ScheduleId)).rejects.toThrow(
        CorruptedRecordError,
      );
    });

    it("getById throws CorruptedRecordError when file has valid JSON but wrong schema", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord();

      await repo.create(record);

      writeCorruptedFile(
        tempDir,
        `${record.scheduleId}.json`,
        JSON.stringify({ notARecord: true }),
      );

      await expect(repo.getById(record.scheduleId as ScheduleId)).rejects.toThrow(
        CorruptedRecordError,
      );
    });

    it("list throws CorruptedRecordError when a file is corrupted", async () => {
      const repo = new FileScheduleRepository(tempDir);

      await repo.create(createRecord());

      writeCorruptedFile(tempDir, "corrupted-schedule.json", "NOT VALID JSON");

      await expect(repo.list()).rejects.toThrow(CorruptedRecordError);
    });

    it("findByIdempotencyKey throws CorruptedRecordError when a file is corrupted", async () => {
      const repo = new FileScheduleRepository(tempDir);

      await repo.create(createRecord());

      writeCorruptedFile(tempDir, "corrupted-schedule.json", "{bad json");

      await expect(repo.findByIdempotencyKey("schedule:nonexistent")).rejects.toThrow(
        CorruptedRecordError,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-07 — Scenario 14: Date fields serialized as ISO → restored
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Date serialization", () => {
    it("Date fields are serialized as ISO strings and restored as Date objects", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const now = new Date("2026-06-15T12:30:45.123Z");
      const record = createRecord({
        createdAt: now,
        updatedAt: now,
        lastRunAt: new Date("2026-06-15T13:00:00.000Z"),
        nextRunAt: new Date("2026-06-15T14:00:00.000Z"),
      });

      await repo.create(record);

      // Verify ISO strings on disk
      const content = readFileSync(join(tempDir, `${record.scheduleId}.json`), "utf8");
      const parsed = JSON.parse(content);
      expect(typeof parsed.createdAt).toBe("string");
      expect(parsed.createdAt).toBe("2026-06-15T12:30:45.123Z");

      // Verify restored as Date objects
      const retrieved = await repo.getById(record.scheduleId as ScheduleId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.createdAt).toBeInstanceOf(Date);
      expect(retrieved!.updatedAt).toBeInstanceOf(Date);
      expect(retrieved!.lastRunAt).toBeInstanceOf(Date);
      expect(retrieved!.nextRunAt).toBeInstanceOf(Date);
      expect(retrieved!.createdAt.toISOString()).toBe("2026-06-15T12:30:45.123Z");
      expect(retrieved!.updatedAt.toISOString()).toBe("2026-06-15T12:30:45.123Z");
      expect(retrieved!.lastRunAt!.toISOString()).toBe("2026-06-15T13:00:00.000Z");
      expect(retrieved!.nextRunAt!.toISOString()).toBe("2026-06-15T14:00:00.000Z");
    });

    it("optional Date fields remain undefined when not set", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord(); // no lastRunAt, no nextRunAt

      await repo.create(record);

      const retrieved = await repo.getById(record.scheduleId as ScheduleId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.lastRunAt).toBeUndefined();
      expect(retrieved!.nextRunAt).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-07 — Scenario 15: Non-existent directory is created → mkdirSync(recursive)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("directory creation", () => {
    it("creates storage directory and .locks directory if they do not exist", () => {
      const newDir = join(tempDir, "new-schedules", "nested");
      const _repo = new FileScheduleRepository(newDir);

      const files = readdirSync(newDir);
      expect(files).toContain(".locks");

      const lockFiles = readdirSync(join(newDir, ".locks"));
      expect(lockFiles).toEqual([]);
    });

    it("uses configurable storage directory", async () => {
      const customDir = join(tempDir, "custom-schedules");
      const repo = new FileScheduleRepository(customDir);

      await repo.create(createRecord());

      const files = readdirSync(customDir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
    });

    it("reads FILESCHEDULE_STORAGE_DIR environment variable", async () => {
      const envDir = join(tempDir, "env-schedules");
      process.env["FILESCHEDULE_STORAGE_DIR"] = envDir;

      try {
        const repo = new FileScheduleRepository();
        await repo.create(createRecord());

        const files = readdirSync(envDir).filter((f) => f.endsWith(".json"));
        expect(files).toHaveLength(1);
      } finally {
        delete process.env["FILESCHEDULE_STORAGE_DIR"];
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-07 — Scenario 16: safeResolve for path traversal → malicious paths
  //                       rejected
  // ═══════════════════════════════════════════════════════════════════════════

  describe("path traversal protection", () => {
    it("safeResolve rejects malicious scheduleId with path traversal", async () => {
      const repo = new FileScheduleRepository(tempDir);

      // Attempt to create a record with a scheduleId containing path traversal
      const maliciousRecord = createRecord();
      // Override scheduleId with path traversal characters
      const maliciousId = "../../../etc/passwd" as ScheduleId;
      const malicious = { ...maliciousRecord, scheduleId: maliciousId };

      // safeResolve should reject this path
      await expect(repo.create(malicious)).rejects.toThrow();
    });

    it("safeResolve rejects scheduleId with null bytes", async () => {
      const repo = new FileScheduleRepository(tempDir);

      const malicious = { ...createRecord(), scheduleId: "test\0evil" as ScheduleId };

      await expect(repo.create(malicious)).rejects.toThrow();
    });

    it("safeResolve rejects scheduleId with URL-encoded traversal", async () => {
      const repo = new FileScheduleRepository(tempDir);

      const malicious = {
        ...createRecord(),
        scheduleId: "..%2F..%2Fetc%2Fpasswd" as ScheduleId,
      };

      await expect(repo.create(malicious)).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Additional — Optimistic concurrency with sequential updates
  // ═══════════════════════════════════════════════════════════════════════════

  describe("sequential concurrency", () => {
    it("multiple sequential updates each increment revision", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord(); // revision = 0

      await repo.create(record);

      const r1 = await repo.update({ ...record, enabled: false }); // revision → 1
      const r2 = await repo.update({ ...r1, enabled: true }); // revision → 2
      const r3 = await repo.update({ ...r2, config: { ...validConfig, cron: "0 * * * *" } }); // revision → 3

      expect(r3.revision).toBe(3);

      const content = readFileSync(join(tempDir, `${record.scheduleId}.json`), "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.revision).toBe(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Additional — Concurrent updates with Promise.allSettled
  // ═══════════════════════════════════════════════════════════════════════════

  describe("concurrent updates", () => {
    it("concurrent updates: exactly one wins, one gets ConcurrencyConflictError", async () => {
      const repo = new FileScheduleRepository(tempDir);
      const record = createRecord(); // revision = 0

      await repo.create(record);

      const updateA = { ...record, enabled: false };
      const updateB = { ...record, enabled: true };

      const results = await Promise.allSettled([repo.update(updateA), repo.update(updateB)]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectedReason).toBeInstanceOf(ConcurrencyConflictError);

      // Final revision must be exactly 1 (only one update applied)
      const content = readFileSync(join(tempDir, `${record.scheduleId}.json`), "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.revision).toBe(1);
    });
  });
});
