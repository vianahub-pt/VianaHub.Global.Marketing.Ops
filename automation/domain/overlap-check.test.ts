import { describe, expect, it } from "vitest";

import { InMemoryRunRepository } from "../adapters/in-memory-repo.js";
import { createRunId, computeIdempotencyKey, type PayloadFingerprint } from "./idempotency.js";
import type { RunRecord } from "./run-record.js";
import { checkOverlap } from "./overlap-check.js";

const TEST_IDENTITY = {
  brandId: "best-fluency",
  market: "PT",
  platform: "google-ads",
  operation: "campaign-sync",
};

const TEST_PAYLOAD = { campaignId: "123", budget: 1000 };

function createRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  const key = computeIdempotencyKey(TEST_IDENTITY, TEST_PAYLOAD);
  return {
    schemaVersion: 1,
    runId: createRunId(),
    brandId: TEST_IDENTITY.brandId,
    market: TEST_IDENTITY.market,
    platform: TEST_IDENTITY.platform,
    operation: TEST_IDENTITY.operation,
    state: "queued",
    attempt: 1,
    maxAttempts: 3,
    idempotencyKey: key,
    payloadFingerprint: "c".repeat(64) as PayloadFingerprint,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("checkOverlap", () => {
  it("returns false when no run exists", async () => {
    const repo = new InMemoryRunRepository();
    const key = computeIdempotencyKey(TEST_IDENTITY, TEST_PAYLOAD);
    const result = await checkOverlap(repo, key);

    expect(result).toBe(false);
  });

  it("returns true when queued run exists", async () => {
    const repo = new InMemoryRunRepository();
    const key = computeIdempotencyKey(TEST_IDENTITY, TEST_PAYLOAD);
    const record = createRunRecord({ state: "queued", idempotencyKey: key });
    await repo.create(record);

    const result = await checkOverlap(repo, key);
    expect(result).toBe(true);
  });

  it("returns true when running run exists", async () => {
    const repo = new InMemoryRunRepository();
    const key = computeIdempotencyKey(TEST_IDENTITY, TEST_PAYLOAD);
    const record = createRunRecord({ state: "running", idempotencyKey: key });
    await repo.create(record);

    const result = await checkOverlap(repo, key);
    expect(result).toBe(true);
  });

  it("returns false when succeeded run exists", async () => {
    const repo = new InMemoryRunRepository();
    const key = computeIdempotencyKey(TEST_IDENTITY, TEST_PAYLOAD);
    const record = createRunRecord({ state: "succeeded", idempotencyKey: key });
    await repo.create(record);

    const result = await checkOverlap(repo, key);
    expect(result).toBe(false);
  });

  it("returns false when failed run exists", async () => {
    const repo = new InMemoryRunRepository();
    const key = computeIdempotencyKey(TEST_IDENTITY, TEST_PAYLOAD);
    const record = createRunRecord({ state: "failed", idempotencyKey: key });
    await repo.create(record);

    const result = await checkOverlap(repo, key);
    expect(result).toBe(false);
  });

  it("returns false when cancelled run exists", async () => {
    const repo = new InMemoryRunRepository();
    const key = computeIdempotencyKey(TEST_IDENTITY, TEST_PAYLOAD);
    const record = createRunRecord({ state: "cancelled", idempotencyKey: key });
    await repo.create(record);

    const result = await checkOverlap(repo, key);
    expect(result).toBe(false);
  });

  it("returns false when existing run has a different idempotency key", async () => {
    const repo = new InMemoryRunRepository();
    const key = computeIdempotencyKey(TEST_IDENTITY, TEST_PAYLOAD);
    const otherPayload = { campaignId: "456", budget: 2000 };
    const otherKey = computeIdempotencyKey(TEST_IDENTITY, otherPayload);
    const record = createRunRecord({ state: "queued", idempotencyKey: otherKey });
    await repo.create(record);

    const result = await checkOverlap(repo, key);
    expect(result).toBe(false);
  });

  it("never throws on repository errors (fail-closed)", async () => {
    const repo = new InMemoryRunRepository();
    // Override to simulate a database error
    repo.findByIdempotencyKey = async () => {
      throw new Error("database connection failed");
    };

    const key = computeIdempotencyKey(TEST_IDENTITY, TEST_PAYLOAD);
    const result = await checkOverlap(repo, key);

    // Fail-closed: on error, assume overlap exists
    expect(result).toBe(true);
  });
});
