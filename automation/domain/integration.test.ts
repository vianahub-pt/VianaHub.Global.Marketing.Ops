import { describe, expect, it } from "vitest";

import type { IdempotencyKey, PayloadFingerprint } from "./idempotency.js";
import { createRunId, computeIdempotencyKey, fingerprintPayload } from "./idempotency.js";
import type { RunError, RunState } from "./run-state.js";
import { INITIAL_STATE } from "./run-state.js";
import type { RunRecord } from "./run-record.js";
import { transitionRunState, type TransitionContext } from "./transition.js";
import { redactError, redactLog } from "./redaction.js";
import { createCheckpoint, type Checkpoint } from "./checkpoint.js";
import type { RunRepository } from "./repository.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function createRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return {
    schemaVersion: 1,
    runId: createRunId(),
    brandId: "best-fluency",
    market: "PT",
    platform: "google-ads",
    operation: "campaign-sync",
    state: INITIAL_STATE,
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

// ─── In-memory repository for integration tests ─────────────────────────────

function createInMemoryRepository(): RunRepository {
  const store = new Map<string, RunRecord>();

  return {
    create: async (record) => {
      if (store.has(record.runId)) {
        throw new Error(`Record with runId ${record.runId} already exists`);
      }
      store.set(record.runId, record);
      return record;
    },
    getById: async (runId) => {
      return store.get(runId) ?? null;
    },
    update: async (record) => {
      if (!store.has(record.runId)) {
        throw new Error(`Record with runId ${record.runId} not found`);
      }
      store.set(record.runId, record);
      return record;
    },
    list: async (filters) => {
      let results = Array.from(store.values());
      if (filters) {
        if (filters.brandId) {
          results = results.filter((r) => r.brandId === filters.brandId);
        }
        if (filters.market) {
          results = results.filter((r) => r.market === filters.market);
        }
        if (filters.platform) {
          results = results.filter((r) => r.platform === filters.platform);
        }
        if (filters.operation) {
          results = results.filter((r) => r.operation === filters.operation);
        }
        if (filters.state) {
          results = results.filter((r) => r.state === filters.state);
        }
      }
      return results;
    },
    findByIdempotencyKey: async (key) => {
      for (const record of store.values()) {
        if (record.idempotencyKey === key) {
          return record;
        }
      }
      return null;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Integration Tests — Full Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: Full lifecycle", () => {
  it("creates RunRecord → transits states → succeeds", async () => {
    const repo = createInMemoryRepository();
    const record = createRunRecord();

    // 1. Create
    const created = await repo.create(record);
    expect(created.state).toBe("queued");

    // 2. Start → running
    const running = transitionRunState(createContext(created, "running"));
    await repo.update(running);
    expect(running.state).toBe("running");
    expect(running.attempt).toBe(1);
    expect(running.startedAt).toBeInstanceOf(Date);

    // 3. Complete → succeeded
    const succeeded = transitionRunState(createContext(running, "succeeded"));
    await repo.update(succeeded);
    expect(succeeded.state).toBe("succeeded");
    expect(succeeded.finishedAt).toBeInstanceOf(Date);

    // 4. Verify persisted state
    const stored = await repo.getById(record.runId);
    expect(stored).not.toBeNull();
    expect(stored!.state).toBe("succeeded");
  });

  it("creates RunRecord → transits states → fails", async () => {
    const repo = createInMemoryRepository();
    const record = createRunRecord();

    const created = await repo.create(record);

    const running = transitionRunState(createContext(created, "running"));
    await repo.update(running);

    const error: RunError = { message: "API timeout", retryable: false, code: "ETIMEDOUT" };
    const failed = transitionRunState(createContext(running, "failed", error));
    await repo.update(failed);

    expect(failed.state).toBe("failed");
    expect(failed.error).toEqual(error);
    expect(failed.finishedAt).toBeInstanceOf(Date);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Integration Tests — Recovery after failure
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: Recovery after failure", () => {
  it("failed → queued → running (retryable error with attempts remaining)", async () => {
    const repo = createInMemoryRepository();
    const record = createRunRecord({ maxAttempts: 3 });

    const created = await repo.create(record);

    // First attempt: queued → running → failed
    const running1 = transitionRunState(createContext(created, "running"));
    expect(running1.attempt).toBe(1);

    const retryableError: RunError = { message: "Network timeout", retryable: true };
    const failed1 = transitionRunState(createContext(running1, "failed", retryableError));
    await repo.update(failed1);
    expect(failed1.state).toBe("failed");

    // Recovery: failed → queued (retryable, attempt 1 < maxAttempts 3)
    const recovered = transitionRunState(createContext(failed1, "queued", retryableError));
    await repo.update(recovered);
    expect(recovered.state).toBe("queued");
    expect(recovered.attempt).toBe(1);

    // Second attempt: queued → running
    const running2 = transitionRunState(createContext(recovered, "running"));
    await repo.update(running2);
    expect(running2.state).toBe("running");
    expect(running2.attempt).toBe(2);
    expect(running2.startedAt).toBeInstanceOf(Date);
  });

  it("failed is terminal when no retryable error is provided", async () => {
    const repo = createInMemoryRepository();
    const record = createRunRecord({ maxAttempts: 3 });

    const created = await repo.create(record);
    const running = transitionRunState(createContext(created, "running"));

    const nonRetryableError: RunError = { message: "Auth failed", retryable: false };
    const failed = transitionRunState(createContext(running, "failed", nonRetryableError));
    await repo.update(failed);

    // Cannot retry: non-retryable
    expect(() => transitionRunState(createContext(failed, "queued", nonRetryableError))).toThrow(
      "Cannot retry",
    );
  });

  it("failed is terminal when attempt equals maxAttempts", async () => {
    const repo = createInMemoryRepository();
    const record = createRunRecord({ maxAttempts: 1 });

    const created = await repo.create(record);
    const running = transitionRunState(createContext(created, "running"));
    expect(running.attempt).toBe(1);

    const retryableError: RunError = { message: "Timeout", retryable: true };
    const failed = transitionRunState(createContext(running, "failed", retryableError));
    await repo.update(failed);

    // Cannot retry: attempt (1) equals maxAttempts (1)
    expect(() => transitionRunState(createContext(failed, "queued", retryableError))).toThrow(
      "Cannot retry",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Integration Tests — Retry with maxAttempts
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: Retry with maxAttempts", () => {
  it("retries up to maxAttempts then fails permanently", async () => {
    const repo = createInMemoryRepository();
    const record = createRunRecord({ maxAttempts: 2 });

    const created = await repo.create(record);

    // Attempt 1: queued(0) → running(1) → failed
    const running1 = transitionRunState(createContext(created, "running"));
    expect(running1.attempt).toBe(1);

    const error: RunError = { message: "Error", retryable: true };
    const failed1 = transitionRunState(createContext(running1, "failed", error));

    // Attempt 2: failed(1) → queued(1) → running(2) → failed
    const queued2 = transitionRunState(createContext(failed1, "queued", error));
    expect(queued2.attempt).toBe(1);

    const running2 = transitionRunState(createContext(queued2, "running"));
    expect(running2.attempt).toBe(2);

    const failed2 = transitionRunState(createContext(running2, "failed", error));

    // Attempt 3: blocked — attempt (2) equals maxAttempts (2)
    expect(() => transitionRunState(createContext(failed2, "queued", error))).toThrow(
      "Cannot retry",
    );

    await repo.update(failed2);
    const stored = await repo.getById(record.runId);
    expect(stored!.state).toBe("failed");
    expect(stored!.attempt).toBe(2);
  });

  it("increments attempt correctly through retry cycle", async () => {
    const record = createRunRecord({ maxAttempts: 5 });
    const error: RunError = { message: "Timeout", retryable: true };

    // queued(0) → running(1)
    let current = transitionRunState(createContext(record, "running"));
    expect(current.attempt).toBe(1);

    // running(1) → failed(1) → queued(1) → running(2)
    current = transitionRunState(createContext(current, "failed", error));
    current = transitionRunState(createContext(current, "queued", error));
    current = transitionRunState(createContext(current, "running"));
    expect(current.attempt).toBe(2);

    // running(2) → failed(2) → queued(2) → running(3)
    current = transitionRunState(createContext(current, "failed", error));
    current = transitionRunState(createContext(current, "queued", error));
    current = transitionRunState(createContext(current, "running"));
    expect(current.attempt).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Integration Tests — Redaction in transition errors
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: Redaction in transition errors", () => {
  it("redacts sensitive data from error stored in transition", async () => {
    const record = createRunRecord();

    const running = transitionRunState(createContext(record, "running"));

    const sensitiveError: RunError = {
      message:
        "Connection failed: password=SuperSecret123 and token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      code: "CONN_ERR",
      retryable: false,
    };

    const failed = transitionRunState(createContext(running, "failed", sensitiveError));

    // Error is stored as-is (redaction happens at display/log layer)
    expect(failed.error!.message).toContain("SuperSecret123");

    // When redacted:
    const redacted = redactError(failed.error!);
    expect(redacted.message).not.toContain("SuperSecret123");
    expect(redacted.message).toContain("[REDACTED]");
    expect(redacted.code).toBe("CONN_ERR");
  });

  it("redacts sensitive data from log entries during state transitions", async () => {
    const record = createRunRecord();
    const running = transitionRunState(createContext(record, "running"));

    const logEntry = {
      level: "error",
      message: "Transition failed",
      detail: "Bearer eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE2",
      runId: running.runId,
    };

    const redacted = redactLog(logEntry);
    const detail = redacted.detail as string;
    expect(detail).toContain("[REDACTED]");
    expect(detail).not.toContain("eyJhbGciOiJSUzI1NiJ9");
  });

  it("preserves non-sensitive error details through redaction", async () => {
    const record = createRunRecord();
    const running = transitionRunState(createContext(record, "running"));

    const cleanError: RunError = {
      message: "Network timeout after 30 seconds",
      code: "ETIMEDOUT",
      retryable: true,
    };

    const failed = transitionRunState(createContext(running, "failed", cleanError));
    const redacted = redactError(failed.error!);

    expect(redacted.message).toBe("Network timeout after 30 seconds");
    expect(redacted.code).toBe("ETIMEDOUT");
    expect(redacted.retryable).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Integration Tests — Checkpoint from RunRecord
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: Checkpoint from RunRecord", () => {
  it("creates checkpoint capturing state at a specific point in the lifecycle", async () => {
    const repo = createInMemoryRepository();
    const record = createRunRecord();

    const created = await repo.create(record);

    // Checkpoint at queued
    const checkpointQueued = createCheckpoint(created, { step: "initialized" });
    expect(checkpointQueued.state).toBe("queued");
    expect(checkpointQueued.attempt).toBe(0);

    // Transition to running
    const running = transitionRunState(createContext(created, "running"));
    await repo.update(running);

    // Checkpoint at running
    const checkpointRunning = createCheckpoint(running, { step: "api-call", endpoint: "/sync" });
    expect(checkpointRunning.state).toBe("running");
    expect(checkpointRunning.attempt).toBe(1);
    expect(checkpointRunning.payload).toEqual({ step: "api-call", endpoint: "/sync" });

    // Transition to succeeded
    const succeeded = transitionRunState(createContext(running, "succeeded"));
    await repo.update(succeeded);

    // Verify both checkpoints are independent of final state
    expect(checkpointQueued.state).toBe("queued");
    expect(checkpointRunning.state).toBe("running");
    expect(succeeded.state).toBe("succeeded");
  });

  it("checkpoint payload is serializable (JSON round-trip)", () => {
    const record = createRunRecord({ state: "running", attempt: 2 });
    const payload = { step: "validate", retries: 5, nested: { key: "value" } };
    const checkpoint = createCheckpoint(record, payload);

    const serialized = JSON.stringify(checkpoint);
    const deserialized = JSON.parse(serialized) as Checkpoint;

    expect(deserialized.runId).toBe(checkpoint.runId);
    expect(deserialized.state).toBe("running");
    expect(deserialized.attempt).toBe(2);
    expect(deserialized.payload).toEqual(payload);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Integration Tests — Idempotency + Repository
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: Idempotency + Repository", () => {
  it("generates consistent idempotency keys and finds records by key", async () => {
    const repo = createInMemoryRepository();
    const identity = {
      brandId: "best-fluency",
      market: "PT",
      platform: "google-ads",
      operation: "campaign-sync",
    };
    const payload = { campaignId: "camp-123", action: "update" };

    const idempotencyKey = computeIdempotencyKey(identity, payload);
    const payloadFingerprint = fingerprintPayload(payload);

    const record = createRunRecord({ idempotencyKey, payloadFingerprint });
    await repo.create(record);

    const found = await repo.findByIdempotencyKey(idempotencyKey);
    expect(found).not.toBeNull();
    expect(found!.runId).toBe(record.runId);

    // Different key should not find it
    const otherKey = computeIdempotencyKey(identity, { campaignId: "camp-456" });
    const notFound = await repo.findByIdempotencyKey(otherKey);
    expect(notFound).toBeNull();
  });

  it("creates and retrieves a record via repository", async () => {
    const repo = createInMemoryRepository();
    const record = createRunRecord();

    await repo.create(record);
    const found = await repo.getById(record.runId);

    expect(found).not.toBeNull();
    expect(found!.brandId).toBe("best-fluency");
    expect(found!.market).toBe("PT");
  });

  it("lists records with filters", async () => {
    const repo = createInMemoryRepository();

    const r1 = createRunRecord({ brandId: "best-fluency", state: "queued" });
    const r2 = createRunRecord({ brandId: "best-fluency", state: "running" });
    const r3 = createRunRecord({ brandId: "other-brand", state: "queued" });

    await repo.create(r1);
    await repo.create(r2);
    await repo.create(r3);

    const bfRecords = await repo.list({ brandId: "best-fluency" });
    expect(bfRecords).toHaveLength(2);

    const queuedRecords = await repo.list({ state: "queued" });
    expect(queuedRecords).toHaveLength(2);

    const specificRecords = await repo.list({ brandId: "best-fluency", state: "running" });
    expect(specificRecords).toHaveLength(1);
  });

  it("fails to create duplicate runId", async () => {
    const repo = createInMemoryRepository();
    const record = createRunRecord();

    await repo.create(record);
    await expect(repo.create(record)).rejects.toThrow("already exists");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Integration Tests — waiting_manual → running recovery
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: waiting_manual recovery", () => {
  it("runs → waiting_manual → running → succeeds after manual approval", async () => {
    const repo = createInMemoryRepository();
    const record = createRunRecord();

    const created = await repo.create(record);

    // queued → running
    const running1 = transitionRunState(createContext(created, "running"));
    await repo.update(running1);

    // running → waiting_manual (needs human approval)
    const waiting = transitionRunState(createContext(running1, "waiting_manual"));
    await repo.update(waiting);
    expect(waiting.state).toBe("waiting_manual");

    // Verify error is preserved if it was set
    const waitingWithError = createRunRecord({
      state: "waiting_manual",
      attempt: 1,
      error: { message: "Approval needed" },
    });
    expect(waitingWithError.error).toBeDefined();

    // Human approves: waiting_manual → running
    const running2 = transitionRunState(createContext(waiting, "running"));
    await repo.update(running2);
    expect(running2.state).toBe("running");
    expect(running2.error).toBeUndefined(); // error cleared

    // running → succeeded
    const succeeded = transitionRunState(createContext(running2, "succeeded"));
    await repo.update(succeeded);
    expect(succeeded.state).toBe("succeeded");

    const final = await repo.getById(record.runId);
    expect(final!.state).toBe("succeeded");
  });

  it("running → waiting_manual → failed (abandoned)", async () => {
    const record = createRunRecord();

    const running = transitionRunState(createContext(record, "running"));
    const waiting = transitionRunState(createContext(running, "waiting_manual"));

    const abandonError: RunError = { message: "Manual step abandoned", retryable: false };
    const failed = transitionRunState(createContext(waiting, "failed", abandonError));

    expect(failed.state).toBe("failed");
    expect(failed.error).toEqual(abandonError);
    expect(failed.finishedAt).toBeInstanceOf(Date);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Integration Tests — Cancellation paths
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: Cancellation paths", () => {
  it("cancels from queued state", async () => {
    const record = createRunRecord();
    const cancelled = transitionRunState(createContext(record, "cancelled"));

    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.finishedAt).toBeInstanceOf(Date);
  });

  it("cancels from running state", async () => {
    const record = createRunRecord({ state: "queued" });
    const running = transitionRunState(createContext(record, "running"));
    const cancelled = transitionRunState(createContext(running, "cancelled"));

    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.finishedAt).toBeInstanceOf(Date);
  });

  it("cancels from waiting_manual state", async () => {
    const record = createRunRecord({ state: "queued" });
    const running = transitionRunState(createContext(record, "running"));
    const waiting = transitionRunState(createContext(running, "waiting_manual"));
    const cancelled = transitionRunState(createContext(waiting, "cancelled"));

    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.finishedAt).toBeInstanceOf(Date);
  });

  it("cannot transition after cancellation (terminal)", async () => {
    const record = createRunRecord();
    const cancelled = transitionRunState(createContext(record, "cancelled"));

    expect(() => transitionRunState(createContext(cancelled, "queued"))).toThrow(
      "Cannot transition from terminal state",
    );
    expect(() => transitionRunState(createContext(cancelled, "running"))).toThrow(
      "Cannot transition from terminal state",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Integration Tests — Metadata preservation
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: Metadata preservation", () => {
  it("preserves metadata through state transitions", () => {
    const record = createRunRecord({
      metadata: { correlationId: "corr-abc", userId: "user-42" },
    });

    const running = transitionRunState(createContext(record, "running"));
    expect(running.metadata).toEqual({ correlationId: "corr-abc", userId: "user-42" });

    const succeeded = transitionRunState(createContext(running, "succeeded"));
    expect(succeeded.metadata).toEqual({ correlationId: "corr-abc", userId: "user-42" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Integration Tests — Immutability across full flows
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: Immutability", () => {
  it("original record is never mutated by transitions", () => {
    const original = createRunRecord({ state: "queued", attempt: 0 });
    const snapshot = { ...original };

    const running = transitionRunState(createContext(original, "running"));

    // Original unchanged
    expect(original.state).toBe(snapshot.state);
    expect(original.attempt).toBe(snapshot.attempt);
    expect(original.updatedAt).toBe(snapshot.updatedAt);

    // Running is a new object
    expect(running).not.toBe(original);
    expect(running.state).toBe("running");
    expect(running.attempt).toBe(1);
  });

  it("checkpoint does not reference mutated record", () => {
    const record = createRunRecord({ state: "running", attempt: 1 });
    const checkpoint = createCheckpoint(record, { step: "snapshot" });

    // Mutate record after checkpoint
    record.state = "succeeded";
    record.attempt = 5;

    // Checkpoint unaffected
    expect(checkpoint.state).toBe("running");
    expect(checkpoint.attempt).toBe(1);
  });
});
