import { describe, expect, it } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";
import type { PlatformAdapter, StatusCheckResult } from "./platform-adapter.js";

import { InMemoryRunRepository } from "./in-memory-repo.js";
import { executeRun } from "./orchestrator.js";
import { detectInterruptedRuns, recoverRun, recoveryLoop } from "./recovery.js";
import { FakeAdapter } from "./fake-adapter.js";

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

// ─── T-07: Interrupção simulada + restart + recuperação ─────────────────────

describe("T-07: Recovery — interrupção simulada + restart + recuperação", () => {
  it("simula interrupção: run fica em running, recovery detecta e recupera para succeeded", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord({ maxAttempts: 3 });
    await repo.create(record);

    // Step 1: Start execution (transitions queued → running)
    const runningAdapter = {
      async execute() {
        // Simulate: adapter starts but process is "killed" before completion
        // The run is now in "running" state in the repo
        return { success: true, requiresManual: false };
      },
      async checkStatus(): Promise<StatusCheckResult> {
        // Remote confirms it succeeded
        return { state: "succeeded" };
      },
    };

    // Execute normally — this transitions to running and then processes result
    const result = await executeRun(record, runningAdapter, repo);
    expect(result.state).toBe("succeeded");

    // Verify no interrupted runs remain
    const interrupted = await detectInterruptedRuns(repo);
    expect(interrupted).toHaveLength(0);
  });

  it("simula interrupção: run fica em running, recovery detecta e recupera para queued (retry)", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord({ maxAttempts: 3 });
    await repo.create(record);

    // Manually set record to running state (simulating interruption during execution)
    const runningRecord: RunRecord = {
      ...record,
      state: "running",
      attempt: 1,
      startedAt: new Date(),
      updatedAt: new Date(),
    };
    await repo.update(runningRecord);

    // Step 2: Detect interrupted runs
    const interrupted = await detectInterruptedRuns(repo);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0].state).toBe("running");

    // Step 3: Recover — adapter says remote failed retryable
    const recoveryAdapter = createAdapterWithStatus({
      state: "failed",
      error: { message: "Timeout", retryable: true },
    });
    const recovered = await recoverRun(interrupted[0], recoveryAdapter, repo);

    // Should be queued for retry
    expect(recovered.state).toBe("queued");
    expect(recovered.attempt).toBe(1); // attempt preserved

    // Step 4: Can now execute again
    const successAdapter = new FakeAdapter("success");
    const finalResult = await executeRun(recovered, successAdapter, repo);

    expect(finalResult.state).toBe("succeeded");
    expect(finalResult.attempt).toBe(2); // incremented by executeRun
  });

  it("simula interrupção: recoveryLoop processa múltiplos runs interrompidos", async () => {
    const repo = new InMemoryRunRepository();

    // Create 3 runs in running state (simulating 3 interrupted processes)
    for (let i = 1; i <= 3; i++) {
      const record = createQueuedRunRecord({
        runId: `run-${i}` as RunId,
        attempt: 1,
        maxAttempts: 3,
      });
      await repo.create(record);

      // Simulate interruption by setting to running
      const runningRecord: RunRecord = {
        ...record,
        state: "running",
        attempt: 1,
        startedAt: new Date(),
        updatedAt: new Date(),
      };
      await repo.update(runningRecord);
    }

    // All 3 should be detected as interrupted
    const interrupted = await detectInterruptedRuns(repo);
    expect(interrupted).toHaveLength(3);

    // Recovery adapter says all succeeded remotely
    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const results = await recoveryLoop(adapter, repo);

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.newState).toBe("succeeded");
    }

    // No more interrupted runs
    const remaining = await detectInterruptedRuns(repo);
    expect(remaining).toHaveLength(0);
  });

  it("simula interrupção: run fica em running, recovery detecta e preserva waiting_manual", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord({
      attempt: 1,
      maxAttempts: 3,
    });
    await repo.create(record);

    // Simulate interruption during execution
    const runningRecord: RunRecord = {
      ...record,
      state: "running",
      attempt: 1,
      startedAt: new Date(),
      updatedAt: new Date(),
    };
    await repo.update(runningRecord);

    // Detect interrupted
    const interrupted = await detectInterruptedRuns(repo);
    expect(interrupted).toHaveLength(1);

    // Adapter says remote needs manual intervention
    const adapter = createAdapterWithStatus({ state: "waiting_manual" });
    const recovered = await recoverRun(interrupted[0], adapter, repo);

    // Should be in waiting_manual
    expect(recovered.state).toBe("waiting_manual");

    // Should NOT be detected as interrupted anymore (only running is detected)
    const remaining = await detectInterruptedRuns(repo);
    expect(remaining).toHaveLength(0);
  });

  it("simula interrupção: recoveryLoop com adapter null deixa runs em running", async () => {
    const repo = new InMemoryRunRepository();

    // Create 2 runs in running state
    for (let i = 1; i <= 2; i++) {
      const record = createQueuedRunRecord({
        runId: `run-${i}` as RunId,
        attempt: 1,
        maxAttempts: 3,
      });
      await repo.create(record);

      const runningRecord: RunRecord = {
        ...record,
        state: "running",
        attempt: 1,
        startedAt: new Date(),
        updatedAt: new Date(),
      };
      await repo.update(runningRecord);
    }

    // Recovery with null adapter — ambiguous, leave running
    const results = await recoveryLoop(null, repo);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.newState).toBe("running");
      expect(result.action).toBe("leave_running");
    }

    // Runs still in running state
    const remaining = await detectInterruptedRuns(repo);
    expect(remaining).toHaveLength(2);
  });
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function createAdapterWithStatus(status: StatusCheckResult): PlatformAdapter {
  return {
    async execute() {
      return { success: true, requiresManual: false };
    },
    async checkStatus(): Promise<StatusCheckResult> {
      return status;
    },
  };
}

function createFailedRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return {
    schemaVersion: 1,
    runId: "550e8400-e29b-41d4-a716-446655440000" as RunId,
    brandId: "best-fluency",
    market: "PT",
    platform: "google-business-profile",
    operation: "createLocalPost",
    state: "failed",
    attempt: 1,
    maxAttempts: 3,
    idempotencyKey: "a".repeat(64) as IdempotencyKey,
    payloadFingerprint: "b".repeat(64) as PayloadFingerprint,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    finishedAt: new Date("2026-01-01T00:00:05Z"),
    error: { message: "Timeout", retryable: true },
    ...overrides,
  };
}

// ─── HUMAN-005: Recovery de failed retryable ──────────────────────────────────

describe("HUMAN-005: Recovery de failed retryable", () => {
  it("detectInterruptedRuns inclui failed retryable e recoverRun transita failed → queued", async () => {
    const repo = new InMemoryRunRepository();

    // Create a failed retryable run (simulating a previous failed execution)
    const failedRecord = createFailedRunRecord({
      runId: "run-failed-1" as RunId,
      attempt: 1,
      maxAttempts: 3,
      error: { message: "Timeout", retryable: true },
    });
    await repo.create(failedRecord);

    // detectInterruptedRuns should find it
    const interrupted = await detectInterruptedRuns(repo);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0].state).toBe("failed");

    // recoverRun should transition failed → queued
    const recovered = await recoverRun(interrupted[0], null, repo);
    expect(recovered.state).toBe("queued");
    expect(recovered.attempt).toBe(1); // attempt preserved

    // Can now execute again
    const successAdapter = new FakeAdapter("success");
    const finalResult = await executeRun(recovered, successAdapter, repo);

    expect(finalResult.state).toBe("succeeded");
    expect(finalResult.attempt).toBe(2); // incremented by executeRun
  });

  it("recoveryLoop processa failed retryable junto com running", async () => {
    const repo = new InMemoryRunRepository();

    // Create a running run
    const runningRecord = createQueuedRunRecord({
      runId: "run-running" as RunId,
      attempt: 1,
      maxAttempts: 3,
    });
    await repo.create(runningRecord);
    const runningUpdate: RunRecord = {
      ...runningRecord,
      state: "running",
      startedAt: new Date(),
      updatedAt: new Date(),
    };
    await repo.update(runningUpdate);

    // Create a failed retryable run
    const failedRecord = createFailedRunRecord({
      runId: "run-failed" as RunId,
      attempt: 1,
      maxAttempts: 3,
      error: { message: "Timeout", retryable: true },
    });
    await repo.create(failedRecord);

    // detectInterruptedRuns should find both
    const interrupted = await detectInterruptedRuns(repo);
    expect(interrupted).toHaveLength(2);
    expect(interrupted.map((r) => r.state).sort()).toEqual(["failed", "running"]);

    // recoveryLoop should process both
    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const results = await recoveryLoop(adapter, repo);

    expect(results).toHaveLength(2);
    const runRunningResult = results.find((r) => r.runId === "run-running");
    const runFailedResult = results.find((r) => r.runId === "run-failed");
    expect(runRunningResult?.newState).toBe("succeeded");
    expect(runFailedResult?.newState).toBe("queued");
  });

  it("não inclui failed non-retryable na detecção", async () => {
    const repo = new InMemoryRunRepository();

    // Create a failed non-retryable run
    const failedNonRetryable = createFailedRunRecord({
      runId: "run-failed-nr" as RunId,
      attempt: 1,
      maxAttempts: 3,
      error: { message: "Auth failed", retryable: false },
    });
    await repo.create(failedNonRetryable);

    // detectInterruptedRuns should NOT find it
    const interrupted = await detectInterruptedRuns(repo);
    expect(interrupted).toHaveLength(0);
  });

  it("não inclui failed com attempt >= maxAttempts na detecção", async () => {
    const repo = new InMemoryRunRepository();

    // Create a failed run with max attempts reached
    const failedMaxAttempts = createFailedRunRecord({
      runId: "run-failed-ma" as RunId,
      attempt: 3,
      maxAttempts: 3,
      error: { message: "Timeout", retryable: true },
    });
    await repo.create(failedMaxAttempts);

    // detectInterruptedRuns should NOT find it
    const interrupted = await detectInterruptedRuns(repo);
    expect(interrupted).toHaveLength(0);
  });

  it("preserva waiting_manual mesmo com failed retryable presente", async () => {
    const repo = new InMemoryRunRepository();

    // Create a waiting_manual run
    const waitingRecord = createQueuedRunRecord({
      runId: "run-waiting" as RunId,
      state: "waiting_manual",
    });
    await repo.create(waitingRecord);

    // Create a failed retryable run
    const failedRecord = createFailedRunRecord({
      runId: "run-failed" as RunId,
      attempt: 1,
      maxAttempts: 3,
      error: { message: "Timeout", retryable: true },
    });
    await repo.create(failedRecord);

    // recoveryLoop should process both
    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const results = await recoveryLoop(adapter, repo);

    expect(results).toHaveLength(2);
    const waitingResult = results.find((r) => r.runId === "run-waiting");
    const failedResult = results.find((r) => r.runId === "run-failed");
    expect(waitingResult?.newState).toBe("waiting_manual"); // preserved
    expect(failedResult?.newState).toBe("queued"); // recovered
  });
});
