import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach, vi } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";
import { transitionRunState } from "../domain/transition.js";

import { FakeAdapter } from "./fake-adapter.js";
import { FileRunRepository } from "./file-run-repo.js";
import { FileCheckpointRepository } from "./file-checkpoint-repo.js";
import { executeRun } from "./orchestrator.js";
import { detectInterruptedRuns, recoverRun, recoveryLoop } from "./recovery.js";
import { GbpDryRunAdapter } from "./gbp-dry-run-adapter.js";
import { buildAdapterContext } from "./adapter-context.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("./access-preflight-gate.js", () => ({
  checkGbpPreflight: vi.fn().mockReturnValue({
    status: "READY",
    checks: [],
    message: "All GBP preflight checks passed — adapter is ready for live execution",
  }),
  loadGbpConfig: vi.fn().mockReturnValue({
    GBP_PROJECT_ID: "fake-project-id",
    GBP_OAUTH_CLIENT_ID: "fake-client-id",
    GBP_OAUTH_CLIENT_SECRET: "fake-client-secret",
    GBP_OAUTH_REFRESH_TOKEN: "fake-refresh-token",
    GBP_ACCOUNT_ID: "fake-account-id",
    GBP_LOCATION_ID: "fake-location-id",
  }),
}));

vi.mock("./pilot-scope.js", () => ({
  checkLivePilotGate: vi.fn().mockReturnValue({
    status: "ALLOWED",
    reason: "Live pilot execution is permitted",
    checks: [
      { name: "LIVE_PILOT_ENABLED", passed: true },
      { name: "NOT_IN_CI", passed: true },
      { name: "DRY_RUN_EXECUTED", passed: true },
    ],
  }),
}));

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

// ─── T-08: E2E local — FileRunRepository + FileCheckpointRepository + FakeAdapter ──

