import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  executeBatch,
  BATCH_HARD_MAX_CONCURRENCY,
  BATCH_DEFAULT_CONCURRENCY,
} from "./batch-executor.js";
import { DeterministicClock } from "./clock.js";
import type { BatchItem, BatchJob, BatchId } from "./batch-schema.js";
import { createBatchId, createBatchItemId } from "./batch-schema.js";
import type { BatchRepository } from "./batch-repository.js";
import type { RunRepository } from "./repository.js";
import type { PlatformAdapter, AdapterResult } from "../adapters/platform-adapter.js";
import type { RunIdentity, IdempotencyKey } from "./idempotency.js";
import { computeIdempotencyKey } from "./idempotency.js";
import type { RunRecord } from "./run-record.js";

// --- Test Helpers ---

function createTestIdentity(): RunIdentity {
  return {
    brandId: "best-fluency",
    market: "PT",
    platform: "instagram",
    operation: "post",
  };
}

function createTestBatchJob(): BatchJob {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    schemaVersion: 1,
    batchId: createBatchId(),
    status: "pending",
    totalItems: 0,
    completedItems: 0,
    failedItems: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function createTestBatchItem(batchId: BatchId, payload?: unknown): BatchItem {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    schemaVersion: 1,
    itemId: createBatchItemId(),
    batchId,
    runId: null,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    metadata: payload !== undefined ? { payload } : undefined,
  };
}

function createMockBatchRepo(): BatchRepository {
  return {
    createJob: vi.fn().mockImplementation(async (job: BatchJob) => job),
    getJobById: vi.fn().mockResolvedValue(null),
    updateJob: vi.fn().mockImplementation(async (job: BatchJob) => job),
    createItem: vi.fn().mockImplementation(async (item: BatchItem) => item),
    getItemById: vi.fn().mockResolvedValue(null),
    updateItem: vi.fn().mockImplementation(async (item: BatchItem) => item),
    listItemsByBatchId: vi.fn().mockResolvedValue([]),
    listJobsByStatus: vi.fn().mockResolvedValue([]),
    getBatchWithItems: vi.fn().mockResolvedValue(null),
  };
}

function createMockRunRepo(existingRuns: RunRecord[] = []): RunRepository {
  const runs = new Map<string, RunRecord>();
  for (const run of existingRuns) {
    runs.set(run.idempotencyKey as unknown as string, run);
  }

  return {
    create: vi.fn().mockImplementation(async (record: RunRecord) => {
      runs.set(record.idempotencyKey as unknown as string, record);
      return record;
    }),
    getById: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockImplementation(async (record: RunRecord) => {
      runs.set(record.idempotencyKey as unknown as string, record);
      return record;
    }),
    list: vi.fn().mockResolvedValue([]),
    findByIdempotencyKey: vi.fn().mockImplementation(async (key: IdempotencyKey) => {
      return runs.get(key as unknown as string) ?? null;
    }),
  };
}

function createMockAdapter(results: AdapterResult[] = []): PlatformAdapter {
  let callIndex = 0;
  return {
    execute: vi.fn().mockImplementation(async () => {
      const result = results[callIndex] ?? results[results.length - 1];
      callIndex++;
      return result;
    }),
    checkStatus: vi.fn().mockResolvedValue({ state: "succeeded" }),
  };
}

function createSuccessAdapter(): PlatformAdapter {
  return createMockAdapter([{ success: true, output: {}, requiresManual: false }]);
}

function createFailAdapter(errorMessage = "Adapter error"): PlatformAdapter {
  return createMockAdapter([
    {
      success: false,
      error: { message: errorMessage },
      requiresManual: false,
    },
  ]);
}

function computeBatchItemKey(
  batchId: BatchId,
  itemId: string,
  identity: RunIdentity,
  payload: unknown,
): IdempotencyKey {
  const batchPayload = { batchId, itemId, ...identity, payload };
  return computeIdempotencyKey(identity, batchPayload);
}

// --- Tests ---

