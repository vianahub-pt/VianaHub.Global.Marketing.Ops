import { describe, expect, it } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";
import { transitionRunState } from "../domain/transition.js";

import { FakeAdapter } from "./fake-adapter.js";
import { InMemoryRunRepository } from "./in-memory-repo.js";
import { executeRun, resumeRun } from "./orchestrator.js";
import { adapterResultSchema, statusCheckResultSchema } from "./platform-adapter.js";
import { adapterContextSchema, buildAdapterContext } from "./adapter-context.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createQueuedRunRecord(overrides?: Partial<RunRecord>): RunRecord {
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

// ─── TE-01: Execucao completa com FakeAdapter modo success ───────────────────

describe("TE-01: Execucao completa com FakeAdapter modo success", () => {
  it("executa operacao completa e produce RunRecord com estado succeeded e metadata completo", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    const adapter = new FakeAdapter("success");
    const result = await executeRun(record, adapter, repo);

    // Estado final
    expect(result.state).toBe("succeeded");
    expect(result.attempt).toBe(1);
    expect(result.startedAt).toBeDefined();
    expect(result.finishedAt).toBeDefined();

    // Timestamps coerentes
    expect(result.startedAt!.getTime()).toBeLessThanOrEqual(result.finishedAt!.getTime());
    expect(result.updatedAt.getTime()).toBeGreaterThanOrEqual(result.createdAt.getTime());

    // Metadata de status-sync presente
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.statusSync).toBeDefined();

    const statusSync = result.metadata?.statusSync as Record<string, unknown>;
    expect(statusSync.reconciledState).toBe("succeeded");
    expect(statusSync.synchronizedAt).toBeDefined();

    // Persistencia confirmada
    const persisted = await repo.getById(record.runId);
    expect(persisted).not.toBeNull();
    expect(persisted!.state).toBe("succeeded");
    expect(persisted!.attempt).toBe(1);
    expect(persisted!.finishedAt).toBeDefined();
  });

  it("produz AdapterResult valido conforme schema Zod", async () => {
    const adapter = new FakeAdapter("success");
    const context = buildAdapterContext(createQueuedRunRecord());

    const result = await adapter.execute(context);

    // Validar contra schema Zod
    const parsed = adapterResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.success).toBe(true);
    expect(parsed.data?.requiresManual).toBe(false);
  });

  it("produz AdapterContext valido conforme schema Zod", () => {
    const record = createQueuedRunRecord();
    const context = buildAdapterContext(record);

    const parsed = adapterContextSchema.safeParse(context);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.runId).toBe(record.runId);
    expect(parsed.data?.brandId).toBe(record.brandId);
    expect(parsed.data?.market).toBe(record.market);
    expect(parsed.data?.platform).toBe(record.platform);
    expect(parsed.data?.operation).toBe(record.operation);
    expect(parsed.data?.idempotencyKey).toBe(record.idempotencyKey);
  });
});

// ─── TE-02: Execucao com FakeAdapter modo failure verificando retry ─────────

describe("TE-02: Execucao com FakeAdapter modo failure verificando retry", () => {
  it("failure -> retry -> success com attempt correto", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord({ maxAttempts: 3 });
    await repo.create(record);

    // 1a tentativa: queued -> running -> failed (attempt 1)
    const failureAdapter = new FakeAdapter("failure");
    const failed1 = await executeRun(record, failureAdapter, repo);

    expect(failed1.state).toBe("failed");
    expect(failed1.attempt).toBe(1);
    expect(failed1.error).toBeDefined();
    expect(failed1.error?.retryable).toBe(true);
    expect(failed1.error?.code).toBe("FAKE_TRANSIENT");

    // Retry: failed -> queued
    const queued = transitionRunState({
      current: failed1,
      targetState: "queued",
      error: failed1.error!,
    });
    await repo.update(queued);

    expect(queued.state).toBe("queued");
    expect(queued.attempt).toBe(1);

    // 2a tentativa: queued -> running -> succeeded (attempt 2)
    const successAdapter = new FakeAdapter("success");
    const succeeded = await executeRun(queued, successAdapter, repo);

    expect(succeeded.state).toBe("succeeded");
    expect(succeeded.attempt).toBe(2);
    expect(succeeded.finishedAt).toBeDefined();

    // Metadata registra sincronizacao
    expect(succeeded.metadata?.statusSync).toBeDefined();

    // Verificar persistencia final
    const persisted = await repo.getById(record.runId);
    expect(persisted!.state).toBe("succeeded");
    expect(persisted!.attempt).toBe(2);
  });

  it("failure sem retry excede maxAttempts e permanece failed", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord({ maxAttempts: 2 });
    await repo.create(record);

    const failureAdapter = new FakeAdapter("failure");

    // 1a tentativa
    const failed1 = await executeRun(record, failureAdapter, repo);
    expect(failed1.state).toBe("failed");
    expect(failed1.attempt).toBe(1);

    // Retry
    const queued1 = transitionRunState({
      current: failed1,
      targetState: "queued",
      error: failed1.error!,
    });
    await repo.update(queued1);

    // 2a tentativa
    const failed2 = await executeRun(queued1, failureAdapter, repo);
    expect(failed2.state).toBe("failed");
    expect(failed2.attempt).toBe(2);

    // Nao deve ser possivel retry novamente
    expect(() =>
      transitionRunState({
        current: failed2,
        targetState: "queued",
        error: failed2.error!,
      }),
    ).toThrow("Cannot retry");
  });
});

