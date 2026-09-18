import { describe, expect, it } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";
import { transitionRunState } from "../domain/transition.js";
import { createCheckpoint } from "../domain/checkpoint.js";

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

function createWaitingManualRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return createQueuedRunRecord({
    state: "waiting_manual",
    attempt: 1,
    startedAt: new Date("2026-01-01T00:00:01Z"),
    ...overrides,
  });
}

// ─── TR-01: Retomada de waiting_manual com resumeRun() ──────────────────────

describe("TR-01: Retomada de waiting_manual com resumeRun()", () => {
  it("retoma run em waiting_manual e transita para succeeded", async () => {
    const repo = new InMemoryRunRepository();
    const record = createWaitingManualRunRecord();
    await repo.create(record);

    expect(record.state).toBe("waiting_manual");

    const adapter = new FakeAdapter("success");
    const result = await resumeRun(record.runId, adapter, repo);

    expect(result.state).toBe("succeeded");
    expect(result.finishedAt).toBeDefined();

    // Verificar persistência
    const persisted = await repo.getById(record.runId);
    expect(persisted!.state).toBe("succeeded");
  });

  it("retoma run em waiting_manual com erro anterior e limpa o erro", async () => {
    const repo = new InMemoryRunRepository();
    const record = createWaitingManualRunRecord({
      error: { message: "Previous failure", code: "PREV_ERR", retryable: true },
    });
    await repo.create(record);

    expect(record.error).toBeDefined();

    const adapter = new FakeAdapter("success");
    const result = await resumeRun(record.runId, adapter, repo);

    expect(result.state).toBe("succeeded");
    expect(result.error).toBeUndefined();
  });

  it("retoma run em waiting_manual e registra metadata de ação manual", async () => {
    const repo = new InMemoryRunRepository();
    const record = createWaitingManualRunRecord();
    await repo.create(record);

    const adapter = new FakeAdapter("success");
    const result = await resumeRun(record.runId, adapter, repo);

    expect(result.metadata).toBeDefined();
    const manualAction = result.metadata?.manualAction as Record<string, unknown> | undefined;
    expect(manualAction).toBeDefined();
    expect(manualAction?.actionType).toBe("manual_resume");
    expect(manualAction?.previousState).toBe("waiting_manual");
    expect(manualAction?.resumedAt).toBeDefined();
  });

  it("preserva attempt e maxAttempts ao retomar", async () => {
    const repo = new InMemoryRunRepository();
    const record = createWaitingManualRunRecord({
      attempt: 2,
      maxAttempts: 5,
    });
    await repo.create(record);

    const adapter = new FakeAdapter("success");
    const result = await resumeRun(record.runId, adapter, repo);

    expect(result.attempt).toBe(2);
    expect(result.maxAttempts).toBe(5);
  });
});

// ─── TR-02: Restauração de checkpoint após falha ─────────────────────────────

