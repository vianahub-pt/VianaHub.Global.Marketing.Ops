import { describe, expect, it } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "./idempotency.js";
import type { RunError, RunState } from "./run-state.js";
import { INITIAL_STATE } from "./run-state.js";
import { type RunRecord, runRecordSchema } from "./run-record.js";

function createValidRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return {
    schemaVersion: 1,
    runId: "550e8400-e29b-41d4-a716-446655440000" as RunId,
    brandId: "best-fluency",
    market: "PT",
    platform: "google-ads",
    operation: "campaign-sync",
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

describe("RunRecord", () => {
  it("accepts a valid object with all required fields", () => {
    const record = createValidRunRecord();
    const result = runRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
  });

  it("accepts a valid object with optional fields", () => {
    const error: RunError = { message: "timeout", code: "ETIMEDOUT", retryable: true };
    const record = createValidRunRecord({
      state: "failed" as RunState,
      startedAt: new Date("2026-01-01T00:00:01Z"),
      finishedAt: new Date("2026-01-01T00:00:10Z"),
      error,
      metadata: { retryCount: 2 },
    });
    const result = runRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
  });

  it("rejects objects with missing required fields", () => {
    const record = createValidRunRecord();
    const { runId: _runId, ...rest } = record;
    const result = runRecordSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects objects with extra unexpected fields", () => {
    const record = createValidRunRecord({ extraField: "should-not-exist" } as never);
    const result = runRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it("has initial state queued", () => {
    expect(INITIAL_STATE).toBe("queued");
    const record = createValidRunRecord({ state: INITIAL_STATE });
    expect(record.state).toBe("queued");
  });

  it("validates state is a valid RunState value", () => {
    const record = createValidRunRecord({ state: "invalid" as RunState });
    const result = runRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it("validates numeric fields are numbers", () => {
    const record = createValidRunRecord({ attempt: "not-a-number" } as never);
    const result = runRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it("validates date fields are Date objects", () => {
    const record = createValidRunRecord({ createdAt: "not-a-date" } as never);
    const result = runRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });
});