describe("T-08: E2E local — execução completa com persistência filesystem", () => {
  let tempDir: string;
  let runRepo: FileRunRepository;
  let checkpointRepo: FileCheckpointRepository;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function setupRepos() {
    tempDir = mkdtempSync(join(tmpdir(), "e2e-test-"));
    runRepo = new FileRunRepository(join(tempDir, "runs"));
    checkpointRepo = new FileCheckpointRepository(join(tempDir, "checkpoints"));
    return { runRepo, checkpointRepo };
  }

  it("execução completa: create → executeRun → persistência → recuperação do estado", async () => {
    const { runRepo } = setupRepos();
    const record = createQueuedRunRecord();
    await runRepo.create(record);

    // Executar com FakeAdapter success
    const adapter = new FakeAdapter("success");
    const result = await executeRun(record, adapter, runRepo);

    // Verificar estado final
    expect(result.state).toBe("succeeded");
    expect(result.attempt).toBe(1);
    expect(result.startedAt).toBeDefined();
    expect(result.finishedAt).toBeDefined();

    // Verificar persistência no FileRunRepository
    const persisted = await runRepo.getById(record.runId);
    expect(persisted).not.toBeNull();
    expect(persisted!.state).toBe("succeeded");
    expect(persisted!.attempt).toBe(1);
    expect(persisted!.finishedAt).toBeDefined();
    expect(persisted!.idempotencyKey).toBe(record.idempotencyKey);

    // Verificar metadata de status-sync
    expect(persisted!.metadata).toBeDefined();
    expect(persisted!.metadata?.statusSync).toBeDefined();
    const statusSync = persisted!.metadata?.statusSync as Record<string, unknown>;
    expect(statusSync.reconciledState).toBe("succeeded");
  });

  it("execução com retry: failure → queued → success, tudo persistido", async () => {
    const { runRepo } = setupRepos();
    const record = createQueuedRunRecord({ maxAttempts: 3 });
    await runRepo.create(record);

    // 1a execução: failure
    const failureAdapter = new FakeAdapter("failure");
    const failed = await executeRun(record, failureAdapter, runRepo);

    expect(failed.state).toBe("failed");
    expect(failed.attempt).toBe(1);
    expect(failed.error?.retryable).toBe(true);

    // Verificar persistência do estado failed
    const persistedFailed = await runRepo.getById(record.runId);
    expect(persistedFailed!.state).toBe("failed");

    // Retry: failed → queued
    const queued = transitionRunState({
      current: failed,
      targetState: "queued",
      error: failed.error!,
    });
    await runRepo.update(queued);

    // 2a execução: success
    const successAdapter = new FakeAdapter("success");
    const succeeded = await executeRun(queued, successAdapter, runRepo);

    expect(succeeded.state).toBe("succeeded");
    expect(succeeded.attempt).toBe(2);

    // Verificar persistência final
    const persistedSuccess = await runRepo.getById(record.runId);
    expect(persistedSuccess!.state).toBe("succeeded");
    expect(persistedSuccess!.attempt).toBe(2);
  });

  it("execução manual: waiting_manual → resumeRun → succeeded", async () => {
    const { runRepo } = setupRepos();
    const record = createQueuedRunRecord();
    await runRepo.create(record);

    // Execução: queued → running → waiting_manual
    const manualAdapter = new FakeAdapter("manual");
    const waiting = await executeRun(record, manualAdapter, runRepo);

    expect(waiting.state).toBe("waiting_manual");
    expect(waiting.finishedAt).toBeUndefined();

    // Verificar persistência do waiting_manual
    const persistedWaiting = await runRepo.getById(record.runId);
    expect(persistedWaiting!.state).toBe("waiting_manual");

    // Retomar: waiting_manual → running → succeeded
    const successAdapter = new FakeAdapter("success");
    const succeeded = await executeRun(waiting, successAdapter, runRepo);

    expect(succeeded.state).toBe("succeeded");

    // Verificar persistência final
    const persistedFinal = await runRepo.getById(record.runId);
    expect(persistedFinal!.state).toBe("succeeded");
  });

  it("recovery após crash simulado: run em running → detect → recover → queued", async () => {
    const { runRepo } = setupRepos();
    const record = createQueuedRunRecord({ maxAttempts: 3 });
    await runRepo.create(record);

    // Simular crash: colocar run em estado "running" manualmente
    const runningRecord: RunRecord = {
      ...record,
      state: "running",
      attempt: 1,
      startedAt: new Date(),
      updatedAt: new Date(),
    };
    await runRepo.update(runningRecord);

    // Verificar que o run interrompido é detectado
    const interrupted = await detectInterruptedRuns(runRepo);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0].runId).toBe(record.runId);
    expect(interrupted[0].state).toBe("running");

    // Recovery com adapter que diz que remote falhou retryable.
    // Pre-executamos o adapter para que checkStatus() retorne o estado
    // correspondente ao modo ("failed" com retryable), simulando o cenário
    // real em que o adapter já havia sido utilizado antes do crash.
    const recoveryAdapter = new FakeAdapter("failure");
    const primeContext = buildAdapterContext(interrupted[0]);
    await recoveryAdapter.execute(primeContext);
    const recovered = await recoverRun(interrupted[0], recoveryAdapter, runRepo);

    // Deve transitar para queued (via failed → queued)
    expect(recovered.state).toBe("queued");
    expect(recovered.attempt).toBe(1);

    // Verificar persistência do estado recuperado
    const persisted = await runRepo.getById(record.runId);
    expect(persisted!.state).toBe("queued");

    // Verificar metadata de recovery
    const recoveryMeta = persisted!.metadata?.recovery as Record<string, unknown> | undefined;
    expect(recoveryMeta).toBeDefined();
    expect(recoveryMeta?.action).toBeDefined();
  });

  it("recoveryLoop processa múltiplos runs interrompidos", async () => {
    const { runRepo } = setupRepos();

    // Criar 3 runs em estado "running" (simulando 3 processos interrompidos)
    for (let i = 1; i <= 3; i++) {
      const record = createQueuedRunRecord({
        runId: `e2e-run-${i}` as RunId,
        attempt: 1,
        maxAttempts: 3,
      });
      await runRepo.create(record);

      const runningRecord: RunRecord = {
        ...record,
        state: "running",
        attempt: 1,
        startedAt: new Date(),
        updatedAt: new Date(),
      };
      await runRepo.update(runningRecord);
    }

    // Todos devem ser detectados
    const interrupted = await detectInterruptedRuns(runRepo);
    expect(interrupted).toHaveLength(3);

    // Recovery com adapter que diz que todos remote succeeded.
    // Pre-executamos o adapter para que checkStatus() retorne o estado
    // correspondente ao modo ("succeeded"), simulando o cenário real em
    // que o adapter já havia sido utilizado antes do crash.
    const adapter = new FakeAdapter("success");
    const primeContext = buildAdapterContext(interrupted[0]);
    await adapter.execute(primeContext);
    const results = await recoveryLoop(adapter, runRepo);

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.newState).toBe("succeeded");
    }

    // Nenhum run interrompido permanece
    const remaining = await detectInterruptedRuns(runRepo);
    expect(remaining).toHaveLength(0);
  });

  it("recovery preserva waiting_manual — não recupera automaticamente", async () => {
    const { runRepo } = setupRepos();
    const record = createQueuedRunRecord({ attempt: 1 });
    await runRepo.create(record);

    // Simular run em waiting_manual
    const waitingRecord: RunRecord = {
      ...record,
      state: "waiting_manual",
      attempt: 1,
      updatedAt: new Date(),
    };
    await runRepo.update(waitingRecord);

    // Recovery não deve alterar waiting_manual
    const recovered = await recoverRun(waitingRecord, new FakeAdapter("success"), runRepo);
    expect(recovered.state).toBe("waiting_manual");
    expect(recovered.metadata?.recovery).toBeDefined();
    const recoveryMeta = recovered.metadata?.recovery as Record<string, unknown>;
    expect(recoveryMeta.action).toBe("skipped");
  });
});