// ─── TE-03: Execucao com FakeAdapter modo manual verificando waiting_manual ─

describe("TE-03: Execucao com FakeAdapter modo manual verificando waiting_manual", () => {
  it("manual -> waiting_manual -> resumeRun -> succeeded", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    // 1a execucao: queued -> running -> waiting_manual
    const manualAdapter = new FakeAdapter("manual");
    const waiting = await executeRun(record, manualAdapter, repo);

    expect(waiting.state).toBe("waiting_manual");
    expect(waiting.attempt).toBe(1);
    expect(waiting.finishedAt).toBeUndefined();
    expect(waiting.error).toBeUndefined();

    // Retomar: waiting_manual -> running -> succeeded
    const successAdapter = new FakeAdapter("success");
    const succeeded = await resumeRun(waiting.runId, successAdapter, repo);

    expect(succeeded.state).toBe("succeeded");
    expect(succeeded.attempt).toBe(1);
    expect(succeeded.finishedAt).toBeDefined();

    // Metadata de acao manual registrada
    expect(succeeded.metadata?.manualAction).toBeDefined();
    const manualAction = succeeded.metadata?.manualAction as Record<string, unknown>;
    expect(manualAction.actionType).toBe("manual_resume");
    expect(manualAction.previousState).toBe("waiting_manual");
    expect(manualAction.resumedAt).toBeDefined();

    // Verificar persistencia final
    const persisted = await repo.getById(record.runId);
    expect(persisted!.state).toBe("succeeded");
  });

  it("resumeRun com adapter manual permanece waiting_manual", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    // Executar para manual
    const manualAdapter = new FakeAdapter("manual");
    const waiting = await executeRun(record, manualAdapter, repo);
    expect(waiting.state).toBe("waiting_manual");

    // Retomar com adapter manual novamente
    const manualAdapter2 = new FakeAdapter("manual");
    const stillWaiting = await resumeRun(waiting.runId, manualAdapter2, repo);

    expect(stillWaiting.state).toBe("waiting_manual");
    expect(stillWaiting.attempt).toBe(1);
    expect(stillWaiting.finishedAt).toBeUndefined();
  });

  it("checkStatus retorna waiting_manual apos execute manual", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    const manualAdapter = new FakeAdapter("manual");
    await executeRun(record, manualAdapter, repo);

    const status = await manualAdapter.checkStatus(record.runId);
    expect(status.state).toBe("waiting_manual");

    // Validar StatusCheckResult contra schema Zod
    const parsed = statusCheckResultSchema.safeParse(status);
    expect(parsed.success).toBe(true);
  });
});

// ─── TE-04: Verificacao de que FakeAdapter nao gera secrets em logs ──────────

