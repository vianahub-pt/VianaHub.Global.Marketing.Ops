import { describe, expect, it } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";
import type { RunState } from "../domain/run-state.js";
import type { PlatformAdapter, StatusCheckResult } from "./platform-adapter.js";

import { InMemoryRunRepository } from "./in-memory-repo.js";
import { detectInterruptedRuns, recoverRun, recoveryLoop } from "./recovery.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createRunningRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return {
    schemaVersion: 1,
    runId: "550e8400-e29b-41d4-a716-446655440000" as RunId,
    brandId: "best-fluency",
    market: "PT",
    platform: "google-business-profile",
    operation: "createLocalPost",
    state: "running",
    attempt: 1,
    maxAttempts: 3,
    idempotencyKey: "a".repeat(64) as IdempotencyKey,
    payloadFingerprint: "b".repeat(64) as PayloadFingerprint,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    startedAt: new Date("2026-01-01T00:00:01Z"),
    ...overrides,
  };
}

function createQueuedRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return createRunningRunRecord({
    state: "queued",
    attempt: 0,
    startedAt: undefined,
    ...overrides,
  });
}

function createFailedRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return createRunningRunRecord({
    state: "failed",
    finishedAt: new Date(),
    error: { message: "Test error", retryable: true },
    ...overrides,
  });
}

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

function createAdapterThatThrows(): PlatformAdapter {
  return {
    async execute() {
      return { success: true, requiresManual: false };
    },
    async checkStatus(): Promise<StatusCheckResult> {
      throw new Error("Remote API unavailable");
    },
  };
}

// ─── T-04: detectInterruptedRuns ─────────────────────────────────────────────

describe("detectInterruptedRuns", () => {
  it("RR-01: retorna todos os RunRecord em estado running", async () => {
    const repo = new InMemoryRunRepository();
    const running1 = createRunningRunRecord({
      runId: "run-1" as RunId,
    });
    const running2 = createRunningRunRecord({
      runId: "run-2" as RunId,
    });
    const queued = createQueuedRunRecord({
      runId: "run-3" as RunId,
    });

    await repo.create(running1);
    await repo.create(running2);
    await repo.create(queued);

    const interrupted = await detectInterruptedRuns(repo);

    expect(interrupted).toHaveLength(2);
    expect(interrupted.map((r) => r.runId).sort()).toEqual(["run-1", "run-2"]);
  });

  it("retorna array vazio quando não há runs interrompidos", async () => {
    const repo = new InMemoryRunRepository();
    const queued = createQueuedRunRecord();
    await repo.create(queued);

    const interrupted = await detectInterruptedRuns(repo);

    expect(interrupted).toHaveLength(0);
  });

  it("retorna array vazio quando repositório está vazio", async () => {
    const repo = new InMemoryRunRepository();

    const interrupted = await detectInterruptedRuns(repo);

    expect(interrupted).toHaveLength(0);
  });

  it("não inclui runs em estados terminais", async () => {
    const repo = new InMemoryRunRepository();
    const succeeded = createRunningRunRecord({
      runId: "run-s" as RunId,
      state: "succeeded",
      finishedAt: new Date(),
    });
    const cancelled = createRunningRunRecord({
      runId: "run-c" as RunId,
      state: "cancelled",
      finishedAt: new Date(),
    });

    await repo.create(succeeded);
    await repo.create(cancelled);

    const interrupted = await detectInterruptedRuns(repo);

    expect(interrupted).toHaveLength(0);
  });

  it("não inclui runs em estado failed", async () => {
    const repo = new InMemoryRunRepository();
    const failed = createRunningRunRecord({
      runId: "run-f" as RunId,
      state: "failed",
      finishedAt: new Date(),
      error: { message: "Test error" },
    });

    await repo.create(failed);

    const interrupted = await detectInterruptedRuns(repo);

    expect(interrupted).toHaveLength(0);
  });

  it("inclui runs failed com error.retryable=true e attempt < maxAttempts", async () => {
    const repo = new InMemoryRunRepository();
    const failedRetryable = createFailedRunRecord({
      runId: "run-fr" as RunId,
      attempt: 1,
      maxAttempts: 3,
      error: { message: "Timeout", retryable: true },
    });

    await repo.create(failedRetryable);

    const interrupted = await detectInterruptedRuns(repo);

    expect(interrupted).toHaveLength(1);
    expect(interrupted[0].runId).toBe("run-fr");
    expect(interrupted[0].state).toBe("failed");
  });

  it("não inclui runs failed com error.retryable=false", async () => {
    const repo = new InMemoryRunRepository();
    const failedNonRetryable = createFailedRunRecord({
      runId: "run-fnr" as RunId,
      attempt: 1,
      maxAttempts: 3,
      error: { message: "Auth failed", retryable: false },
    });

    await repo.create(failedNonRetryable);

    const interrupted = await detectInterruptedRuns(repo);

    expect(interrupted).toHaveLength(0);
  });

  it("não inclui runs failed com attempt >= maxAttempts", async () => {
    const repo = new InMemoryRunRepository();
    const failedMaxAttempts = createFailedRunRecord({
      runId: "run-fma" as RunId,
      attempt: 3,
      maxAttempts: 3,
      error: { message: "Timeout", retryable: true },
    });

    await repo.create(failedMaxAttempts);

    const interrupted = await detectInterruptedRuns(repo);

    expect(interrupted).toHaveLength(0);
  });

  it("inclui mix de running e failed retryable", async () => {
    const repo = new InMemoryRunRepository();
    const running = createRunningRunRecord({ runId: "run-1" as RunId });
    const failedRetryable = createFailedRunRecord({
      runId: "run-2" as RunId,
      attempt: 1,
      maxAttempts: 3,
      error: { message: "Timeout", retryable: true },
    });
    const failedNonRetryable = createFailedRunRecord({
      runId: "run-3" as RunId,
      attempt: 1,
      maxAttempts: 3,
      error: { message: "Auth failed", retryable: false },
    });

    await repo.create(running);
    await repo.create(failedRetryable);
    await repo.create(failedNonRetryable);

    const interrupted = await detectInterruptedRuns(repo);

    expect(interrupted).toHaveLength(2);
    expect(interrupted.map((r) => r.runId).sort()).toEqual(["run-1", "run-2"]);
  });
});

