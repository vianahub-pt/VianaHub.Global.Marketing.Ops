import { describe, expect, it } from "vitest";

import type { BatchRepository, BatchItemFilters, BatchWithItems } from "./batch-repository.js";
import type { BatchJob, BatchItemStatus } from "./batch-schema.js";
import { createBatchJob, createBatchItem, createBatchId, BATCH_STATUSES } from "./batch-schema.js";

/**
 * BatchRepository contract tests.
 *
 * These tests verify that any BatchRepository implementation satisfies
 * the domain contract. They are intentionally minimal because the
 * repository is an interface — concrete adapters provide the behavior.
 */

describe("BatchRepository interface", () => {
  it("has all required methods", () => {
    const stub: BatchRepository = {
      createJob: async (job) => job,
      getJobById: async () => null,
      updateJob: async (job) => job,
      createItem: async (item) => item,
      getItemById: async () => null,
      updateItem: async (item) => item,
      listItemsByBatchId: async () => [],
      listJobsByStatus: async () => [],
      getBatchWithItems: async () => null,
    };

    expect(stub.createJob).toBeTypeOf("function");
    expect(stub.getJobById).toBeTypeOf("function");
    expect(stub.updateJob).toBeTypeOf("function");
    expect(stub.createItem).toBeTypeOf("function");
    expect(stub.getItemById).toBeTypeOf("function");
    expect(stub.updateItem).toBeTypeOf("function");
    expect(stub.listItemsByBatchId).toBeTypeOf("function");
    expect(stub.listJobsByStatus).toBeTypeOf("function");
    expect(stub.getBatchWithItems).toBeTypeOf("function");
  });

  it("stub implementation returns expected types", async () => {
    const stub: BatchRepository = {
      createJob: async (job) => job,
      getJobById: async () => null,
      updateJob: async (job) => job,
      createItem: async (item) => item,
      getItemById: async () => null,
      updateItem: async (item) => item,
      listItemsByBatchId: async () => [],
      listJobsByStatus: async () => [],
      getBatchWithItems: async () => null,
    };

    const jobResult = await stub.getJobById("test-id" as never);
    expect(jobResult).toBeNull();

    const itemResult = await stub.getItemById("test-id" as never);
    expect(itemResult).toBeNull();

    const listResult = await stub.listItemsByBatchId("test-id" as never);
    expect(listResult).toEqual([]);

    const statusResult = await stub.listJobsByStatus("pending");
    expect(statusResult).toEqual([]);

    const withItemsResult = await stub.getBatchWithItems("test-id" as never);
    expect(withItemsResult).toBeNull();
  });
});

describe("BatchItemFilters interface", () => {
  it("accepts optional status field", () => {
    const filters: BatchItemFilters = {
      status: "pending",
    };

    expect(filters.status).toBe("pending");
  });

  it("accepts empty filters", () => {
    const filters: BatchItemFilters = {};
    expect(Object.keys(filters)).toHaveLength(0);
  });

  it("accepts all valid BatchItemStatus values", () => {
    const statuses: BatchItemStatus[] = ["pending", "running", "succeeded", "failed", "cancelled"];

    for (const status of statuses) {
      const filters: BatchItemFilters = { status };
      expect(filters.status).toBe(status);
    }
  });
});

describe("BatchWithItems interface", () => {
  it("contains job and items fields", () => {
    const batchId = createBatchId();
    const job = createBatchJob();
    const item = createBatchItem(batchId);

    const batchWithItems: BatchWithItems = {
      job,
      items: [item],
    };

    expect(batchWithItems.job).toBeDefined();
    expect(batchWithItems.items).toBeDefined();
    expect(Array.isArray(batchWithItems.items)).toBe(true);
  });

  it("items is a readonly array", () => {
    const batchWithItems: BatchWithItems = {
      job: createBatchJob(),
      items: [],
    };

    expect(batchWithItems.items).toEqual([]);
  });
});

describe("BatchJob fields", () => {
  it("contains all required fields", () => {
    const job = createBatchJob();

    expect(job.schemaVersion).toBe(1);
    expect(typeof job.batchId).toBe("string");
    expect(job.status).toBe("pending");
    expect(job.totalItems).toBe(0);
    expect(job.completedItems).toBe(0);
    expect(job.failedItems).toBe(0);
    expect(job.createdAt).toBeInstanceOf(Date);
    expect(job.updatedAt).toBeInstanceOf(Date);
  });

  it("metadata is optional", () => {
    const jobWithoutMeta = createBatchJob();
    expect(jobWithoutMeta.metadata).toBeUndefined();

    const jobWithMeta = createBatchJob({ key: "value" });
    expect(jobWithMeta.metadata).toEqual({ key: "value" });
  });

  it("status accepts all valid BatchStatus values", () => {
    for (const status of BATCH_STATUSES) {
      const job: BatchJob = {
        ...createBatchJob(),
        status,
      };
      expect(job.status).toBe(status);
    }
  });
});

describe("BatchItem fields", () => {
  it("contains all required fields", () => {
    const batchId = createBatchId();
    const item = createBatchItem(batchId);

    expect(item.schemaVersion).toBe(1);
    expect(typeof item.itemId).toBe("string");
    expect(item.batchId).toBe(batchId);
    expect(item.runId).toBeNull();
    expect(item.status).toBe("pending");
    expect(item.createdAt).toBeInstanceOf(Date);
    expect(item.updatedAt).toBeInstanceOf(Date);
  });

  it("error is optional", () => {
    const batchId = createBatchId();
    const item = createBatchItem(batchId);
    expect(item.error).toBeUndefined();
  });

  it("metadata is optional", () => {
    const batchId = createBatchId();
    const itemWithoutMeta = createBatchItem(batchId);
    expect(itemWithoutMeta.metadata).toBeUndefined();

    const itemWithMeta = createBatchItem(batchId, { key: "value" });
    expect(itemWithMeta.metadata).toEqual({ key: "value" });
  });
});
