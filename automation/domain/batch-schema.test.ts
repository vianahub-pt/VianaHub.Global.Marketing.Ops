import { describe, it, expect } from "vitest";
import {
  createBatchId,
  createBatchItemId,
  createBatchJob,
  createBatchItem,
  batchJobSchema,
  batchItemSchema,
  BATCH_STATUSES,
} from "./batch-schema.js";

describe("batch-schema", () => {
  describe("BATCH_STATUSES", () => {
    it("should contain all expected status values", () => {
      expect(BATCH_STATUSES).toEqual([
        "pending",
        "running",
        "succeeded",
        "partial_failure",
        "failed",
        "cancelled",
      ]);
    });

    it("should have exactly 6 statuses", () => {
      expect(BATCH_STATUSES).toHaveLength(6);
    });
  });

  describe("batchJobSchema", () => {
    it("should validate a valid BatchJob", () => {
      const validJob = {
        schemaVersion: 1,
        batchId: "test-batch-id",
        status: "pending" as const,
        totalItems: 10,
        completedItems: 0,
        failedItems: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = batchJobSchema.safeParse(validJob);
      expect(result.success).toBe(true);
    });

    it("should reject a BatchJob with missing required fields", () => {
      const invalidJob = {
        schemaVersion: 1,
        batchId: "test-batch-id",
        // missing status, totalItems, etc.
      };

      const result = batchJobSchema.safeParse(invalidJob);
      expect(result.success).toBe(false);
    });

    it("should reject a BatchJob with invalid status", () => {
      const invalidJob = {
        schemaVersion: 1,
        batchId: "test-batch-id",
        status: "invalid_status",
        totalItems: 10,
        completedItems: 0,
        failedItems: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = batchJobSchema.safeParse(invalidJob);
      expect(result.success).toBe(false);
    });

    it("should reject negative totalItems", () => {
      const invalidJob = {
        schemaVersion: 1,
        batchId: "test-batch-id",
        status: "pending" as const,
        totalItems: -1,
        completedItems: 0,
        failedItems: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = batchJobSchema.safeParse(invalidJob);
      expect(result.success).toBe(false);
    });

    it("should accept optional metadata", () => {
      const jobWithMetadata = {
        schemaVersion: 1,
        batchId: "test-batch-id",
        status: "pending" as const,
        totalItems: 10,
        completedItems: 0,
        failedItems: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: { source: "test" },
      };

      const result = batchJobSchema.safeParse(jobWithMetadata);
      expect(result.success).toBe(true);
    });
  });

  describe("batchItemSchema", () => {
    it("should validate a valid BatchItem", () => {
      const validItem = {
        schemaVersion: 1,
        itemId: "test-item-id",
        batchId: "test-batch-id",
        runId: null,
        status: "pending" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = batchItemSchema.safeParse(validItem);
      expect(result.success).toBe(true);
    });

    it("should reject a BatchItem with missing required fields", () => {
      const invalidItem = {
        schemaVersion: 1,
        itemId: "test-item-id",
        // missing batchId, status, etc.
      };

      const result = batchItemSchema.safeParse(invalidItem);
      expect(result.success).toBe(false);
    });

    it("should accept null runId", () => {
      const itemWithNullRunId = {
        schemaVersion: 1,
        itemId: "test-item-id",
        batchId: "test-batch-id",
        runId: null,
        status: "pending" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = batchItemSchema.safeParse(itemWithNullRunId);
      expect(result.success).toBe(true);
    });

    it("should accept string runId", () => {
      const itemWithStringRunId = {
        schemaVersion: 1,
        itemId: "test-item-id",
        batchId: "test-batch-id",
        runId: "run-123",
        status: "running" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = batchItemSchema.safeParse(itemWithStringRunId);
      expect(result.success).toBe(true);
    });

    it("should accept optional error field", () => {
      const itemWithError = {
        schemaVersion: 1,
        itemId: "test-item-id",
        batchId: "test-batch-id",
        runId: "run-123",
        status: "failed" as const,
        error: "Something went wrong",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = batchItemSchema.safeParse(itemWithError);
      expect(result.success).toBe(true);
    });
  });

  describe("schema strict mode", () => {
    it("should reject extra fields in BatchJob", () => {
      const jobWithExtra = {
        schemaVersion: 1,
        batchId: "test-batch-id",
        status: "pending" as const,
        totalItems: 10,
        completedItems: 0,
        failedItems: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        extraField: "not allowed",
      };

      const result = batchJobSchema.safeParse(jobWithExtra);
      expect(result.success).toBe(false);
    });

    it("should reject extra fields in BatchItem", () => {
      const itemWithExtra = {
        schemaVersion: 1,
        itemId: "test-item-id",
        batchId: "test-batch-id",
        runId: null,
        status: "pending" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
        extraField: "not allowed",
      };

      const result = batchItemSchema.safeParse(itemWithExtra);
      expect(result.success).toBe(false);
    });
  });

  describe("createBatchId", () => {
    it("should generate unique IDs", () => {
      const id1 = createBatchId();
      const id2 = createBatchId();

      expect(id1).not.toBe(id2);
    });

    it("should return a string", () => {
      const id = createBatchId();
      expect(typeof id).toBe("string");
    });

    it("should generate valid UUID format", () => {
      const id = createBatchId();
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(id).toMatch(uuidRegex);
    });
  });

  describe("createBatchItemId", () => {
    it("should generate unique IDs", () => {
      const id1 = createBatchItemId();
      const id2 = createBatchItemId();

      expect(id1).not.toBe(id2);
    });

    it("should return a string", () => {
      const id = createBatchItemId();
      expect(typeof id).toBe("string");
    });

    it("should generate valid UUID format", () => {
      const id = createBatchItemId();
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(id).toMatch(uuidRegex);
    });
  });

  describe("createBatchJob", () => {
    it("should create a job with correct default values", () => {
      const job = createBatchJob();

      expect(job.schemaVersion).toBe(1);
      expect(job.status).toBe("pending");
      expect(job.totalItems).toBe(0);
      expect(job.completedItems).toBe(0);
      expect(job.failedItems).toBe(0);
      expect(job.createdAt).toBeInstanceOf(Date);
      expect(job.updatedAt).toBeInstanceOf(Date);
    });

    it("should generate a unique batchId", () => {
      const job1 = createBatchJob();
      const job2 = createBatchJob();

      expect(job1.batchId).not.toBe(job2.batchId);
    });

    it("should set createdAt and updatedAt to the same time", () => {
      const job = createBatchJob();
      expect(job.createdAt.getTime()).toBe(job.updatedAt.getTime());
    });

    it("should accept optional metadata", () => {
      const metadata = { source: "test", priority: "high" };
      const job = createBatchJob(metadata);

      expect(job.metadata).toEqual(metadata);
    });

    it("should create job without metadata when not provided", () => {
      const job = createBatchJob();
      expect(job.metadata).toBeUndefined();
    });

    it("should validate against batchJobSchema", () => {
      const job = createBatchJob();
      const result = batchJobSchema.safeParse(job);
      expect(result.success).toBe(true);
    });
  });

  describe("createBatchItem", () => {
    it("should create an item with correct default values", () => {
      const batchId = createBatchId();
      const item = createBatchItem(batchId);

      expect(item.schemaVersion).toBe(1);
      expect(item.batchId).toBe(batchId);
      expect(item.runId).toBeNull();
      expect(item.status).toBe("pending");
      expect(item.createdAt).toBeInstanceOf(Date);
      expect(item.updatedAt).toBeInstanceOf(Date);
    });

    it("should generate a unique itemId", () => {
      const batchId = createBatchId();
      const item1 = createBatchItem(batchId);
      const item2 = createBatchItem(batchId);

      expect(item1.itemId).not.toBe(item2.itemId);
    });

    it("should associate item with the correct batchId", () => {
      const batchId = createBatchId();
      const item = createBatchItem(batchId);

      expect(item.batchId).toBe(batchId);
    });

    it("should accept optional metadata", () => {
      const batchId = createBatchId();
      const metadata = { index: 0, data: "test" };
      const item = createBatchItem(batchId, metadata);

      expect(item.metadata).toEqual(metadata);
    });

    it("should create item without metadata when not provided", () => {
      const batchId = createBatchId();
      const item = createBatchItem(batchId);
      expect(item.metadata).toBeUndefined();
    });

    it("should validate against batchItemSchema", () => {
      const batchId = createBatchId();
      const item = createBatchItem(batchId);
      const result = batchItemSchema.safeParse(item);
      expect(result.success).toBe(true);
    });
  });
});