// ─── T-04 / RR-02: recoverRun — remote succeeded ────────────────────────────

describe("recoverRun — remote succeeded", () => {
  it("RR-02: transita running → succeeded quando remoto confirmou conclusão", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord();
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.state).toBe("succeeded");
    expect(recovered.finishedAt).toBeDefined();
  });

  it("preserva idempotencyKey após recovery para succeeded", async () => {
    const repo = new InMemoryRunRepository();
    const idempotencyKey = "key-succeeded".padEnd(64, "0") as IdempotencyKey;
    const record = createRunningRunRecord({ idempotencyKey });
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.idempotencyKey).toBe(idempotencyKey);
  });

  it("registra evento de recovery no metadata", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord();
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.metadata).toBeDefined();
    const recovery = recovered.metadata?.recovery as Record<string, unknown>;
    expect(recovery).toBeDefined();
    expect(recovery.action).toBe("succeed");
    expect(recovery.reason).toContain("completed successfully");
    expect(recovery.evaluatedAt).toBeDefined();
    expect(recovery.idempotencyKey).toBe(record.idempotencyKey);
  });
});

// ─── RR-02: recoverRun — remote needs manual ────────────────────────────────

describe("recoverRun — remote needs manual", () => {
  it("transita running → waiting_manual quando remoto indica necessidade de ação humana", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord();
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "waiting_manual" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.state).toBe("waiting_manual");
  });

  it("preserva idempotencyKey após recovery para waiting_manual", async () => {
    const repo = new InMemoryRunRepository();
    const idempotencyKey = "key-manual".padEnd(64, "1") as IdempotencyKey;
    const record = createRunningRunRecord({ idempotencyKey });
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "waiting_manual" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.idempotencyKey).toBe(idempotencyKey);
  });

  it("registra evento de recovery no metadata", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord();
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "waiting_manual" });
    const recovered = await recoverRun(record, adapter, repo);

    const recovery = recovered.metadata?.recovery as Record<string, unknown>;
    expect(recovery.action).toBe("wait_manual");
    expect(recovery.remoteState).toBe("waiting_manual");
  });
});

