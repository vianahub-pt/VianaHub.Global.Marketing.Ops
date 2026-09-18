import { describe, expect, it } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";
import { transitionRunState } from "../domain/transition.js";

import { FakeAdapter } from "./fake-adapter.js";
import { InMemoryRunRepository } from "./in-memory-repo.js";
import { executeRun, resumeRun } from "./orchestrator.js";

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

// ─── TI-01: Fluxo completo queued → running → succeeded ─────────────────────

describe("TI-01: Fluxo completo queued → running → succeeded", () => {
  it("executa com FakeAdapter success e transita para succeeded", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    const adapter = new FakeAdapter("success");
    const result = await executeRun(record, adapter, repo);

    expect(result.state).toBe("succeeded");
    expect(result.attempt).toBe(1);
    expect(result.startedAt).toBeDefined();
    expect(result.finishedAt).toBeDefined();

    // Verificar persistência
    const persisted = await repo.getById(record.runId);
    expect(persisted).not.toBeNull();
    expect(persisted!.state).toBe("succeeded");
  });
});

// ─── TI-02: Fluxo queued → running → failed → queued → running → succeeded ──

describe("TI-02: Fluxo queued → running → failed → queued → running → succeeded", () => {
  it("executa com failure, recupera, e executa com success", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord({ maxAttempts: 3 });
    await repo.create(record);

    // 1ª execução: queued → running → failed
    const failureAdapter = new FakeAdapter("failure");
    const failed = await executeRun(record, failureAdapter, repo);

    expect(failed.state).toBe("failed");
    expect(failed.attempt).toBe(1);
    expect(failed.error).toBeDefined();
    expect(failed.error?.retryable).toBe(true);

    // Recuperar: failed → queued
    const retryableError = failed.error!;
    const queuedRecord = transitionRunState({
      current: failed,
      targetState: "queued",
      error: retryableError,
    });
    await repo.update(queuedRecord);

    expect(queuedRecord.state).toBe("queued");
    expect(queuedRecord.attempt).toBe(1);

    // 2ª execução: queued → running → succeeded
    const successAdapter = new FakeAdapter("success");
    const succeeded = await executeRun(queuedRecord, successAdapter, repo);

    expect(succeeded.state).toBe("succeeded");
    expect(succeeded.attempt).toBe(2);
    expect(succeeded.finishedAt).toBeDefined();

    // Verificar persistência final
    const persisted = await repo.getById(record.runId);
    expect(persisted!.state).toBe("succeeded");
  });
});

// ─── TI-03: Fluxo queued → running → waiting_manual → running → succeeded ───

describe("TI-03: Fluxo queued → running → waiting_manual → running → succeeded", () => {
  it("executa com manual, retoma, e executa com success", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    // 1ª execução: queued → running → waiting_manual
    const manualAdapter = new FakeAdapter("manual");
    const waiting = await executeRun(record, manualAdapter, repo);

    expect(waiting.state).toBe("waiting_manual");
    expect(waiting.attempt).toBe(1);
    expect(waiting.finishedAt).toBeUndefined();

    // Retomar: waiting_manual → running → succeeded
    const successAdapter = new FakeAdapter("success");
    const succeeded = await resumeRun(waiting.runId, successAdapter, repo);

    expect(succeeded.state).toBe("succeeded");
    expect(succeeded.finishedAt).toBeDefined();

    // Verificar persistência final
    const persisted = await repo.getById(record.runId);
    expect(persisted!.state).toBe("succeeded");
  });
});

// ─── TI-04: Fluxo queued → running → failed (erro não retryable, terminal) ──

describe("TI-04: Fluxo queued → running → failed (erro não retryable)", () => {
  it("executa com permanentFailure e termina em failed", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord({ maxAttempts: 3 });
    await repo.create(record);

    const adapter = new FakeAdapter("permanentFailure");
    const result = await executeRun(record, adapter, repo);

    expect(result.state).toBe("failed");
    expect(result.attempt).toBe(1);
    expect(result.error).toBeDefined();
    expect(result.error?.retryable).toBe(false);
    expect(result.finishedAt).toBeDefined();

    // Verificar que não é possível retry
    expect(() =>
      transitionRunState({
        current: result,
        targetState: "queued",
        error: result.error,
      }),
    ).toThrow("Cannot retry");

    // Verificar persistência
    const persisted = await repo.getById(record.runId);
    expect(persisted!.state).toBe("failed");
    expect(persisted!.error?.retryable).toBe(false);
  });
});

// ─── TI-05: Verificação de checkStatus() após execução ──────────────────────

describe("TI-05: Verificação de checkStatus() após execução", () => {
  it("checkStatus retorna succeeded após execução bem-sucedida", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    const adapter = new FakeAdapter("success");
    await executeRun(record, adapter, repo);

    const status = await adapter.checkStatus(record.runId);
    expect(status.state).toBe("succeeded");
  });

  it("checkStatus retorna failed após execução com falha", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    const adapter = new FakeAdapter("failure");
    await executeRun(record, adapter, repo);

    const status = await adapter.checkStatus(record.runId);
    expect(status.state).toBe("failed");
  });

  it("checkStatus retorna waiting_manual após execução manual", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    const adapter = new FakeAdapter("manual");
    await executeRun(record, adapter, repo);

    const status = await adapter.checkStatus(record.runId);
    expect(status.state).toBe("waiting_manual");
  });
});

// ─── Preservação de payload em retries ──────────────────────────────────────

describe("Preservação de payload em retries", () => {
  it("preserva payloadFingerprint e idempotencyKey entre retries", async () => {
    const repo = new InMemoryRunRepository();
    const fingerprint = "c".repeat(64) as PayloadFingerprint;
    const idempotencyKey = "d".repeat(64) as IdempotencyKey;

    const record = createQueuedRunRecord({
      payloadFingerprint: fingerprint,
      idempotencyKey,
      maxAttempts: 3,
    });
    await repo.create(record);

    // 1ª execução: queued → running → failed
    const failureAdapter = new FakeAdapter("failure");
    const failed = await executeRun(record, failureAdapter, repo);

    expect(failed.payloadFingerprint).toBe(fingerprint);
    expect(failed.idempotencyKey).toBe(idempotencyKey);

    // Recuperar: failed → queued
    const queuedRecord = transitionRunState({
      current: failed,
      targetState: "queued",
      error: failed.error!,
    });
    await repo.update(queuedRecord);

    // 2ª execução: queued → running → succeeded
    const successAdapter = new FakeAdapter("success");
    const succeeded = await executeRun(queuedRecord, successAdapter, repo);

    expect(succeeded.payloadFingerprint).toBe(fingerprint);
    expect(succeeded.idempotencyKey).toBe(idempotencyKey);

    // Verificar persistência
    const persisted = await repo.getById(record.runId);
    expect(persisted!.payloadFingerprint).toBe(fingerprint);
    expect(persisted!.idempotencyKey).toBe(idempotencyKey);
  });
});