describe("batch-executor", () => {
  describe("constants", () => {
    it("BATCH_DEFAULT_CONCURRENCY is 1", () => {
      expect(BATCH_DEFAULT_CONCURRENCY).toBe(1);
    });

    it("BATCH_HARD_MAX_CONCURRENCY is 5", () => {
      expect(BATCH_HARD_MAX_CONCURRENCY).toBe(5);
    });
  });

  describe("executeBatch", () => {
    let clock: DeterministicClock;
    let identity: RunIdentity;

    beforeEach(() => {
      clock = new DeterministicClock(new Date("2026-01-01T00:00:00Z"));
      identity = createTestIdentity();
    });

    // --- AC-11: Concurrency ---

    it("1. default concurrency=1 executes sequentially", async () => {
      const batchJob = createTestBatchJob();
      const items = [
        createTestBatchItem(batchJob.batchId, { a: 1 }),
        createTestBatchItem(batchJob.batchId, { a: 2 }),
        createTestBatchItem(batchJob.batchId, { a: 3 }),
      ];
      const executionOrder: number[] = [];
      const adapter: PlatformAdapter = {
        execute: vi.fn().mockImplementation(async (ctx) => {
          executionOrder.push((ctx.payload as { a: number }).a);
          // Small delay to verify sequential behavior
          await new Promise((r) => setTimeout(r, 10));
          return { success: true, output: {}, requiresManual: false };
        }),
        checkStatus: vi.fn().mockResolvedValue({ state: "succeeded" }),
      };

      const result = await executeBatch(
        batchJob,
        items,
        identity,
        adapter,
        createMockBatchRepo(),
        createMockRunRepo(),
        clock,
      );

      expect(result.status).toBe("succeeded");
      expect(result.completedItems).toBe(3);
      // Sequential means items execute in order
      expect(executionOrder).toEqual([1, 2, 3]);
    });

    it("2. concurrency=5 respects limit", async () => {
      const batchJob = createTestBatchJob();
      const items = Array.from({ length: 10 }, (_, i) =>
        createTestBatchItem(batchJob.batchId, { i }),
      );
      let concurrent = 0;
      let maxConcurrent = 0;
      const adapter: PlatformAdapter = {
        execute: vi.fn().mockImplementation(async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent--;
          return { success: true, output: {}, requiresManual: false };
        }),
        checkStatus: vi.fn().mockResolvedValue({ state: "succeeded" }),
      };

      const result = await executeBatch(
        batchJob,
        items,
        identity,
        adapter,
        createMockBatchRepo(),
        createMockRunRepo(),
        clock,
        { concurrency: 5 },
      );

      expect(result.status).toBe("succeeded");
      expect(maxConcurrent).toBeLessThanOrEqual(5);
    });

    it("3. concurrency=6 throws error", async () => {
      const batchJob = createTestBatchJob();
      const items = [createTestBatchItem(batchJob.batchId)];

      await expect(
        executeBatch(
          batchJob,
          items,
          identity,
          createSuccessAdapter(),
          createMockBatchRepo(),
          createMockRunRepo(),
          clock,
          { concurrency: 6 },
        ),
      ).rejects.toThrow("exceeds hard maximum of 5");
    });

    it("4. concurrency<1 throws error", async () => {
      const batchJob = createTestBatchJob();
      const items = [createTestBatchItem(batchJob.batchId)];

      await expect(
        executeBatch(
          batchJob,
          items,
          identity,
          createSuccessAdapter(),
          createMockBatchRepo(),
          createMockRunRepo(),
          clock,
          { concurrency: 0 },
        ),
      ).rejects.toThrow("Must be >= 1");
    });

    // --- AC-12: Per-item isolation ---

    it("5. failing item does not interrupt other items", async () => {
      const batchJob = createTestBatchJob();
      const items = [
        createTestBatchItem(batchJob.batchId, { id: "ok1" }),
        createTestBatchItem(batchJob.batchId, { id: "fail" }),
        createTestBatchItem(batchJob.batchId, { id: "ok2" }),
      ];

      let callCount = 0;
      const adapter: PlatformAdapter = {
        execute: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 2) {
            throw new Error("Item 2 crashed");
          }
          return { success: true, output: {}, requiresManual: false };
        }),
        checkStatus: vi.fn().mockResolvedValue({ state: "succeeded" }),
      };

      const result = await executeBatch(
        batchJob,
        items,
        identity,
        adapter,
        createMockBatchRepo(),
        createMockRunRepo(),
        clock,
      );

      expect(result.totalItems).toBe(3);
      expect(result.completedItems).toBe(2);
      expect(result.failedItems).toBe(1);
      expect(adapter.execute).toHaveBeenCalledTimes(3);
    });

    it("6. batch with 5 items where 2 fail executes all", async () => {
      const batchJob = createTestBatchJob();
      const items = Array.from({ length: 5 }, (_, i) =>
        createTestBatchItem(batchJob.batchId, { i }),
      );

      let callCount = 0;
      const adapter: PlatformAdapter = {
        execute: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 2 || callCount === 4) {
            return {
              success: false,
              error: { message: `Failed item ${callCount}` },
              requiresManual: false,
            };
          }
          return { success: true, output: {}, requiresManual: false };
        }),
        checkStatus: vi.fn().mockResolvedValue({ state: "succeeded" }),
      };

      const result = await executeBatch(
        batchJob,
        items,
        identity,
        adapter,
        createMockBatchRepo(),
        createMockRunRepo(),
        clock,
      );

      expect(result.totalItems).toBe(5);
      expect(result.completedItems).toBe(3);
      expect(result.failedItems).toBe(2);
      expect(adapter.execute).toHaveBeenCalledTimes(5);
    });

    // --- AC-13: Idempotency ---

    it("7. same batchId+itemId+identity+payload generates same key", async () => {
      const batchJob = createTestBatchJob();
      const item = createTestBatchItem(batchJob.batchId, { data: "test" });

      // Compute key twice with same inputs
      const key1 = computeBatchItemKey(
        batchJob.batchId,
        item.itemId as unknown as string,
        identity,
        { data: "test" },
      );
      const key2 = computeBatchItemKey(
        batchJob.batchId,
        item.itemId as unknown as string,
        identity,
        { data: "test" },
      );

      expect(key1).toBe(key2);
    });

    it("8. re-execution does not duplicate runs", async () => {
      const batchJob = createTestBatchJob();
      const items = [createTestBatchItem(batchJob.batchId, { data: "dup" })];

      // Create an existing run that matches the idempotency key
      const existingKey = computeBatchItemKey(
        batchJob.batchId,
        items[0].itemId as unknown as string,
        identity,
        { data: "dup" },
      );
      const existingRun: RunRecord = {
        schemaVersion: 1,
        runId: "existing-run-id" as unknown as import("./idempotency.js").RunId,
        brandId: identity.brandId,
        market: identity.market,
        platform: identity.platform,
        operation: identity.operation,
        state: "succeeded",
        attempt: 1,
        maxAttempts: 1,
        idempotencyKey: existingKey,
        payloadFingerprint: "fp" as unknown as import("./idempotency.js").PayloadFingerprint,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const runRepo = createMockRunRepo([existingRun]);
      const adapter = createSuccessAdapter();

      const result = await executeBatch(
        batchJob,
        items,
        identity,
        adapter,
        createMockBatchRepo(),
        runRepo,
        clock,
      );

      // Should not call adapter.execute because run already exists
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(result.completedItems).toBe(1);
      expect(result.failedItems).toBe(0);
    });

    // --- AC-14: Partial failure semantics ---

    it("9. 0 failures → succeeded", async () => {
      const batchJob = createTestBatchJob();
      const items = [
        createTestBatchItem(batchJob.batchId, { a: 1 }),
        createTestBatchItem(batchJob.batchId, { a: 2 }),
      ];

      const result = await executeBatch(
        batchJob,
        items,
        identity,
        createSuccessAdapter(),
        createMockBatchRepo(),
        createMockRunRepo(),
        clock,
      );

      expect(result.status).toBe("succeeded");
      expect(result.completedItems).toBe(2);
      expect(result.failedItems).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("10. all fail → failed", async () => {
      const batchJob = createTestBatchJob();
      const items = [
        createTestBatchItem(batchJob.batchId, { a: 1 }),
        createTestBatchItem(batchJob.batchId, { a: 2 }),
      ];

      const result = await executeBatch(
        batchJob,
        items,
        identity,
        createFailAdapter("All fail"),
        createMockBatchRepo(),
        createMockRunRepo(),
        clock,
      );

      expect(result.status).toBe("failed");
      expect(result.completedItems).toBe(0);
      expect(result.failedItems).toBe(2);
      expect(result.errors).toHaveLength(2);
    });

    it("11. mix of success and failure → partial_failure", async () => {
      const batchJob = createTestBatchJob();
      const items = [
        createTestBatchItem(batchJob.batchId, { a: 1 }),
        createTestBatchItem(batchJob.batchId, { a: 2 }),
        createTestBatchItem(batchJob.batchId, { a: 3 }),
      ];

      let callCount = 0;
      const adapter: PlatformAdapter = {
        execute: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 2) {
            return {
              success: false,
              error: { message: "fail" },
              requiresManual: false,
            };
          }
          return { success: true, output: {}, requiresManual: false };
        }),
        checkStatus: vi.fn().mockResolvedValue({ state: "succeeded" }),
      };

      const result = await executeBatch(
        batchJob,
        items,
        identity,
        adapter,
        createMockBatchRepo(),
        createMockRunRepo(),
        clock,
      );

      expect(result.status).toBe("partial_failure");
      expect(result.completedItems).toBe(2);
      expect(result.failedItems).toBe(1);
    });

    // --- AC-15: Batch-run correlation ---

    it("12. RunRecord has metadata.batchId and metadata.itemId", async () => {
      const batchJob = createTestBatchJob();
      const items = [createTestBatchItem(batchJob.batchId, { x: 1 })];

      const createdRuns: RunRecord[] = [];
      const runRepo: RunRepository = {
        create: vi.fn().mockImplementation(async (record: RunRecord) => {
          createdRuns.push(record);
          return record;
        }),
        getById: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockImplementation(async (record: RunRecord) => record),
        list: vi.fn().mockResolvedValue([]),
        findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      };

      await executeBatch(
        batchJob,
        items,
        identity,
        createSuccessAdapter(),
        createMockBatchRepo(),
        runRepo,
        clock,
      );

      expect(createdRuns).toHaveLength(1);
      expect(createdRuns[0].metadata).toBeDefined();
      expect(createdRuns[0].metadata!.batchId).toBe(batchJob.batchId);
      expect(createdRuns[0].metadata!.itemId).toBe(items[0].itemId);
    });

    // --- BatchJob lifecycle ---

    it("updates batchJob status to running then final", async () => {
      const batchJob = createTestBatchJob();
      const items = [createTestBatchItem(batchJob.batchId)];

      const updatedJobs: BatchJob[] = [];
      const batchRepo = createMockBatchRepo();
      (batchRepo.updateJob as ReturnType<typeof vi.fn>).mockImplementation(
        async (job: BatchJob) => {
          updatedJobs.push(job);
          return job;
        },
      );

      await executeBatch(
        batchJob,
        items,
        identity,
        createSuccessAdapter(),
        batchRepo,
        createMockRunRepo(),
        clock,
      );

      // First update: running, second update: succeeded
      expect(updatedJobs).toHaveLength(2);
      expect(updatedJobs[0].status).toBe("running");
      expect(updatedJobs[1].status).toBe("succeeded");
    });

    it("sets totalItems on running job", async () => {
      const batchJob = createTestBatchJob();
      const items = [
        createTestBatchItem(batchJob.batchId),
        createTestBatchItem(batchJob.batchId),
        createTestBatchItem(batchJob.batchId),
      ];

      const updatedJobs: BatchJob[] = [];
      const batchRepo = createMockBatchRepo();
      (batchRepo.updateJob as ReturnType<typeof vi.fn>).mockImplementation(
        async (job: BatchJob) => {
          updatedJobs.push(job);
          return job;
        },
      );

      await executeBatch(
        batchJob,
        items,
        identity,
        createSuccessAdapter(),
        batchRepo,
        createMockRunRepo(),
        clock,
      );

      expect(updatedJobs[0].totalItems).toBe(3);
    });

    it("defaults maxAttempts to 1", async () => {
      const batchJob = createTestBatchJob();
      const items = [createTestBatchItem(batchJob.batchId)];

      const createdRuns: RunRecord[] = [];
      const runRepo: RunRepository = {
        create: vi.fn().mockImplementation(async (record: RunRecord) => {
          createdRuns.push(record);
          return record;
        }),
        getById: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockImplementation(async (record: RunRecord) => record),
        list: vi.fn().mockResolvedValue([]),
        findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      };

      await executeBatch(
        batchJob,
        items,
        identity,
        createSuccessAdapter(),
        createMockBatchRepo(),
        runRepo,
        clock,
      );

      expect(createdRuns[0].maxAttempts).toBe(1);
    });

    it("respects custom maxAttempts option", async () => {
      const batchJob = createTestBatchJob();
      const items = [createTestBatchItem(batchJob.batchId)];

      const createdRuns: RunRecord[] = [];
      const runRepo: RunRepository = {
        create: vi.fn().mockImplementation(async (record: RunRecord) => {
          createdRuns.push(record);
          return record;
        }),
        getById: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockImplementation(async (record: RunRecord) => record),
        list: vi.fn().mockResolvedValue([]),
        findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      };

      await executeBatch(
        batchJob,
        items,
        identity,
        createSuccessAdapter(),
        createMockBatchRepo(),
        runRepo,
        clock,
        { maxAttempts: 3 },
      );

      expect(createdRuns[0].maxAttempts).toBe(3);
    });

    it("handles negative concurrency", async () => {
      const batchJob = createTestBatchJob();
      const items = [createTestBatchItem(batchJob.batchId)];

      await expect(
        executeBatch(
          batchJob,
          items,
          identity,
          createSuccessAdapter(),
          createMockBatchRepo(),
          createMockRunRepo(),
          clock,
          { concurrency: -1 },
        ),
      ).rejects.toThrow("Must be >= 1");
    });

    it("handles non-integer concurrency", async () => {
      const batchJob = createTestBatchJob();
      const items = [createTestBatchItem(batchJob.batchId)];

      await expect(
        executeBatch(
          batchJob,
          items,
          identity,
          createSuccessAdapter(),
          createMockBatchRepo(),
          createMockRunRepo(),
          clock,
          { concurrency: 2.5 },
        ),
      ).rejects.toThrow("Must be >= 1");
    });
  });
});