// ─── RR-02 / RR-06: recoverRun — remote failed retryable ────────────────────

describe("recoverRun — remote failed retryable", () => {
  it("RR-02/RR-06: transita running → failed → queued quando falha retryable e attempt < maxAttempts", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord({ attempt: 1, maxAttempts: 3 });
    await repo.create(record);

    const adapter = createAdapterWithStatus({
      state: "failed",
      error: { message: "Timeout", retryable: true },
    });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.state).toBe("queued");
    expect(recovered.attempt).toBe(1); // attempt preserved, not incremented
  });

  it("preserva idempotencyKey após recovery para retry", async () => {
    const repo = new InMemoryRunRepository();
    const idempotencyKey = "key-retry".padEnd(64, "2") as IdempotencyKey;
    const record = createRunningRunRecord({ idempotencyKey, attempt: 1, maxAttempts: 3 });
    await repo.create(record);

    const adapter = createAdapterWithStatus({
      state: "failed",
      error: { message: "Timeout", retryable: true },
    });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.idempotencyKey).toBe(idempotencyKey);
  });

  it("não retenta quando attempt >= maxAttempts", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord({ attempt: 3, maxAttempts: 3 });
    await repo.create(record);

    const adapter = createAdapterWithStatus({
      state: "failed",
      error: { message: "Timeout", retryable: true },
    });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.state).toBe("failed");
    expect(recovered.finishedAt).toBeDefined();
  });

  it("não retenta quando falha não é retryable", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord({ attempt: 1, maxAttempts: 3 });
    await repo.create(record);

    const adapter = createAdapterWithStatus({
      state: "failed",
      error: { message: "Auth failed", retryable: false },
    });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.state).toBe("failed");
    expect(recovered.finishedAt).toBeDefined();
  });

  it("registra evento de recovery no metadata para retry", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord({ attempt: 1, maxAttempts: 3 });
    await repo.create(record);

    const adapter = createAdapterWithStatus({
      state: "failed",
      error: { message: "Timeout", retryable: true },
    });
    const recovered = await recoverRun(record, adapter, repo);

    const recovery = recovered.metadata?.recovery as Record<string, unknown>;
    expect(recovery.action).toBe("retry");
    expect(recovery.remoteState).toBe("failed");
  });
});

// ─── RR-03: recoverRun preserves waiting_manual ─────────────────────────────

describe("recoverRun — preserves waiting_manual", () => {
  it("RR-03: não recupera automaticamente runs em waiting_manual", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord({ state: "waiting_manual" });
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const recovered = await recoverRun(record, adapter, repo);

    // Should remain in waiting_manual, not transition to succeeded
    expect(recovered.state).toBe("waiting_manual");
  });

  it("preserva idempotencyKey em waiting_manual", async () => {
    const repo = new InMemoryRunRepository();
    const idempotencyKey = "key-waiting".padEnd(64, "3") as IdempotencyKey;
    const record = createRunningRunRecord({ state: "waiting_manual", idempotencyKey });
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.idempotencyKey).toBe(idempotencyKey);
  });

  it("registra metadata de skip para waiting_manual", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord({ state: "waiting_manual" });
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const recovered = await recoverRun(record, adapter, repo);

    const recovery = recovered.metadata?.recovery as Record<string, unknown>;
    expect(recovery.action).toBe("skipped");
    expect(recovery.reason).toContain("waiting_manual");
  });
});

// ─── RR-04: recoverRun metadata and corrupted state ─────────────────────────

