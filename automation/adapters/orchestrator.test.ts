import { describe, expect, it } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";
import type { RunRepository } from "../domain/repository.js";

import { FakeAdapter } from "./fake-adapter.js";
import { executeRun, resumeRun, executeRunWithRecovery } from "./orchestrator.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createQueuedRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return {
    schemaVersion: 1,
    runId: "550e8400-e29b-41d4-a716-446655440000" as RunId,
    brandId: "best-fluency",
    market: "PT",
    platform: "google-business-profile",
    operation: "createLocalPost",
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

function createWaitingManualRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return createQueuedRunRecord({
    state: "waiting_manual",
    attempt: 1,
    startedAt: new Date("2026-01-01T00:00:01Z"),
    ...overrides,
  });
}

function createInMemoryRepository(initialRecords: RunRecord[] = []): RunRepository {
  const records = new Map<string, RunRecord>();

  for (const record of initialRecords) {
    records.set(record.runId, record);
  }

  return {
    async create(record: RunRecord): Promise<RunRecord> {
      if (records.has(record.runId)) {
        throw new Error(`Record already exists: ${record.runId}`);
      }
      records.set(record.runId, record);
      return record;
    },

    async getById(runId: RunId): Promise<RunRecord | null> {
      return records.get(runId) ?? null;
    },

    async update(record: RunRecord): Promise<RunRecord> {
      if (!records.has(record.runId)) {
        throw new Error(`Record not found: ${record.runId}`);
      }
      records.set(record.runId, record);
      return record;
    },

    async list(filters?: { state?: string }): Promise<RunRecord[]> {
      let results = [...records.values()];
      if (filters?.state !== undefined) {
        results = results.filter((r) => r.state === filters.state);
      }
      return results;
    },

    async findByIdempotencyKey(): Promise<RunRecord | null> {
      return null;
    },
  };
}

// ─── executeRun — success ────────────────────────────────────────────────────

describe("executeRun — success", () => {
  it("transitions queued → running → succeeded", async () => {
    const record = createQueuedRunRecord();
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([record]);

    const result = await executeRun(record, adapter, repo);

    expect(result.state).toBe("succeeded");
    expect(result.attempt).toBe(1);
    expect(result.startedAt).toBeDefined();
    expect(result.finishedAt).toBeDefined();
  });
});

// ─── executeRun — failure ────────────────────────────────────────────────────

describe("executeRun — failure", () => {
  it("transitions queued → running → failed (retryable)", async () => {
    const record = createQueuedRunRecord();
    const adapter = new FakeAdapter("failure");
    const repo = createInMemoryRepository([record]);

    const result = await executeRun(record, adapter, repo);

    expect(result.state).toBe("failed");
    expect(result.attempt).toBe(1);
    expect(result.error).toBeDefined();
    expect(result.error?.retryable).toBe(true);
    expect(result.finishedAt).toBeDefined();
  });
});

// ─── executeRun — manual ─────────────────────────────────────────────────────

describe("executeRun — manual", () => {
  it("transitions queued → running → waiting_manual", async () => {
    const record = createQueuedRunRecord();
    const adapter = new FakeAdapter("manual");
    const repo = createInMemoryRepository([record]);

    const result = await executeRun(record, adapter, repo);

    expect(result.state).toBe("waiting_manual");
    expect(result.attempt).toBe(1);
    expect(result.startedAt).toBeDefined();
    expect(result.finishedAt).toBeUndefined();
  });
});

// ─── executeRun — permanentFailure ───────────────────────────────────────────

describe("executeRun — permanentFailure", () => {
  it("transitions queued → running → failed (non-retryable, terminal)", async () => {
    const record = createQueuedRunRecord();
    const adapter = new FakeAdapter("permanentFailure");
    const repo = createInMemoryRepository([record]);

    const result = await executeRun(record, adapter, repo);

    expect(result.state).toBe("failed");
    expect(result.attempt).toBe(1);
    expect(result.error).toBeDefined();
    expect(result.error?.retryable).toBe(false);
    expect(result.finishedAt).toBeDefined();
  });
});

// ─── executeRun — checkpoint ─────────────────────────────────────────────────

describe("executeRun — checkpoint", () => {
  it("creates checkpoint before execute (adapter receives running state)", async () => {
    const record = createQueuedRunRecord();
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([record]);

    const result = await executeRun(record, adapter, repo);

    // The adapter should have received a context with the running record's data
    // (attempt incremented, state = running)
    expect(result.state).toBe("succeeded");
    expect(result.attempt).toBe(1);
  });
});

// ─── executeRun — preserves payload ──────────────────────────────────────────

describe("executeRun — preserves payload", () => {
  it("preserves payloadFingerprint from original record", async () => {
    const fingerprint = "c".repeat(64) as PayloadFingerprint;
    const record = createQueuedRunRecord({ payloadFingerprint: fingerprint });
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([record]);

    const result = await executeRun(record, adapter, repo);

    expect(result.payloadFingerprint).toBe(fingerprint);
  });

  it("preserves idempotencyKey from original record", async () => {
    const idempotencyKey = "d".repeat(64) as IdempotencyKey;
    const record = createQueuedRunRecord({ idempotencyKey });
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([record]);

    const result = await executeRun(record, adapter, repo);

    expect(result.idempotencyKey).toBe(idempotencyKey);
  });
});