describe("TE-04: Verificacao de que FakeAdapter nao gera secrets em logs", () => {
  it("metadata nao contem dados sensiveis em nenhum modo", async () => {
    const modes: Array<"success" | "failure" | "manual" | "permanentFailure"> = [
      "success",
      "failure",
      "manual",
      "permanentFailure",
    ];

    for (const mode of modes) {
      const repo = new InMemoryRunRepository();
      const record = createQueuedRunRecord({
        runId: `test-${mode}-0000-e29b-41d4-a716-446655440000` as RunId,
      });
      await repo.create(record);

      const adapter = new FakeAdapter(mode);

      if (mode === "manual") {
        // Para manual, fazemos execute + resume
        const waiting = await executeRun(record, adapter, repo);

        // Verificar metadata do waiting_manual
        const serialized = JSON.stringify(waiting.metadata ?? {});
        expect(serialized).not.toMatch(/token|secret|password|api[_-]?key|authorization/i);

        const successAdapter = new FakeAdapter("success");
        const succeeded = await resumeRun(waiting.runId, successAdapter, repo);

        const succeededSerialized = JSON.stringify(succeeded.metadata ?? {});
        expect(succeededSerialized).not.toMatch(/token|secret|password|api[_-]?key|authorization/i);
      } else {
        const result = await executeRun(record, adapter, repo);

        // Verificar metadata
        const serialized = JSON.stringify(result.metadata ?? {});
        expect(serialized).not.toMatch(/token|secret|password|api[_-]?key|authorization/i);

        // Verificar erro redactado (se existir)
        if (result.error) {
          expect(result.error.message).not.toMatch(
            /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/,
          );
          expect(result.error.message).not.toMatch(/sk_(?:live|test)_/);
        }
      }
    }
  });

  it("erros do FakeAdapter nao contem pads de dados sensiveis", async () => {
    const failureAdapter = new FakeAdapter("failure");
    const permanentAdapter = new FakeAdapter("permanentFailure");

    // failure mode
    const failureContext = buildAdapterContext(createQueuedRunRecord());
    const failureResult = await failureAdapter.execute(failureContext);
    expect(failureResult.error?.message).not.toMatch(/eyJ/);
    expect(failureResult.error?.message).not.toMatch(/Bearer/);
    expect(failureResult.error?.message).not.toMatch(/-----BEGIN/);
    expect(failureResult.error?.message).not.toMatch(/session_id/i);

    // permanentFailure mode
    const permanentContext = buildAdapterContext(createQueuedRunRecord());
    const permanentResult = await permanentAdapter.execute(permanentContext);
    expect(permanentResult.error?.message).not.toMatch(/eyJ/);
    expect(permanentResult.error?.message).not.toMatch(/sk_live/);
    expect(permanentResult.error?.message).not.toMatch(/password/i);
  });
});

// ─── TE-05: Verificacao de que checkStatus() retorna estado consistente ──────

describe("TE-05: Verificacao de que checkStatus() retorna estado consistente", () => {
  it("checkStatus retorna succeeded apos execucao bem-sucedida", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    const adapter = new FakeAdapter("success");
    await executeRun(record, adapter, repo);

    const status = await adapter.checkStatus(record.runId);
    expect(status.state).toBe("succeeded");
    expect(status.error).toBeUndefined();
  });

  it("checkStatus retorna failed apos execucao com falha", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    const adapter = new FakeAdapter("failure");
    await executeRun(record, adapter, repo);

    const status = await adapter.checkStatus(record.runId);
    expect(status.state).toBe("failed");
    expect(status.error).toBeDefined();
    expect(status.error?.retryable).toBe(true);
  });

  it("checkStatus retorna failed apos permanentFailure", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    const adapter = new FakeAdapter("permanentFailure");
    await executeRun(record, adapter, repo);

    const status = await adapter.checkStatus(record.runId);
    expect(status.state).toBe("failed");
    expect(status.error).toBeDefined();
    expect(status.error?.retryable).toBe(false);
  });

  it("checkStatus retorna waiting_manual apos execucao manual", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    const adapter = new FakeAdapter("manual");
    await executeRun(record, adapter, repo);

    const status = await adapter.checkStatus(record.runId);
    expect(status.state).toBe("waiting_manual");
    expect(status.error).toBeUndefined();
  });

  it("checkStatus retorna queued para run que nunca foi executada", async () => {
    const adapter = new FakeAdapter("success");
    const fakeRunId = "never-executed-0000-e29b-41d4-a716-446655440000" as RunId;

    const status = await adapter.checkStatus(fakeRunId);
    expect(status.state).toBe("queued");
  });

  it("checkStatus e consistente entre multiplas chamadas", async () => {
    const repo = new InMemoryRunRepository();
    const record = createQueuedRunRecord();
    await repo.create(record);

    const adapter = new FakeAdapter("success");
    await executeRun(record, adapter, repo);

    // Multiplas chamadas devem retornar o mesmo estado
    const status1 = await adapter.checkStatus(record.runId);
    const status2 = await adapter.checkStatus(record.runId);
    const status3 = await adapter.checkStatus(record.runId);

    expect(status1.state).toBe(status2.state);
    expect(status2.state).toBe(status3.state);
    expect(status1.state).toBe("succeeded");
  });
});