describe("recoverRun — metadata and corrupted state", () => {
  it("RR-04: registra evento de recovery no metadata com timestamp", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord();
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const recovered = await recoverRun(record, adapter, repo);

    const recovery = recovered.metadata?.recovery as Record<string, unknown>;
    expect(recovery.evaluatedAt).toBeDefined();
    expect(typeof recovery.evaluatedAt).toBe("string");
    // Verify it's a valid ISO date string
    expect(Number.isFinite(Date.parse(recovery.evaluatedAt as string))).toBe(true);
  });

  it("RR-04: estado corrompido retorna erro explícito", async () => {
    const repo = new InMemoryRunRepository();
    // Create a record with an invalid state that wouldn't normally exist
    const record = createRunningRunRecord({
      state: "queued" as never, // Force an unexpected state for recoverRun
    });
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "succeeded" });

    // recoverRun should handle this gracefully
    // queued is not running or waiting_manual, so it should throw
    await expect(recoverRun(record, adapter, repo)).rejects.toThrow(
      'Cannot recover run in state "queued"',
    );
  });

  it("preserva metadata existente do record", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord({
      metadata: { existingKey: "existingValue", retryCount: 2 },
    });
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.metadata?.existingKey).toBe("existingValue");
    expect(recovered.metadata?.retryCount).toBe(2);
    // Recovery metadata should also be present
    expect(recovered.metadata?.recovery).toBeDefined();
  });
});

// ─── RR-05: recoveryLoop ────────────────────────────────────────────────────

describe("recoveryLoop — T-12", () => {
  it("RR-05: executa detectInterruptedRuns + recoverRun para cada run interrompido", async () => {
    const repo = new InMemoryRunRepository();
    const running1 = createRunningRunRecord({
      runId: "run-1" as RunId,
      attempt: 1,
      maxAttempts: 3,
    });
    const running2 = createRunningRunRecord({
      runId: "run-2" as RunId,
      attempt: 1,
      maxAttempts: 3,
    });
    const queued = createQueuedRunRecord({ runId: "run-3" as RunId });

    await repo.create(running1);
    await repo.create(running2);
    await repo.create(queued);

    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const results = await recoveryLoop(adapter, repo);

    expect(results).toHaveLength(2);
    expect(results[0].newState).toBe("succeeded");
    expect(results[1].newState).toBe("succeeded");
  });

  it("retorna array vazio quando não há runs interrompidos", async () => {
    const repo = new InMemoryRunRepository();
    const queued = createQueuedRunRecord();
    await repo.create(queued);

    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const results = await recoveryLoop(adapter, repo);

    expect(results).toHaveLength(0);
  });

  it("processa mix de estados de recovery", async () => {
    const repo = new InMemoryRunRepository();
    const running1 = createRunningRunRecord({
      runId: "run-1" as RunId,
      attempt: 1,
      maxAttempts: 3,
    });
    const running2 = createRunningRunRecord({
      runId: "run-2" as RunId,
      state: "waiting_manual",
    });

    await repo.create(running1);
    await repo.create(running2);

    // Adapter that returns succeeded for run-1, but run-2 is waiting_manual
    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const results = await recoveryLoop(adapter, repo);

    expect(results).toHaveLength(2);
    // run-1 should be recovered to succeeded
    const run1Result = results.find((r) => r.runId === "run-1");
    expect(run1Result?.newState).toBe("succeeded");
    // run-2 should stay in waiting_manual (preserved)
    const run2Result = results.find((r) => r.runId === "run-2");
    expect(run2Result?.newState).toBe("waiting_manual");
  });

  it("funciona com adapter null", async () => {
    const repo = new InMemoryRunRepository();
    const running = createRunningRunRecord({ runId: "run-1" as RunId });
    await repo.create(running);

    const results = await recoveryLoop(null, repo);

    expect(results).toHaveLength(1);
    // Without adapter, remote status is unknown → leave_running
    expect(results[0].newState).toBe("running");
  });

  it("contém runId, previousState, newState, action e reason em cada resultado", async () => {
    const repo = new InMemoryRunRepository();
    const running = createRunningRunRecord({ runId: "run-1" as RunId });
    await repo.create(running);

    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const results = await recoveryLoop(adapter, repo);

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.runId).toBe("run-1");
    expect(result.previousState).toBe("running");
    expect(result.newState).toBe("succeeded");
    expect(typeof result.action).toBe("string");
    expect(typeof result.reason).toBe("string");
  });

  it("falha em um recovery não impede processamento dos demais (isolamento de erros)", async () => {
    // Create a repo with a normal running record
    const repo = new InMemoryRunRepository();
    const running1 = createRunningRunRecord({
      runId: "run-ok" as RunId,
    });
    await repo.create(running1);

    // Create a second repo that returns a corrupted record for waiting_manual query.
    // The corrupted record has state "queued" which will cause recoverRun to throw
    // (expecting "running" or "waiting_manual").
    const corruptedRecord: RunRecord = {
      ...createRunningRunRecord({
        runId: "run-corrupted" as RunId,
      }),
      state: "queued" as RunState,
    };
    const repoWithCorrupted = new InMemoryRunRepository();
    await repoWithCorrupted.create(running1);
    // Patch the repo to inject corrupted record into waiting_manual results
    const originalList = repoWithCorrupted.list.bind(repoWithCorrupted);
    repoWithCorrupted.list = async (filter?: { state?: RunState }): Promise<RunRecord[]> => {
      const results = await originalList(filter);
      if (filter?.state === "waiting_manual") {
        return [...results, corruptedRecord];
      }
      return results;
    };

    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const results = await recoveryLoop(adapter, repoWithCorrupted);

    // Should have 2 results: run-ok succeeded, run-corrupted errored
    expect(results).toHaveLength(2);

    // run-ok should be recovered successfully
    const okResult = results.find((r) => r.runId === "run-ok");
    expect(okResult).toBeDefined();
    expect(okResult!.newState).toBe("succeeded");
    expect(okResult!.action).toBe("succeed");

    // run-corrupted should have error result without aborting the loop
    const corruptedResult = results.find((r) => r.runId === "run-corrupted");
    expect(corruptedResult).toBeDefined();
    expect(corruptedResult!.newState).toBe("queued"); // previous state preserved
    expect(corruptedResult!.action).toBe("error");
    expect(corruptedResult!.error).toContain("Cannot recover run in state");
  });
});