// ─── T-08: Dry-run do adapter real — verificação de ausência de mutação ─────

describe("T-08: Dry-run do adapter real — verificação de ausência de mutação", () => {
  it("GbpDryRunAdapter em dry-run nunca envia HTTP request", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createQueuedRunRecord();
    const context = buildAdapterContext(record);

    // Executar em dry-run
    const result = await adapter.execute(context);

    // Resultado deve indicar dry-run
    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    const output = result.output as Record<string, unknown>;
    expect(output.dryRun).toBe(true);
    expect(output.postId).toBeDefined();
    expect(String(output.postId)).toMatch(/^dry-run-/);
    expect(result.requiresManual).toBe(false);

    // Verificar que checkStatus retorna succeeded (consistente)
    const status = await adapter.checkStatus(record.runId);
    expect(status.state).toBe("succeeded");
  });

  it("GbpDryRunAdapter createLocalPost em dry-run retorna dados simulados", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createQueuedRunRecord();
    const context = buildAdapterContext(record);

    const payload = {
      summary: "Test post for E2E",
      callToAction: "LEARN_MORE" as const,
      url: "https://example.com",
    };

    const result = await adapter.createLocalPost(context, payload, true);

    expect(result.dryRun).toBe(true);
    expect(result.summary).toBe("Test post for E2E");
    expect(result.callToAction).toBe("LEARN_MORE");
    expect(result.url).toBe("https://example.com");
    expect(result.postId).toMatch(/^dry-run-post-/);
  });

  it("GoogleBusinessProfileAdapter em dry-run mode retorna dados simulados sem mutação", async () => {
    const { GoogleBusinessProfileAdapter } = await import("./google-business-profile-adapter.js");
    const adapter = new GoogleBusinessProfileAdapter(true); // dryRun = true
    const record = createQueuedRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    const output = result.output as Record<string, unknown>;
    expect(output.dryRun).toBe(true);
    expect(result.requiresManual).toBe(false);
  });
});
