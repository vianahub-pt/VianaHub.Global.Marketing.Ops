import { describe, expect, it } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";

import {
  adapterContextSchema,
  adapterResultSchema,
  buildAdapterContext,
  statusCheckResultSchema,
} from "./platform-adapter.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createValidRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return {
    schemaVersion: 1,
    runId: "550e8400-e29b-41d4-a716-446655440000" as RunId,
    brandId: "best-fluency",
    market: "PT",
    platform: "google-business",
    operation: "listing-create",
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

// ─── adapterContextSchema ────────────────────────────────────────────────────

describe("adapterContextSchema", () => {
  it("accepts a valid context", () => {
    const context = {
      runId: "550e8400-e29b-41d4-a716-446655440000",
      brandId: "best-fluency",
      market: "PT",
      platform: "google-business",
      operation: "listing-create",
      payload: { name: "Test" },
      idempotencyKey: "a".repeat(64),
    };
    const result = adapterContextSchema.safeParse(context);
    expect(result.success).toBe(true);
  });

  it("accepts context with undefined payload", () => {
    const context = {
      runId: "550e8400-e29b-41d4-a716-446655440000",
      brandId: "best-fluency",
      market: "PT",
      platform: "google-business",
      operation: "listing-create",
      idempotencyKey: "a".repeat(64),
    };
    const result = adapterContextSchema.safeParse(context);
    expect(result.success).toBe(true);
  });

  it("rejects context with token field", () => {
    const context = {
      runId: "550e8400-e29b-41d4-a716-446655440000",
      brandId: "best-fluency",
      market: "PT",
      platform: "google-business",
      operation: "listing-create",
      token: "sensitive-value",
      idempotencyKey: "a".repeat(64),
    };
    const result = adapterContextSchema.safeParse(context);
    expect(result.success).toBe(false);
  });

  it("rejects context with secret field", () => {
    const context = {
      runId: "550e8400-e29b-41d4-a716-446655440000",
      brandId: "best-fluency",
      market: "PT",
      platform: "google-business",
      operation: "listing-create",
      secret: "my-secret",
      idempotencyKey: "a".repeat(64),
    };
    const result = adapterContextSchema.safeParse(context);
    expect(result.success).toBe(false);
  });

  it("rejects context with password field", () => {
    const context = {
      runId: "550e8400-e29b-41d4-a716-446655440000",
      brandId: "best-fluency",
      market: "PT",
      platform: "google-business",
      operation: "listing-create",
      password: "123456",
      idempotencyKey: "a".repeat(64),
    };
    const result = adapterContextSchema.safeParse(context);
    expect(result.success).toBe(false);
  });

  it("rejects context with cookie field", () => {
    const context = {
      runId: "550e8400-e29b-41d4-a716-446655440000",
      brandId: "best-fluency",
      market: "PT",
      platform: "google-business",
      operation: "listing-create",
      cookie: "session=abc123",
      idempotencyKey: "a".repeat(64),
    };
    const result = adapterContextSchema.safeParse(context);
    expect(result.success).toBe(false);
  });

  it("rejects context with api_key field", () => {
    const context = {
      runId: "550e8400-e29b-41d4-a716-446655440000",
      brandId: "best-fluency",
      market: "PT",
      platform: "google-business",
      operation: "listing-create",
      api_key: "AKIA1234567890",
      idempotencyKey: "a".repeat(64),
    };
    const result = adapterContextSchema.safeParse(context);
    expect(result.success).toBe(false);
  });

  it("rejects context with missing required fields", () => {
    const context = {
      runId: "550e8400-e29b-41d4-a716-446655440000",
    };
    const result = adapterContextSchema.safeParse(context);
    expect(result.success).toBe(false);
  });

  it("rejects context with extra fields", () => {
    const context = {
      runId: "550e8400-e29b-41d4-a716-446655440000",
      brandId: "best-fluency",
      market: "PT",
      platform: "google-business",
      operation: "listing-create",
      idempotencyKey: "a".repeat(64),
      extraField: "not-allowed",
    };
    const result = adapterContextSchema.safeParse(context);
    expect(result.success).toBe(false);
  });
});

// ─── adapterResultSchema ─────────────────────────────────────────────────────

describe("adapterResultSchema", () => {
  it("accepts a valid success result", () => {
    const result = adapterResultSchema.safeParse({
      success: true,
      output: { listingUrl: "https://example.com" },
      requiresManual: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid failure result with error", () => {
    const result = adapterResultSchema.safeParse({
      success: false,
      error: { message: "timeout", code: "ETIMEDOUT", retryable: true },
      requiresManual: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid manual result", () => {
    const result = adapterResultSchema.safeParse({
      success: false,
      requiresManual: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects result with extra fields", () => {
    const result = adapterResultSchema.safeParse({
      success: true,
      requiresManual: false,
      extraField: "not-allowed",
    });
    expect(result.success).toBe(false);
  });
});

// ─── statusCheckResultSchema ─────────────────────────────────────────────────

describe("statusCheckResultSchema", () => {
  it("accepts a valid status result with succeeded state", () => {
    const result = statusCheckResultSchema.safeParse({
      state: "succeeded",
      output: { listingUrl: "https://example.com" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid status result with failed state and error", () => {
    const result = statusCheckResultSchema.safeParse({
      state: "failed",
      error: { message: "not found", code: "NOT_FOUND" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid status result with running state", () => {
    const result = statusCheckResultSchema.safeParse({
      state: "running",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid state", () => {
    const result = statusCheckResultSchema.safeParse({
      state: "invalid-state",
    });
    expect(result.success).toBe(false);
  });

  it("rejects result with extra fields", () => {
    const result = statusCheckResultSchema.safeParse({
      state: "succeeded",
      extraField: "not-allowed",
    });
    expect(result.success).toBe(false);
  });
});

// ─── buildAdapterContext ──────────────────────────────────────────────────────

describe("buildAdapterContext", () => {
  it("extracts runId from RunRecord", () => {
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    expect(context.runId).toBe(record.runId);
  });

  it("extracts brandId from RunRecord", () => {
    const record = createValidRunRecord({ brandId: "gerit" });
    const context = buildAdapterContext(record);
    expect(context.brandId).toBe("gerit");
  });

  it("extracts market from RunRecord", () => {
    const record = createValidRunRecord({ market: "BR" });
    const context = buildAdapterContext(record);
    expect(context.market).toBe("BR");
  });

  it("extracts platform from RunRecord", () => {
    const record = createValidRunRecord({ platform: "cylex-pt" });
    const context = buildAdapterContext(record);
    expect(context.platform).toBe("cylex-pt");
  });

  it("extracts operation from RunRecord", () => {
    const record = createValidRunRecord({ operation: "listing-update" });
    const context = buildAdapterContext(record);
    expect(context.operation).toBe("listing-update");
  });

  it("extracts idempotencyKey from RunRecord", () => {
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    expect(context.idempotencyKey).toBe(record.idempotencyKey);
  });

  it("sets payload to undefined when not provided", () => {
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    expect(context.payload).toBeUndefined();
  });

  it("sets payload when provided", () => {
    const record = createValidRunRecord();
    const payload = { name: "Test Business", city: "Lisboa" };
    const context = buildAdapterContext(record, payload);
    expect(context.payload).toEqual(payload);
  });

  it("produces a valid AdapterContext that passes schema validation", () => {
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const result = adapterContextSchema.safeParse(context);
    expect(result.success).toBe(true);
  });
});