describe("TR-02: Restauração de checkpoint após falha", () => {
  it("checkpoint captura estado antes da falha", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    // Executar com falha
    const failureAdapter = new FakeAdapter("failure");
    const failed = await executeRun(record, failureAdapter, repo);

    expect(failed.state).toBe("failed");

    // Criar checkpoint do estado falho para análise
    const checkpoint = createCheckpoint(failed, {
      step: "post-failure-analysis",
      failureReason: failed.error?.message,
    });

    expect(checkpoint.runId).toBe(failed.runId);
    expect(checkpoint.state).toBe("failed");
    expect(checkpoint.attempt).toBe(failed.attempt);
    expect(checkpoint.payload).toEqual({
      step: "post-failure-analysis",
      failureReason: "Simulated transient failure",
    });
  });

  it("checkpoint é serializável e preserva dados após falha", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    const failureAdapter = new FakeAdapter("failure");
    const failed = await executeRun(record, failureAdapter, repo);

    // Criar checkpoint
    const checkpoint = createCheckpoint(failed, {
      step: "recovery-point",
      lastAttempt: failed.attempt,
    });

    // Serializar e desserializar
    const serialized = JSON.stringify(checkpoint);
    const deserialized = JSON.parse(serialized) as ReturnType<typeof createCheckpoint>;

    expect(deserialized.runId).toBe(failed.runId);
    expect(deserialized.state).toBe("failed");
    expect(deserialized.attempt).toBe(failed.attempt);
    expect(deserialized.payload).toEqual({
      step: "recovery-point",
      lastAttempt: failed.attempt,
    });
  });

  it("checkpoint de estado intermediário é independente do estado final", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord({ maxAttempts: 3 });
    await repo.create(record);

    // 1ª execução: queued → running → failed
    const failureAdapter = new FakeAdapter("failure");
    const failed = await executeRun(record, failureAdapter, repo);

    // Checkpoint do estado falho
    const checkpointFailed = createCheckpoint(failed, { step: "failure-point" });

    // Recuperar e bem-sucedir
    const queuedRecord = transitionRunState({
      current: failed,
      targetState: "queued",
      error: failed.error!,
    });
    await repo.update(queuedRecord);

    const successAdapter = new FakeAdapter("success");
    const succeeded = await executeRun(queuedRecord, successAdapter, repo);

    // Checkpoint continua apontando para o estado de falha
    expect(checkpointFailed.state).toBe("failed");
    expect(checkpointFailed.attempt).toBe(1);
    expect(succeeded.state).toBe("succeeded");
    expect(succeeded.attempt).toBe(2);
  });
});

// ─── TR-03: Retry com FakeAdapter modo failure até maxAttempts ───────────────

describe("TR-03: Retry com FakeAdapter modo failure até maxAttempts", () => {
  it("retries até maxAttempts e falha permanentemente", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord({ maxAttempts: 2 });
    await repo.create(record);

    // 1ª execução: queued(0) → running(1) → failed
    const failureAdapter1 = new FakeAdapter("failure");
    const failed1 = await executeRun(record, failureAdapter1, repo);

    expect(failed1.state).toBe("failed");
    expect(failed1.attempt).toBe(1);

    // Recuperar: failed → queued
    const queued1 = transitionRunState({
      current: failed1,
      targetState: "queued",
      error: failed1.error!,
    });
    await repo.update(queued1);
    expect(queued1.attempt).toBe(1);

    // 2ª execução: queued(1) → running(2) → failed
    const failureAdapter2 = new FakeAdapter("failure");
    const failed2 = await executeRun(queued1, failureAdapter2, repo);

    expect(failed2.state).toBe("failed");
    expect(failed2.attempt).toBe(2);

    // Tentar retry: deve falhar (attempt 2 == maxAttempts 2)
    expect(() =>
      transitionRunState({
        current: failed2,
        targetState: "queued",
        error: failed2.error!,
      }),
    ).toThrow("Cannot retry");

    // Verificar estado final persistido
    const persisted = await repo.getById(record.runId);
    expect(persisted!.state).toBe("failed");
    expect(persisted!.attempt).toBe(2);
  });

  it("conta attempts corretamente ao longo do ciclo de retry", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord({ maxAttempts: 4 });
    await repo.create(record);

    const failureAdapter = new FakeAdapter("failure");
    let current = record;

    // Executar 4 vezes (maxAttempts = 4)
    for (let i = 0; i < 4; i++) {
      const failed = await executeRun(current, failureAdapter, repo);
      expect(failed.state).toBe("failed");
      expect(failed.attempt).toBe(i + 1);

      if (i < 3) {
        // Recuperar para próxima tentativa (exceto na última)
        const queued = transitionRunState({
          current: failed,
          targetState: "queued",
          error: failed.error!,
        });
        await repo.update(queued);
        current = queued;
      }
    }

    // Verificar que o último attempt é igual ao maxAttempts
    const persisted = await repo.getById(record.runId);
    expect(persisted!.attempt).toBe(4);
    expect(persisted!.state).toBe("failed");

    // Não deve ser possível retry
    expect(() =>
      transitionRunState({
        current: persisted!,
        targetState: "queued",
        error: persisted!.error!,
      }),
    ).toThrow("Cannot retry");
  });
});

// ─── TR-04: Verificação de idempotência entre retries ───────────────────────

