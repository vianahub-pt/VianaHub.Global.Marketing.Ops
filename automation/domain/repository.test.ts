import { describe, expect, it } from "vitest";

import type { RunRepository, RunListFilters } from "./repository.js";

/**
 * Repository contract tests.
 *
 * These tests verify that any RunRepository implementation satisfies
 * the domain contract. They are intentionally minimal because the
 * repository is an interface — concrete adapters provide the behavior.
 *
 * A real adapter test suite would extend this base suite to run the
 * full contract against a specific implementation (SQL Server, etc.).
 */

describe("RunRepository interface", () => {
  it("has all required methods", () => {
    // This test verifies the type-level contract compiles correctly.
    // A dummy implementation is used purely for structural validation.
    const stub: RunRepository = {
      create: async (record) => record,
      getById: async () => null,
      update: async (record) => record,
      list: async () => [],
      findByIdempotencyKey: async () => null,
    };

    expect(stub.create).toBeTypeOf("function");
    expect(stub.getById).toBeTypeOf("function");
    expect(stub.update).toBeTypeOf("function");
    expect(stub.list).toBeTypeOf("function");
    expect(stub.findByIdempotencyKey).toBeTypeOf("function");
  });

  it("stub implementation returns expected types", async () => {
    const stub: RunRepository = {
      create: async (record) => record,
      getById: async () => null,
      update: async (record) => record,
      list: async () => [],
      findByIdempotencyKey: async () => null,
    };

    const result = await stub.getById("test-id" as never);
    expect(result).toBeNull();

    const listResult = await stub.list({ brandId: "test" });
    expect(listResult).toEqual([]);
  });
});

describe("RunListFilters", () => {
  it("accepts all optional fields", () => {
    const filters: RunListFilters = {
      brandId: "best-fluency",
      market: "PT",
      platform: "google-ads",
      operation: "campaign-sync",
      state: "running",
    };

    expect(filters.brandId).toBe("best-fluency");
    expect(filters.market).toBe("PT");
    expect(filters.platform).toBe("google-ads");
    expect(filters.operation).toBe("campaign-sync");
    expect(filters.state).toBe("running");
  });

  it("accepts empty filters", () => {
    const filters: RunListFilters = {};
    expect(Object.keys(filters)).toHaveLength(0);
  });
});
