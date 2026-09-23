import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AuditEntry } from "../domain/audit-entry.js";
import { createAuditEntry, auditEntrySchema } from "../domain/audit-entry.js";
import { FileAuditRepository } from "./file-audit-repo.js";

// --- Helpers ---

let tempDir: string;

type CreateEntryParams = Parameters<typeof createAuditEntry>[0];

function createTestEntry(overrides?: Partial<CreateEntryParams>): AuditEntry {
  return createAuditEntry({
    category: "test",
    action: "test-action",
    actor: "system",
    correlationIds: { runId: "run-123" },
    clock: { now: () => new Date("2026-01-15T10:30:00.000Z") },
    ...overrides,
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "file-audit-repo-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// --- Tests ---

describe("FileAuditRepository", () => {
  describe("append", () => {
    it("creates one JSON file per audit entry", async () => {
      const repo = new FileAuditRepository(tempDir);
      const entry = createTestEntry();

      await repo.append(entry);

      const files = readdirSync(tempDir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
    });

    it("filename contains ISO timestamp and entryId", async () => {
      const repo = new FileAuditRepository(tempDir);
      const entry = createTestEntry();

      await repo.append(entry);

      const files = readdirSync(tempDir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      // Filename should match pattern: {ISO-timestamp}_{entryId}.json
      const filename = files[0]!;
      expect(filename).toContain("_");
      expect(filename).toContain(entry.entryId);
      expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    });

    it("file content is valid JSON matching auditEntrySchema", async () => {
      const repo = new FileAuditRepository(tempDir);
      const entry = createTestEntry();

      await repo.append(entry);

      const files = readdirSync(tempDir).filter((f) => f.endsWith(".json"));
      const filePath = join(tempDir, files[0]!);
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      // Reconstitute Date for validation
      parsed["timestamp"] = new Date(parsed["timestamp"] as string);

      const result = auditEntrySchema.safeParse(parsed);
      expect(result.success).toBe(true);
    });

    it("atomic write: no .tmp files left behind", async () => {
      const repo = new FileAuditRepository(tempDir);
      const entry = createTestEntry();

      await repo.append(entry);

      const allFiles = readdirSync(tempDir);
      const tmpFiles = allFiles.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });

    it("applies redaction to metadata before persistence (AC-26)", async () => {
      const repo = new FileAuditRepository(tempDir);
      const entry = createTestEntry({
        metadata: {
          token: "secret=mysecrettoken123",
          safe: "normal-value",
        },
      });

      const result = await repo.append(entry);

      // The returned entry should have redacted metadata
      expect(result.metadata?.["safe"]).toBe("normal-value");
      // Sensitive values should be redacted
      expect(result.metadata?.["token"]).toContain("[REDACTED]");

      // File should also have redacted content
      const files = readdirSync(tempDir).filter((f) => f.endsWith(".json"));
      const filePath = join(tempDir, files[0]!);
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed["metadata"]).toBeDefined();
    });

    it("creates directory if it does not exist", async () => {
      const nestedDir = join(tempDir, "nested", "audit");
      const repo = new FileAuditRepository(nestedDir);
      const entry = createTestEntry();

      await repo.append(entry);

      const files = readdirSync(nestedDir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
    });
  });

  describe("listByCorrelation", () => {
    it("returns entries matching runId", async () => {
      const repo = new FileAuditRepository(tempDir);

      await repo.append(createTestEntry({ correlationIds: { runId: "run-abc" } }));
      await repo.append(createTestEntry({ correlationIds: { runId: "run-xyz" } }));
      await repo.append(createTestEntry({ correlationIds: { runId: "run-abc" } }));

      const result = await repo.listByCorrelation({ runId: "run-abc" });
      expect(result).toHaveLength(2);
      for (const entry of result) {
        expect(entry.correlationIds.runId).toBe("run-abc");
      }
    });

    it("returns entries matching scheduleId", async () => {
      const repo = new FileAuditRepository(tempDir);

      await repo.append(createTestEntry({ correlationIds: { scheduleId: "sched-1" } }));
      await repo.append(createTestEntry({ correlationIds: { scheduleId: "sched-2" } }));

      const result = await repo.listByCorrelation({ scheduleId: "sched-1" });
      expect(result).toHaveLength(1);
      expect(result[0]!.correlationIds.scheduleId).toBe("sched-1");
    });

    it("returns entries matching batchId", async () => {
      const repo = new FileAuditRepository(tempDir);

      await repo.append(createTestEntry({ correlationIds: { batchId: "batch-99" } }));
      await repo.append(createTestEntry({ correlationIds: { batchId: "batch-99" } }));
      await repo.append(createTestEntry({ correlationIds: { batchId: "batch-100" } }));

      const result = await repo.listByCorrelation({ batchId: "batch-99" });
      expect(result).toHaveLength(2);
      for (const entry of result) {
        expect(entry.correlationIds.batchId).toBe("batch-99");
      }
    });
  });

  describe("listByTimeRange", () => {
    it("returns entries within the specified range", async () => {
      const repo = new FileAuditRepository(tempDir);

      // Create entries with different timestamps
      await repo.append(
        createTestEntry({
          correlationIds: { runId: "run-1" },
          clock: { now: () => new Date("2026-01-10T00:00:00.000Z") },
        }),
      );
      await repo.append(
        createTestEntry({
          correlationIds: { runId: "run-2" },
          clock: { now: () => new Date("2026-01-15T00:00:00.000Z") },
        }),
      );
      await repo.append(
        createTestEntry({
          correlationIds: { runId: "run-3" },
          clock: { now: () => new Date("2026-01-20T00:00:00.000Z") },
        }),
      );

      const result = await repo.listByTimeRange({
        from: new Date("2026-01-12T00:00:00.000Z"),
        to: new Date("2026-01-18T00:00:00.000Z"),
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.correlationIds.runId).toBe("run-2");
    });
  });

  describe("listByCategory", () => {
    it("returns entries matching the category", async () => {
      const repo = new FileAuditRepository(tempDir);

      await repo.append(createTestEntry({ category: "run" }));
      await repo.append(createTestEntry({ category: "schedule" }));
      await repo.append(createTestEntry({ category: "run" }));

      const result = await repo.listByCategory("run");
      expect(result).toHaveLength(2);
      for (const entry of result) {
        expect(entry.category).toBe("run");
      }
    });
  });

  describe("corrupted files", () => {
    it("handles corrupted files without throwing", async () => {
      const repo = new FileAuditRepository(tempDir);

      // Create a valid entry
      await repo.append(createTestEntry());

      // Write a corrupted file
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(tempDir, "corrupted.json"), "not valid json{{", "utf8");

      // Should still return the valid entry
      const result = await repo.listByCorrelation({ runId: "run-123" });
      expect(result).toHaveLength(1);
    });
  });
});