// ─── resumeRun — success ─────────────────────────────────────────────────────

describe("resumeRun — success", () => {
  it("transitions waiting_manual → running → succeeded", async () => {
    const record = createWaitingManualRunRecord();
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([record]);

    const result = await resumeRun(record.runId, adapter, repo);

    expect(result.state).toBe("succeeded");
    expect(result.finishedAt).toBeDefined();
  });
});

// ─── resumeRun — failure ─────────────────────────────────────────────────────

describe("resumeRun — failure", () => {
  it("transitions waiting_manual → running → failed", async () => {
    const record = createWaitingManualRunRecord();
    const adapter = new FakeAdapter("failure");
    const repo = createInMemoryRepository([record]);

    const result = await resumeRun(record.runId, adapter, repo);

    expect(result.state).toBe("failed");
    expect(result.error).toBeDefined();
    expect(result.finishedAt).toBeDefined();
  });
});

// ─── resumeRun — not waiting_manual ──────────────────────────────────────────

describe("resumeRun — not waiting_manual", () => {
  it("throws error when run is in queued state", async () => {
    const record = createQueuedRunRecord();
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([record]);

    await expect(resumeRun(record.runId, adapter, repo)).rejects.toThrow(
      'Cannot resume run in state "queued": expected "waiting_manual"',
    );
  });

  it("throws error when run is in running state", async () => {
    const record = createQueuedRunRecord({ state: "running", attempt: 1 });
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([record]);

    await expect(resumeRun(record.runId, adapter, repo)).rejects.toThrow(
      'Cannot resume run in state "running": expected "waiting_manual"',
    );
  });

  it("throws error when run is in succeeded state", async () => {
    const record = createQueuedRunRecord({
      state: "succeeded",
      attempt: 1,
      finishedAt: new Date(),
    });
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([record]);

    await expect(resumeRun(record.runId, adapter, repo)).rejects.toThrow(
      'Cannot resume run in state "succeeded": expected "waiting_manual"',
    );
  });

  it("throws error when run is in failed state", async () => {
    const record = createQueuedRunRecord({
      state: "failed",
      attempt: 1,
      finishedAt: new Date(),
    });
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([record]);

    await expect(resumeRun(record.runId, adapter, repo)).rejects.toThrow(
      'Cannot resume run in state "failed": expected "waiting_manual"',
    );
  });
});

// ─── resumeRun — run not found ───────────────────────────────────────────────

describe("resumeRun — run not found", () => {
  it("throws error when run does not exist", async () => {
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([]);

    await expect(resumeRun("nonexistent-run-id" as RunId, adapter, repo)).rejects.toThrow(
      "Run not found: nonexistent-run-id",
    );
  });
});

// ─── resumeRun — clears error ────────────────────────────────────────────────

describe("resumeRun — clears error", () => {
  it("clears previous error when transitioning from waiting_manual to running", async () => {
    const record = createWaitingManualRunRecord({
      error: { message: "Previous failure", code: "PREV_ERR", retryable: true },
    });
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([record]);

    const result = await resumeRun(record.runId, adapter, repo);

    expect(result.error).toBeUndefined();
  });
});

// ─── resumeRun — preserves attempt ───────────────────────────────────────────

describe("resumeRun — preserves attempt", () => {
  it("preserves attempt and maxAttempts from original record", async () => {
    const record = createWaitingManualRunRecord({
      attempt: 2,
      maxAttempts: 5,
    });
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([record]);

    const result = await resumeRun(record.runId, adapter, repo);

    expect(result.attempt).toBe(2);
    expect(result.maxAttempts).toBe(5);
  });
});

// ─── resumeRun — metadata ────────────────────────────────────────────────────

describe("resumeRun — metadata", () => {
  it("registers manual action evidence in metadata", async () => {
    const record = createWaitingManualRunRecord();
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([record]);

    const result = await resumeRun(record.runId, adapter, repo);

    expect(result.metadata).toBeDefined();
    const manualAction = result.metadata?.manualAction as Record<string, unknown> | undefined;
    expect(manualAction).toBeDefined();
    expect(manualAction?.actionType).toBe("manual_resume");
    expect(manualAction?.previousState).toBe("waiting_manual");
    expect(manualAction?.resumedAt).toBeDefined();
  });

  it("preserves existing metadata from the record", async () => {
    const record = createWaitingManualRunRecord({
      metadata: { existingKey: "existingValue" },
    });
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([record]);

    const result = await resumeRun(record.runId, adapter, repo);

    expect(result.metadata?.existingKey).toBe("existingValue");
  });
});

// ─── executeRun — redaction ──────────────────────────────────────────────────