// ─── RR-06: Terminal states not processed ────────────────────────────────────

describe("recoverRun — terminal states (RR-06)", () => {
  it("não processa runs em estado succeeded", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord({
      state: "succeeded",
      finishedAt: new Date(),
    });
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "failed" });
    const recovered = await recoverRun(record, adapter, repo);

    // Should return the same record unchanged
    expect(recovered.state).toBe("succeeded");
  });

  it("não processa runs em estado cancelled", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord({
      state: "cancelled",
      finishedAt: new Date(),
    });
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "succeeded" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.state).toBe("cancelled");
  });
});

// ─── recoverRun — no adapter (ambiguous) ────────────────────────────────────

describe("recoverRun — no adapter", () => {
  it("deixa run em running quando adapter é null (ambíguo)", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord();
    await repo.create(record);

    const recovered = await recoverRun(record, null, repo);

    expect(recovered.state).toBe("running");
    const recovery = recovered.metadata?.recovery as Record<string, unknown>;
    expect(recovery.action).toBe("leave_running");
    expect(recovery.reason).toContain("No remote status available");
  });
});

// ─── recoverRun — checkStatus throws ────────────────────────────────────────

describe("recoverRun — checkStatus throws", () => {
  it("trata erro de checkStatus como sem status remoto", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord();
    await repo.create(record);

    const adapter = createAdapterThatThrows();
    const recovered = await recoverRun(record, adapter, repo);

    // Should leave in running (ambiguous)
    expect(recovered.state).toBe("running");
    const recovery = recovered.metadata?.recovery as Record<string, unknown>;
    expect(recovery.action).toBe("leave_running");
  });
});

// ─── recoverRun — remote still running (ambiguous) ──────────────────────────

describe("recoverRun — remote ambiguous states", () => {
  it("deixa run em running quando remoto está em running", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord();
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "running" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.state).toBe("running");
    const recovery = recovered.metadata?.recovery as Record<string, unknown>;
    expect(recovery.action).toBe("leave_running");
    expect(recovery.remoteState).toBe("running");
  });

  it("deixa run em running quando remoto está em queued", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord();
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "queued" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.state).toBe("running");
    const recovery = recovered.metadata?.recovery as Record<string, unknown>;
    expect(recovery.action).toBe("leave_running");
  });

  it("trata cancelled remoto como falha terminal", async () => {
    const repo = new InMemoryRunRepository();
    const record = createRunningRunRecord();
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "cancelled" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.state).toBe("failed");
    const recovery = recovered.metadata?.recovery as Record<string, unknown>;
    expect(recovery.action).toBe("fail");
  });
});

