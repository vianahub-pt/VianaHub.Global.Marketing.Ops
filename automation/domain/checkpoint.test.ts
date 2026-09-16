import { describe, expect, it } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "./idempotency.js";
import type { RunRecord } from "./run-record.js";
import { createCheckpoint, type Checkpoint } from "./checkpoint.js";

function createRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return {
    schemaVersion: 1,
    runId: "550e8400-e29b-41d4-a716-446655440000" as RunId,
    brandId: "best-fluency",
    market: "PT",
    platform: "google-ads",
    operation: "campaign-sync",
    state: "running",
    attempt: 2,
    maxAttempts: 3,
    idempotencyKey: "a".repeat(64) as IdempotencyKey,
    payloadFingerprint: "b".repeat(64) as PayloadFingerprint,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("createCheckpoint", () => {
  it("creates a checkpoint with correct runId", () => {
    const record = createRunRecord();
    const checkpoint = createCheckpoint(record, { step: "validate" });

    expect(checkpoint.runId).toBe(record.runId);
  });

  it("creates a checkpoint with correct state", () => {
    const record = createRunRecord({ state: "running" });
    const checkpoint = createCheckpoint(record, {});

    expect(checkpoint.state).toBe("running");
  });

  it("creates a checkpoint with correct attempt number", () => {
    const record = createRunRecord({ attempt: 3 });
    const checkpoint = createCheckpoint(record, {});

    expect(checkpoint.attempt).toBe(3);
  });

  it("creates a checkpoint with the provided payload", () => {
    const record = createRunRecord();
    const payload = { step: "api-call", retries: 2, endpoint: "/sync" };
    const checkpoint = createCheckpoint(record, payload);

    expect(checkpoint.payload).toEqual(payload);
  });

  it("creates a checkpoint with a Date for createdAt", () => {
    const record = createRunRecord();
    const checkpoint = createCheckpoint(record, {});

    expect(checkpoint.createdAt).toBeInstanceOf(Date);
  });

  it("createdAt is recent (within 1 second)", () => {
    const record = createRunRecord();
    const before = Date.now();
    const checkpoint = createCheckpoint(record, {});
    const after = Date.now();

    expect(checkpoint.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(checkpoint.createdAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("handles empty payload", () => {
    const record = createRunRecord();
    const checkpoint = createCheckpoint(record, {});

    expect(checkpoint.payload).toEqual({});
  });

  it("handles nested payload", () => {
    const record = createRunRecord();
    const payload = {
      level1: { level2: { level3: "deep-value" } },
      array: [1, 2, 3],
    };
    const checkpoint = createCheckpoint(record, payload);

    expect(checkpoint.payload).toEqual(payload);
  });

  it("returns a readonly-compatible checkpoint (interface contract)", () => {
    const record = createRunRecord();
    const checkpoint: Checkpoint = createCheckpoint(record, { key: "value" });

    // Verify all properties are present
    expect(checkpoint).toHaveProperty("runId");
    expect(checkpoint).toHaveProperty("state");
    expect(checkpoint).toHaveProperty("attempt");
    expect(checkpoint).toHaveProperty("payload");
    expect(checkpoint).toHaveProperty("createdAt");
  });

  it("does not reference the original record (immutability)", () => {
    const record = createRunRecord({ state: "queued", attempt: 0 });
    const checkpoint = createCheckpoint(record, {});

    // Mutate the record after checkpoint creation
    record.state = "running";
    record.attempt = 1;

    // Checkpoint should not be affected
    expect(checkpoint.state).toBe("queued");
    expect(checkpoint.attempt).toBe(0);
  });
});