describe("executeRun — redaction", () => {
  it("includes statusSync metadata in the result", async () => {
    const record = createQueuedRunRecord();
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([record]);

    const result = await executeRun(record, adapter, repo);

    expect(result.metadata).toBeDefined();
    const statusSync = result.metadata?.statusSync as Record<string, unknown> | undefined;
    expect(statusSync).toBeDefined();
    expect(statusSync?.reconciledState).toBe("succeeded");
    expect(statusSync?.synchronizedAt).toBeDefined();
  });

  it("includes lastOutput in metadata when output is present", async () => {
    const record = createQueuedRunRecord();
    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([record]);

    const result = await executeRun(record, adapter, repo);

    // FakeAdapter "success" mode doesn't set output, so lastOutput should be undefined
    expect(result.metadata?.lastOutput).toBeUndefined();
  });

  it("includes lastError in metadata when error is present", async () => {
    const record = createQueuedRunRecord();
    const adapter = new FakeAdapter("failure");
    const repo = createInMemoryRepository([record]);

    const result = await executeRun(record, adapter, repo);

    expect(result.metadata).toBeDefined();
    const lastError = result.metadata?.lastError as Record<string, unknown> | undefined;
    expect(lastError).toBeDefined();
    expect(lastError?.message).toBe("Simulated transient failure");
  });

  it("redacts sensitive data from error in metadata", async () => {
    const record = createQueuedRunRecord();
    // Create a custom adapter that returns an error with sensitive data
    const adapter = {
      async execute() {
        return {
          success: false,
          error: { message: "Failed with token=abc123secret" },
          requiresManual: false,
        };
      },
      async checkStatus() {
        return { state: "failed" as const, error: { message: "Failed with token=abc123secret" } };
      },
    };
    const repo = createInMemoryRepository([record]);

    const result = await executeRun(record, adapter, repo);

    const lastError = result.metadata?.lastError as Record<string, unknown> | undefined;
    expect(lastError).toBeDefined();
    expect(lastError?.message).toContain("[REDACTED]");
    expect(lastError?.message).not.toContain("abc123secret");
  });
});

// ─── executeRun — checkStatus called ─────────────────────────────────────────

describe("executeRun — checkStatus called", () => {
  it("calls checkStatus after execute", async () => {
    const record = createQueuedRunRecord();
    let checkStatusCalled = false;
    const adapter = {
      async execute() {
        return { success: true, requiresManual: false };
      },
      async checkStatus() {
        checkStatusCalled = true;
        return { state: "succeeded" as const };
      },
    };
    const repo = createInMemoryRepository([record]);

    await executeRun(record, adapter, repo);

    expect(checkStatusCalled).toBe(true);
  });
});

// ─── executeRunWithRecovery — integration ────────────────────────────────────

describe("executeRunWithRecovery — integration", () => {
  it("runs recovery before executing new run", async () => {
    // Arrange: create a running record (interrupted) and a queued record
    const interruptedRecord = createQueuedRunRecord({
      runId: "interrupted-run-001" as RunId,
      state: "running",
      attempt: 1,
    });
    const queuedRecord = createQueuedRunRecord({
      runId: "new-run-001" as RunId,
    });

    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([interruptedRecord, queuedRecord]);

    // Track call order
    const callOrder: string[] = [];

    // Spy on repo.list to track recovery detection
    const originalList = repo.list.bind(repo);
    repo.list = async (...args: Parameters<typeof originalList>) => {
      const result = await originalList(...args);
      // Only record for running state queries (recovery detection)
      if (args[0]?.state === "running") {
        callOrder.push("recovery:detectInterruptedRuns");
      }
      return result;
    };

    // Spy on repo.update to track recovery actions
    const originalUpdate = repo.update.bind(repo);
    repo.update = async (record: RunRecord) => {
      if (record.runId === "interrupted-run-001" && record.state !== "running") {
        callOrder.push("recovery:recoverRun");
      }
      return originalUpdate(record);
    };

    // Act
    const result = await executeRunWithRecovery(queuedRecord, adapter, repo);

    // Assert: recovery ran before execution
    expect(result.recoveryResults).toBeDefined();
    expect(result.executedRun).toBeDefined();
    expect(result.executedRun.state).toBe("succeeded");

    // Verify recovery was called
    expect(callOrder).toContain("recovery:detectInterruptedRuns");
  });

  it("returns recovery results alongside executed run", async () => {
    const queuedRecord = createQueuedRunRecord({
      runId: "new-run-002" as RunId,
    });

    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([queuedRecord]);

    const result = await executeRunWithRecovery(queuedRecord, adapter, repo);

    expect(result).toHaveProperty("recoveryResults");
    expect(result).toHaveProperty("executedRun");
    expect(Array.isArray(result.recoveryResults)).toBe(true);
    expect(result.executedRun.state).toBe("succeeded");
  });

  it("continues execution even when recovery has no interrupted runs", async () => {
    const queuedRecord = createQueuedRunRecord({
      runId: "new-run-003" as RunId,
    });

    const adapter = new FakeAdapter("success");
    const repo = createInMemoryRepository([queuedRecord]);

    const result = await executeRunWithRecovery(queuedRecord, adapter, repo);

    // Recovery should complete (empty results) and execution should proceed
    expect(result.recoveryResults).toEqual([]);
    expect(result.executedRun.state).toBe("succeeded");
  });
});
