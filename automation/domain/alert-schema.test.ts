import { describe, expect, it } from "vitest";
import {
  createAlertId,
  createAlertEntry,
  alertEntrySchema,
  ALERT_SEVERITIES,
  ALERT_CATEGORIES,
} from "./alert-schema.js";

describe("createAlertEntry", () => {
  // --- AC-27: creates entry with all required fields ---
  it("creates entry with all required fields", () => {
    const alert = createAlertEntry({
      severity: "error",
      category: "recovery",
      message: "Recovery failed",
      correlationIds: { runId: "run-123" },
    });

    expect(alert.alertId).toBeDefined();
    expect(typeof alert.alertId).toBe("string");
    expect(alert.timestamp).toBeInstanceOf(Date);
    expect(alert.severity).toBe("error");
    expect(alert.category).toBe("recovery");
    expect(alert.message).toBe("Recovery failed");
    expect(alert.correlationIds).toEqual({ runId: "run-123" });
  });

  // --- AC-27: uses injectable Clock for deterministic timestamp ---
  it("uses injectable Clock for deterministic timestamp", () => {
    const fixedDate = new Date("2026-09-22T10:00:00.000Z");
    const clock = { now: () => fixedDate };

    const alert = createAlertEntry({
      severity: "info",
      category: "system",
      message: "System started",
      correlationIds: {},
      clock,
    });

    expect(alert.timestamp).toEqual(fixedDate);
  });

  // --- AC-28: severity accepts all 4 levels ---
  it.each(ALERT_SEVERITIES)("accepts severity '%s'", (severity) => {
    const alert = createAlertEntry({
      severity,
      category: "system",
      message: `Severity ${severity} test`,
      correlationIds: {},
    });

    expect(alert.severity).toBe(severity);
  });

  // --- AC-27: deduplicationKey is optional ---
  it("accepts entry without deduplicationKey", () => {
    const alert = createAlertEntry({
      severity: "warn",
      category: "lock",
      message: "Lock contention",
      correlationIds: {},
    });

    expect(alert.deduplicationKey).toBeUndefined();
  });

  // --- AC-27: deduplicationKey is accepted when provided ---
  it("accepts entry with deduplicationKey", () => {
    const alert = createAlertEntry({
      severity: "warn",
      category: "lock",
      message: "Lock contention",
      correlationIds: {},
      deduplicationKey: "lock-contention-abc",
    });

    expect(alert.deduplicationKey).toBe("lock-contention-abc");
  });

  // --- AC-29: suppressedCount is optional ---
  it("accepts entry without suppressedCount", () => {
    const alert = createAlertEntry({
      severity: "error",
      category: "batch",
      message: "Batch failed",
      correlationIds: {},
    });

    expect(alert.suppressedCount).toBeUndefined();
  });

  // --- AC-29: suppressedCount is accepted when provided ---
  it("accepts entry with suppressedCount", () => {
    const alert = createAlertEntry({
      severity: "error",
      category: "batch",
      message: "Batch failed",
      correlationIds: {},
      suppressedCount: 5,
    });

    expect(alert.suppressedCount).toBe(5);
  });
});

describe("alertEntrySchema", () => {
  // --- AC-27: validates correct entry ---
  it("validates correct entry", () => {
    const entry = {
      alertId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-22T10:00:00.000Z"),
      severity: "error" as const,
      category: "recovery" as const,
      message: "Recovery failed",
      correlationIds: { runId: "run-123" },
    };

    const result = alertEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  // --- AC-28: rejects invalid severity ---
  it("rejects invalid severity", () => {
    const entry = {
      alertId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-22T10:00:00.000Z"),
      severity: "debug", // valor inválido, não existe em ALERT_SEVERITIES
      category: "recovery" as const,
      message: "Recovery failed",
      correlationIds: {},
    };

    const result = alertEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  // --- AC-27: rejects unknown fields (strict) ---
  it("rejects unknown fields", () => {
    const entry = {
      alertId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-22T10:00:00.000Z"),
      severity: "info" as const,
      category: "system" as const,
      message: "System started",
      correlationIds: {},
      unknownField: "should-fail",
    };

    const result = alertEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  // --- AC-27: accepts entry with optional deduplicationKey ---
  it("accepts entry with optional deduplicationKey", () => {
    const entry = {
      alertId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-22T10:00:00.000Z"),
      severity: "warn" as const,
      category: "lock" as const,
      message: "Lock contention",
      correlationIds: {},
      deduplicationKey: "lock-abc",
    };

    const result = alertEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  // --- AC-29: accepts entry with optional suppressedCount ---
  it("accepts entry with optional suppressedCount", () => {
    const entry = {
      alertId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-22T10:00:00.000Z"),
      severity: "error" as const,
      category: "batch" as const,
      message: "Batch failed",
      correlationIds: {},
      suppressedCount: 3,
    };

    const result = alertEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  // --- AC-29: rejects negative suppressedCount ---
  it("rejects negative suppressedCount", () => {
    const entry = {
      alertId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-22T10:00:00.000Z"),
      severity: "error" as const,
      category: "batch" as const,
      message: "Batch failed",
      correlationIds: {},
      suppressedCount: -1,
    };

    const result = alertEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });
});

describe("createAlertId", () => {
  it("returns a branded AlertId", () => {
    const id = createAlertId();
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

describe("ALERT_SEVERITIES and ALERT_CATEGORIES", () => {
  it("defines all expected alert severities", () => {
    expect(ALERT_SEVERITIES).toEqual(["info", "warn", "error", "critical"]);
  });

  it("defines all expected alert categories", () => {
    expect(ALERT_CATEGORIES).toEqual(["recovery", "lock", "schedule", "batch", "system", "pilot"]);
  });
});