// ─── HUMAN-005 / T-12: recoverRun — failed retryable → queued ────────────────

describe("recoverRun — HUMAN-005 / T-12: failed retryable → queued", () => {
  it("T-12: transita failed → queued quando error.retryable=true e attempt < maxAttempts", async () => {
    const repo = new InMemoryRunRepository();
    const record = createFailedRunRecord({
      runId: "run-failed-retry" as RunId,
      attempt: 1,
      maxAttempts: 3,
      error: { message: "Timeout", retryable: true },
    });
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "failed" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.state).toBe("queued");
    expect(recovered.attempt).toBe(1); // attempt preserved, not incremented
    expect(recovered.finishedAt).toBeUndefined(); // cleared by transition to queued
  });

  it("preserva idempotencyKey ao transitar failed → queued", async () => {
    const repo = new InMemoryRunRepository();
    const idempotencyKey = "key-failed-retry".padEnd(64, "4") as IdempotencyKey;
    const record = createFailedRunRecord({
      runId: "run-failed-retry" as RunId,
      idempotencyKey,
      attempt: 1,
      maxAttempts: 3,
      error: { message: "Timeout", retryable: true },
    });
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "failed" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.idempotencyKey).toBe(idempotencyKey);
  });

  it("preserva error ao transitar failed → queued", async () => {
    const repo = new InMemoryRunRepository();
    const record = createFailedRunRecord({
      runId: "run-failed-retry" as RunId,
      attempt: 1,
      maxAttempts: 3,
      error: { message: "Timeout", retryable: true },
    });
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "failed" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.error?.message).toBe("Timeout");
    expect(recovered.error?.retryable).toBe(true);
  });

  it("registra evento de recovery no metadata para failed → queued", async () => {
    const repo = new InMemoryRunRepository();
    const record = createFailedRunRecord({
      runId: "run-failed-retry" as RunId,
      attempt: 1,
      maxAttempts: 3,
      error: { message: "Timeout", retryable: true },
    });
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "failed" });
    const recovered = await recoverRun(record, adapter, repo);

    const recovery = recovered.metadata?.recovery as Record<string, unknown>;
    expect(recovery.action).toBe("retry");
    expect(recovery.reason).toContain("retryable");
    expect(recovery.evaluatedAt).toBeDefined();
    expect(recovery.idempotencyKey).toBe(record.idempotencyKey);
  });

  it("não processa runs failed com error.retryable=false (permanece failed)", async () => {
    const repo = new InMemoryRunRepository();
    const record = createFailedRunRecord({
      runId: "run-failed-non-retry" as RunId,
      attempt: 1,
      maxAttempts: 3,
      error: { message: "Auth failed", retryable: false },
    });
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "failed" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.state).toBe("failed");
  });

  it("não processa runs failed com attempt >= maxAttempts (permanece failed)", async () => {
    const repo = new InMemoryRunRepository();
    const record = createFailedRunRecord({
      runId: "run-failed-max-attempts" as RunId,
      attempt: 3,
      maxAttempts: 3,
      error: { message: "Timeout", retryable: true },
    });
    await repo.create(record);

    const adapter = createAdapterWithStatus({ state: "failed" });
    const recovered = await recoverRun(record, adapter, repo);

    expect(recovered.state).toBe("failed");
  });

  it("funciona com adapter null para failed retryable", async () => {
    const repo = new InMemoryRunRepository();
    const record = createFailedRunRecord({
      runId: "run-failed-null-adapter" as RunId,
      attempt: 1,
      maxAttempts: 3,
      error: { message: "Timeout", retryable: true },
    });
    await repo.create(record);

    const recovered = await recoverRun(record, null, repo);

    expect(recovered.state).toBe("queued");
    expect(recovered.attempt).toBe(1);
  });
});
