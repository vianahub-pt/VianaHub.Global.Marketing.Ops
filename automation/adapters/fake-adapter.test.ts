import { describe, expect, it } from "vitest";

import type { IdempotencyKey, RunId } from "../domain/idempotency.js";
import type { AdapterContext } from "./platform-adapter.js";

import { FakeAdapter } from "./fake-adapter.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createContext(overrides?: Partial<AdapterContext>): AdapterContext {
  return {
    runId: "550e8400-e29b-41d4-a716-446655440000" as RunId,
    brandId: "best-fluency",
    market: "PT",
    platform: "google-business",
    operation: "listing-create",
    payload: { name: "Test Business" },
    idempotencyKey: "a".repeat(64) as IdempotencyKey,
    ...overrides,
  };
}

// ─── execute — success mode ──────────────────────────────────────────────────

describe("FakeAdapter — success mode", () => {
  it("execute() returns success: true", async () => {
    const adapter = new FakeAdapter("success");
    const context = createContext();
    const result = await adapter.execute(context);
    expect(result.success).toBe(true);
    expect(result.requiresManual).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("checkStatus() returns succeeded after execute()", async () => {
    const adapter = new FakeAdapter("success");
    const context = createContext();
    await adapter.execute(context);
    const status = await adapter.checkStatus(context.runId);
    expect(status.state).toBe("succeeded");
  });
});

// ─── execute — failure mode ──────────────────────────────────────────────────

describe("FakeAdapter — failure mode", () => {
  it("execute() returns success: false with retryable error", async () => {
    const adapter = new FakeAdapter("failure");
    const context = createContext();
    const result = await adapter.execute(context);
    expect(result.success).toBe(false);
    expect(result.requiresManual).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.message).toBe("Simulated transient failure");
    expect(result.error?.code).toBe("FAKE_TRANSIENT");
  });

  it("checkStatus() returns failed after execute()", async () => {
    const adapter = new FakeAdapter("failure");
    const context = createContext();
    await adapter.execute(context);
    const status = await adapter.checkStatus(context.runId);
    expect(status.state).toBe("failed");
    expect(status.error).toBeDefined();
    expect(status.error?.retryable).toBe(true);
  });
});

// ─── execute — manual mode ───────────────────────────────────────────────────

describe("FakeAdapter — manual mode", () => {
  it("execute() returns requiresManual: true", async () => {
    const adapter = new FakeAdapter("manual");
    const context = createContext();
    const result = await adapter.execute(context);
    expect(result.success).toBe(false);
    expect(result.requiresManual).toBe(true);
  });

  it("checkStatus() returns waiting_manual after execute()", async () => {
    const adapter = new FakeAdapter("manual");
    const context = createContext();
    await adapter.execute(context);
    const status = await adapter.checkStatus(context.runId);
    expect(status.state).toBe("waiting_manual");
  });
});

// ─── execute — permanentFailure mode ─────────────────────────────────────────

describe("FakeAdapter — permanentFailure mode", () => {
  it("execute() returns success: false with non-retryable error", async () => {
    const adapter = new FakeAdapter("permanentFailure");
    const context = createContext();
    const result = await adapter.execute(context);
    expect(result.success).toBe(false);
    expect(result.requiresManual).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.message).toBe("Simulated permanent failure");
    expect(result.error?.code).toBe("FAKE_PERMANENT");
  });

  it("checkStatus() returns failed after execute()", async () => {
    const adapter = new FakeAdapter("permanentFailure");
    const context = createContext();
    await adapter.execute(context);
    const status = await adapter.checkStatus(context.runId);
    expect(status.state).toBe("failed");
    expect(status.error).toBeDefined();
    expect(status.error?.retryable).toBe(false);
  });
});

// ─── checkStatus — before execute ────────────────────────────────────────────

describe("FakeAdapter — checkStatus before execute", () => {
  it("returns queued when no execute() has been called", async () => {
    const adapter = new FakeAdapter("success");
    const runId = "550e8400-e29b-41d4-a716-446655440000" as RunId;
    const status = await adapter.checkStatus(runId);
    expect(status.state).toBe("queued");
  });
});

// ─── determinism ─────────────────────────────────────────────────────────────

describe("FakeAdapter — determinism", () => {
  it("same input produces same output for success mode", async () => {
    const adapter = new FakeAdapter("success");
    const context = createContext();
    const result1 = await adapter.execute(context);
    const result2 = await adapter.execute(context);
    expect(result1).toEqual(result2);
  });

  it("same input produces same output for failure mode", async () => {
    const adapter = new FakeAdapter("failure");
    const context = createContext();
    const result1 = await adapter.execute(context);
    const result2 = await adapter.execute(context);
    expect(result1).toEqual(result2);
  });

  it("same input produces same output for manual mode", async () => {
    const adapter = new FakeAdapter("manual");
    const context = createContext();
    const result1 = await adapter.execute(context);
    const result2 = await adapter.execute(context);
    expect(result1).toEqual(result2);
  });

  it("same input produces same output for permanentFailure mode", async () => {
    const adapter = new FakeAdapter("permanentFailure");
    const context = createContext();
    const result1 = await adapter.execute(context);
    const result2 = await adapter.execute(context);
    expect(result1).toEqual(result2);
  });
});

// ─── no sensitive data ──────────────────────────────────────────────────────

describe("FakeAdapter — no sensitive data", () => {
  it("does not generate tokens, secrets, or credentials in any mode", async () => {
    const modes = ["success", "failure", "manual", "permanentFailure"] as const;
    const sensitivePatterns = [
      /token/i,
      /secret/i,
      /password/i,
      /cookie/i,
      /api[_-]?key/i,
      /credential/i,
      /authorization/i,
      /bearer/i,
    ];

    for (const mode of modes) {
      const adapter = new FakeAdapter(mode);
      const context = createContext();
      const result = await adapter.execute(context);
      const serialized = JSON.stringify(result);

      for (const pattern of sensitivePatterns) {
        expect(serialized).not.toMatch(pattern);
      }

      const status = await adapter.checkStatus(context.runId);
      const statusSerialized = JSON.stringify(status);

      for (const pattern of sensitivePatterns) {
        expect(statusSerialized).not.toMatch(pattern);
      }
    }
  });
});

// ─── default mode ────────────────────────────────────────────────────────────

describe("FakeAdapter — default constructor", () => {
  it("defaults to success mode when no mode is provided", async () => {
    const adapter = new FakeAdapter();
    const context = createContext();
    const result = await adapter.execute(context);
    expect(result.success).toBe(true);
    expect(result.requiresManual).toBe(false);
  });
});
