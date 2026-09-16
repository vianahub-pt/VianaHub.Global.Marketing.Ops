import { describe, expect, it } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";

import { adapterContextSchema, buildAdapterContext } from "./adapter-context.js";

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

// ─── buildAdapterContext ─────────────────────────────────────────────────────

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

  it("produces valid context with payload that passes schema validation", () => {
    const record = createValidRunRecord();
    const payload = { listing: { name: "Test" } };
    const context = buildAdapterContext(record, payload);
    const result = adapterContextSchema.safeParse(context);
    expect(result.success).toBe(true);
  });
});