describe("TR-04: Verificação de idempotência entre retries", () => {
  it("idempotencyKey e payloadFingerprint permanecem iguais entre retries", async () => {
    const repo = new InMemoryRunRepository();
    const idempotencyKey = "e".repeat(64) as IdempotencyKey;
    const payloadFingerprint = "f".repeat(64) as PayloadFingerprint;

    const record = createQueuedRunRecord({
      idempotencyKey,
      payloadFingerprint,
      maxAttempts: 3,
    });
    await repo.create(record);

    const failureAdapter = new FakeAdapter("failure");
    const successAdapter = new FakeAdapter("success");

    // 1ª tentativa
    const failed1 = await executeRun(record, failureAdapter, repo);
    expect(failed1.idempotencyKey).toBe(idempotencyKey);
    expect(failed1.payloadFingerprint).toBe(payloadFingerprint);

    // Recuperar
    const queued1 = transitionRunState({
      current: failed1,
      targetState: "queued",
      error: failed1.error!,
    });
    await repo.update(queued1);

    // 2ª tentativa
    const failed2 = await executeRun(queued1, failureAdapter, repo);
    expect(failed2.idempotencyKey).toBe(idempotencyKey);
    expect(failed2.payloadFingerprint).toBe(payloadFingerprint);

    // Recuperar
    const queued2 = transitionRunState({
      current: failed2,
      targetState: "queued",
      error: failed2.error!,
    });
    await repo.update(queued2);

    // 3ª tentativa (sucesso)
    const succeeded = await executeRun(queued2, successAdapter, repo);
    expect(succeeded.idempotencyKey).toBe(idempotencyKey);
    expect(succeeded.payloadFingerprint).toBe(payloadFingerprint);

    // Verificar persistência final
    const persisted = await repo.getById(record.runId);
    expect(persisted!.idempotencyKey).toBe(idempotencyKey);
    expect(persisted!.payloadFingerprint).toBe(payloadFingerprint);
  });

  it("repo.findByIdempotencyKey encontra o registro correto entre retries", async () => {
    const repo = new InMemoryRunRepository();
    const idempotencyKey = "g".repeat(64) as IdempotencyKey;

    const record = createQueuedRunRecord({ idempotencyKey, maxAttempts: 2 });
    await repo.create(record);

    const failureAdapter = new FakeAdapter("failure");

    // 1ª tentativa
    const failed1 = await executeRun(record, failureAdapter, repo);

    // Verificar que pode encontrar por idempotencyKey
    const found = await repo.findByIdempotencyKey(idempotencyKey);
    expect(found).not.toBeNull();
    expect(found!.runId).toBe(record.runId);

    // Recuperar e retry
    const queued1 = transitionRunState({
      current: failed1,
      targetState: "queued",
      error: failed1.error!,
    });
    await repo.update(queued1);

    const _failed2 = await executeRun(queued1, failureAdapter, repo);

    // Ainda encontra o mesmo registro
    const foundAfterRetry = await repo.findByIdempotencyKey(idempotencyKey);
    expect(foundAfterRetry).not.toBeNull();
    expect(foundAfterRetry!.runId).toBe(record.runId);
    expect(foundAfterRetry!.attempt).toBe(2);
  });

  it("dois registros diferentes não compartilham idempotencyKey", async () => {
    const repo = new InMemoryRunRepository();
    const key1 = "h".repeat(64) as IdempotencyKey;
    const key2 = "i".repeat(64) as IdempotencyKey;

    const record1 = createQueuedRunRecord({ idempotencyKey: key1 });
    const record2 = createQueuedRunRecord({
      idempotencyKey: key2,
      runId: "660e8400-e29b-41d4-a716-446655440001" as RunId,
    });

    await repo.create(record1);
    await repo.create(record2);

    const found1 = await repo.findByIdempotencyKey(key1);
    const found2 = await repo.findByIdempotencyKey(key2);

    expect(found1).not.toBeNull();
    expect(found2).not.toBeNull();
    expect(found1!.runId).toBe(record1.runId);
    expect(found2!.runId).toBe(record2.runId);
    expect(found1!.runId).not.toBe(found2!.runId);
  });
});
