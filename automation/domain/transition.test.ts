import { describe, expect, it } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "./idempotency.js";
import type { RunError, RunState } from "./run-state.js";
import type { RunRecord } from "./run-record.js";
import { transitionRunState, type TransitionContext } from "./transition.js";

function createRunRecord(overrides?: Partial<RunRecord>): RunRecord {
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

function createContext(
  current: RunRecord,
  targetState: RunState,
  error?: RunError,
): TransitionContext {
  return { current, targetState, error };
}

describe("transitionRunState", () => {
  describe("valid transitions", () => {
    it("queued -> running increments attempt from 0 to 1", () => {
      const record = createRunRecord({ state: "queued", attempt: 0 });
      const result = transitionRunState(createContext(record, "running"));

      expect(result.state).toBe("running");
      expect(result.attempt).toBe(1);
      expect(result.startedAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
    });

    it("queued -> running increments attempt from 1 to 2", () => {
      const record = createRunRecord({ state: "queued", attempt: 1 });
      const result = transitionRunState(createContext(record, "running"));

      expect(result.state).toBe("running");
      expect(result.attempt).toBe(2);
    });

    it("queued -> cancelled sets finishedAt", () => {
      const record = createRunRecord({ state: "queued" });
      const result = transitionRunState(createContext(record, "cancelled"));

      expect(result.state).toBe("cancelled");
      expect(result.finishedAt).toBeInstanceOf(Date);
    });

    it("running -> waiting_manual sets state", () => {
      const record = createRunRecord({ state: "running", attempt: 1 });
      const result = transitionRunState(createContext(record, "waiting_manual"));

      expect(result.state).toBe("waiting_manual");
      expect(result.finishedAt).toBeUndefined();
    });

    it("running -> succeeded sets finishedAt", () => {
      const record = createRunRecord({ state: "running", attempt: 1 });
      const result = transitionRunState(createContext(record, "succeeded"));

      expect(result.state).toBe("succeeded");
      expect(result.finishedAt).toBeInstanceOf(Date);
    });

    it("running -> failed sets finishedAt and error", () => {
      const record = createRunRecord({ state: "running", attempt: 1 });
      const error: RunError = { message: "timeout", retryable: true };
      const result = transitionRunState(createContext(record, "failed", error));

      expect(result.state).toBe("failed");
      expect(result.finishedAt).toBeInstanceOf(Date);
      expect(result.error).toEqual(error);
    });

    it("running -> cancelled sets finishedAt", () => {
      const record = createRunRecord({ state: "running", attempt: 1 });
      const result = transitionRunState(createContext(record, "cancelled"));

      expect(result.state).toBe("cancelled");
      expect(result.finishedAt).toBeInstanceOf(Date);
    });

    it("waiting_manual -> running clears error", () => {
      const record = createRunRecord({
        state: "waiting_manual",
        attempt: 1,
        error: { message: "needs approval" },
      });
      const result = transitionRunState(createContext(record, "running"));

      expect(result.state).toBe("running");
      expect(result.error).toBeUndefined();
    });

    it("waiting_manual -> failed sets error", () => {
      const record = createRunRecord({ state: "waiting_manual", attempt: 1 });
      const error: RunError = { message: "abandoned", retryable: false };
      const result = transitionRunState(createContext(record, "failed", error));

      expect(result.state).toBe("failed");
      expect(result.finishedAt).toBeInstanceOf(Date);
      expect(result.error).toEqual(error);
    });

    it("waiting_manual -> cancelled sets finishedAt", () => {
      const record = createRunRecord({ state: "waiting_manual", attempt: 1 });
      const result = transitionRunState(createContext(record, "cancelled"));

      expect(result.state).toBe("cancelled");
      expect(result.finishedAt).toBeInstanceOf(Date);
    });

    it("failed -> queued retries when retryable and attempt < maxAttempts", () => {
      const record = createRunRecord({
        state: "failed",
        attempt: 1,
        maxAttempts: 3,
        error: { message: "timeout", retryable: true },
      });
      const result = transitionRunState(createContext(record, "queued"));

      expect(result.state).toBe("queued");
      expect(result.attempt).toBe(1);
    });

    it("failed -> queued retries on last attempt when retryable", () => {
      const record = createRunRecord({
        state: "failed",
        attempt: 2,
        maxAttempts: 3,
        error: { message: "timeout", retryable: true },
      });
      const result = transitionRunState(createContext(record, "queued"));

      expect(result.state).toBe("queued");
      expect(result.attempt).toBe(2);
    });
  });

  describe("invalid transitions throw errors", () => {
    it("queued -> waiting_manual is invalid", () => {
      const record = createRunRecord({ state: "queued" });
      expect(() => transitionRunState(createContext(record, "waiting_manual"))).toThrow(
        'Invalid transition from "queued" to "waiting_manual"',
      );
    });

    it("queued -> succeeded is invalid", () => {
      const record = createRunRecord({ state: "queued" });
      expect(() => transitionRunState(createContext(record, "succeeded"))).toThrow(
        'Invalid transition from "queued" to "succeeded"',
      );
    });

    it("queued -> failed is invalid", () => {
      const record = createRunRecord({ state: "queued" });
      expect(() => transitionRunState(createContext(record, "failed"))).toThrow(
        'Invalid transition from "queued" to "failed"',
      );
    });

    it("running -> queued is invalid", () => {
      const record = createRunRecord({ state: "running", attempt: 1 });
      expect(() => transitionRunState(createContext(record, "queued"))).toThrow(
        'Invalid transition from "running" to "queued"',
      );
    });

    it("waiting_manual -> queued is invalid", () => {
      const record = createRunRecord({ state: "waiting_manual", attempt: 1 });
      expect(() => transitionRunState(createContext(record, "queued"))).toThrow(
        'Invalid transition from "waiting_manual" to "queued"',
      );
    });

    it("waiting_manual -> succeeded is invalid", () => {
      const record = createRunRecord({ state: "waiting_manual", attempt: 1 });
      expect(() => transitionRunState(createContext(record, "succeeded"))).toThrow(
        'Invalid transition from "waiting_manual" to "succeeded"',
      );
    });

    it("failed -> running is invalid", () => {
      const record = createRunRecord({ state: "failed", attempt: 1 });
      expect(() => transitionRunState(createContext(record, "running"))).toThrow(
        'Invalid transition from "failed" to "running"',
      );
    });

    it("failed -> waiting_manual is invalid", () => {
      const record = createRunRecord({ state: "failed", attempt: 1 });
      expect(() => transitionRunState(createContext(record, "waiting_manual"))).toThrow(
        'Invalid transition from "failed" to "waiting_manual"',
      );
    });

    it("failed -> succeeded is invalid", () => {
      const record = createRunRecord({ state: "failed", attempt: 1 });
      expect(() => transitionRunState(createContext(record, "succeeded"))).toThrow(
        'Invalid transition from "failed" to "succeeded"',
      );
    });

    it("failed -> cancelled is invalid", () => {
      const record = createRunRecord({ state: "failed", attempt: 1 });
      expect(() => transitionRunState(createContext(record, "cancelled"))).toThrow(
        'Invalid transition from "failed" to "cancelled"',
      );
    });
  });

  describe("terminal states", () => {
    it("succeeded does not allow any transition", () => {
      const record = createRunRecord({ state: "succeeded", attempt: 3 });

      expect(() => transitionRunState(createContext(record, "queued"))).toThrow(
        "Cannot transition from terminal state",
      );
      expect(() => transitionRunState(createContext(record, "running"))).toThrow(
        "Cannot transition from terminal state",
      );
      expect(() => transitionRunState(createContext(record, "waiting_manual"))).toThrow(
        "Cannot transition from terminal state",
      );
      expect(() => transitionRunState(createContext(record, "failed"))).toThrow(
        "Cannot transition from terminal state",
      );
      expect(() => transitionRunState(createContext(record, "cancelled"))).toThrow(
        "Cannot transition from terminal state",
      );
    });

    it("cancelled does not allow any transition", () => {
      const record = createRunRecord({ state: "cancelled", attempt: 1 });

      expect(() => transitionRunState(createContext(record, "queued"))).toThrow(
        "Cannot transition from terminal state",
      );
      expect(() => transitionRunState(createContext(record, "running"))).toThrow(
        "Cannot transition from terminal state",
      );
      expect(() => transitionRunState(createContext(record, "waiting_manual"))).toThrow(
        "Cannot transition from terminal state",
      );
      expect(() => transitionRunState(createContext(record, "failed"))).toThrow(
        "Cannot transition from terminal state",
      );
      expect(() => transitionRunState(createContext(record, "succeeded"))).toThrow(
        "Cannot transition from terminal state",
      );
    });
  });

  describe("retry rules", () => {
    it("failed -> queued rejects when error is not retryable", () => {
      const record = createRunRecord({
        state: "failed",
        attempt: 1,
        maxAttempts: 3,
      });
      const error: RunError = { message: "auth failed", retryable: false };

      expect(() => transitionRunState(createContext(record, "queued", error))).toThrow(
        "Cannot retry",
      );
    });

    it("failed -> queued rejects when no error provided", () => {
      const record = createRunRecord({
        state: "failed",
        attempt: 1,
        maxAttempts: 3,
      });

      expect(() => transitionRunState(createContext(record, "queued"))).toThrow("Cannot retry");
    });

    it("failed -> queued rejects when attempt equals maxAttempts", () => {
      const record = createRunRecord({
        state: "failed",
        attempt: 3,
        maxAttempts: 3,
      });
      const error: RunError = { message: "timeout", retryable: true };

      expect(() => transitionRunState(createContext(record, "queued", error))).toThrow(
        "Cannot retry",
      );
    });

    it("failed -> queued rejects when attempt exceeds maxAttempts", () => {
      const record = createRunRecord({
        state: "failed",
        attempt: 4,
        maxAttempts: 3,
      });
      const error: RunError = { message: "timeout", retryable: true };

      expect(() => transitionRunState(createContext(record, "queued", error))).toThrow(
        "Cannot retry",
      );
    });
  });

  describe("attempt management", () => {
    it("attempt increments correctly on queued -> running", () => {
      const record = createRunRecord({ state: "queued", attempt: 0 });
      const result = transitionRunState(createContext(record, "running"));

      expect(result.attempt).toBe(1);
    });

    it("attempt does not change on other transitions", () => {
      const record = createRunRecord({ state: "running", attempt: 2 });
      const result = transitionRunState(createContext(record, "succeeded"));

      expect(result.attempt).toBe(2);
    });

    it("attempt does not change on failed -> queued retry", () => {
      const record = createRunRecord({
        state: "failed",
        attempt: 2,
        maxAttempts: 3,
      });
      const error: RunError = { message: "timeout", retryable: true };
      const result = transitionRunState(createContext(record, "queued", error));

      expect(result.attempt).toBe(2);
    });
  });

  describe("waiting_manual behavior", () => {
    it("waiting_manual is reached from running only", () => {
      const record = createRunRecord({ state: "running", attempt: 1 });
      const result = transitionRunState(createContext(record, "waiting_manual"));

      expect(result.state).toBe("waiting_manual");
    });

    it("waiting_manual requires human intervention to leave", () => {
      const record = createRunRecord({
        state: "waiting_manual",
        attempt: 1,
        error: { message: "needs approval" },
      });
      const result = transitionRunState(createContext(record, "running"));

      expect(result.state).toBe("running");
      expect(result.error).toBeUndefined();
    });
  });

  describe("updatedAt is always updated", () => {
    it("updates updatedAt on every valid transition", () => {
      const before = new Date("2026-01-01T00:00:00Z");
      const record = createRunRecord({ state: "queued", updatedAt: before });
      const result = transitionRunState(createContext(record, "running"));

      expect(result.updatedAt.getTime()).toBeGreaterThan(before.getTime());
    });
  });

  describe("immutability", () => {
    it("returns a new record without mutating the original", () => {
      const record = createRunRecord({ state: "queued", attempt: 0 });
      const original = { ...record };
      transitionRunState(createContext(record, "running"));

      expect(record.state).toBe(original.state);
      expect(record.attempt).toBe(original.attempt);
    });
  });
});
