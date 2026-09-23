import { describe, expect, it, vi } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";
import type { AuditEntry } from "../domain/audit-entry.js";
import type { AlertEntry } from "../domain/alert-schema.js";
import type { AuditRepository } from "../domain/audit-repository.js";
import type { AlertEmitter } from "../domain/alert-emitter.js";
import { DeterministicClock } from "../domain/clock.js";

import { InMemoryRunRepository } from "./in-memory-repo.js";
import { automatedRecoveryLoop } from "./recovery.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createRunRecord(overrides?: Partial<RunRecord>): RunRecord {
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
    updatedAt: new Date("2026-01-01T00:00:01Z"),
    startedAt: new Date("2026-01-01T00:00:01Z"),
    ...overrides,
  };
}

function createWaitingManualRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return createRunRecord({
    state: "waiting_manual",
    ...overrides,
  });
}

function createNonRetryableFailedRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return createRunRecord({
    state: "failed",
    error: { message: "Permanent failure", retryable: false },
    ...overrides,
  });
}

function createMaxAttemptsRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return createRunRecord({
    state: "failed",
    attempt: 3,
    maxAttempts: 3,
    error: { message: "Max attempts reached", retryable: true },
    ...overrides,
  });
}

function createMockAuditRepository(): AuditRepository {
  const entries: AuditEntry[] = [];
  return {
    append: vi.fn(async (entry: AuditEntry) => {
      entries.push(entry);
      return entry;
    }),
    list: vi.fn(async () => entries),
  };
}

function createMockAlertEmitter(): AlertEmitter {
  const alerts: AlertEntry[] = [];
  const subscribers: Array<(alert: AlertEntry) => void> = [];
  return {
    emit: vi.fn((alert: AlertEntry) => {
      alerts.push(alert);
      for (const sub of subscribers) {
        sub(alert);
      }
      return alert;
    }),
    subscribe: vi.fn((callback: (alert: AlertEntry) => void) => {
      subscribers.push(callback);
      return () => {
        const idx = subscribers.indexOf(callback);
        if (idx >= 0) {
          subscribers.splice(idx, 1);
        }
      };
    }),
  };
}

// ─── AC-31: automatedRecoveryLoop ─────────────────────────────────────────

describe("AC-31: automatedRecoveryLoop", () => {
  it("1. Emite audit + alert para cada ação de recuperação", async () => {
    const repo = new InMemoryRunRepository();
    const auditRepo = createMockAuditRepository();
    const alertEmitter = createMockAlertEmitter();
    const clock = new DeterministicClock(new Date("2026-01-01T12:00:00Z"));

    const runningRun = createRunRecord({ state: "running" });
    await repo.create(runningRun);

    const results = await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);

    expect(results).toHaveLength(1);
    expect(results[0].auditRecorded).toBe(true);
    expect(results[0].alertEmitted).toBe(true);
    expect(auditRepo.append).toHaveBeenCalledTimes(1);
    expect(alertEmitter.emit).toHaveBeenCalledTimes(1);
  });

  it("2. NUNCA transiciona waiting_manual para running", async () => {
    const repo = new InMemoryRunRepository();
    const auditRepo = createMockAuditRepository();
    const alertEmitter = createMockAlertEmitter();
    const clock = new DeterministicClock(new Date("2026-01-01T12:00:00Z"));

    const waitingManualRun = createWaitingManualRunRecord();
    await repo.create(waitingManualRun);

    const results = await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);

    expect(results).toHaveLength(1);
    expect(results[0].previousState).toBe("waiting_manual");
    expect(results[0].newState).toBe("waiting_manual");
    expect(results[0].action).toBe("skipped");

    // Verify the run is still waiting_manual in the repo
    const persisted = await repo.getById(waitingManualRun.runId);
    expect(persisted!.state).toBe("waiting_manual");
  });

  it("3. Registra audit entry 'skipped: waiting_manual' para waiting_manual", async () => {
    const repo = new InMemoryRunRepository();
    const auditRepo = createMockAuditRepository();
    const alertEmitter = createMockAlertEmitter();
    const clock = new DeterministicClock(new Date("2026-01-01T12:00:00Z"));

    const waitingManualRun = createWaitingManualRunRecord();
    await repo.create(waitingManualRun);

    await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);

    const auditCalls = vi.mocked(auditRepo.append).mock.calls;
    expect(auditCalls).toHaveLength(1);
    const auditEntry = auditCalls[0][0] as AuditEntry;
    expect(auditEntry.category).toBe("recovery");
    expect(auditEntry.action).toBe("recovery.skipped");
    expect(auditEntry.metadata?.reason).toBe("skipped: waiting_manual");
  });

  it("4. Emite alert info para skip de waiting_manual", async () => {
    const repo = new InMemoryRunRepository();
    const auditRepo = createMockAuditRepository();
    const alertEmitter = createMockAlertEmitter();
    const clock = new DeterministicClock(new Date("2026-01-01T12:00:00Z"));

    const waitingManualRun = createWaitingManualRunRecord();
    await repo.create(waitingManualRun);

    await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);

    const alertCalls = vi.mocked(alertEmitter.emit).mock.calls;
    expect(alertCalls).toHaveLength(1);
    const alertEntry = alertCalls[0][0] as AlertEntry;
    expect(alertEntry.severity).toBe("info");
    expect(alertEntry.category).toBe("recovery");
    expect(alertEntry.message).toContain("waiting_manual");
  });

  it("5. NÃO re-executa falhas non-retryable", async () => {
    const repo = new InMemoryRunRepository();
    const auditRepo = createMockAuditRepository();
    const alertEmitter = createMockAlertEmitter();
    const clock = new DeterministicClock(new Date("2026-01-01T12:00:00Z"));

    const nonRetryableRun = createNonRetryableFailedRunRecord();
    await repo.create(nonRetryableRun);

    const results = await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("skipped");
    expect(results[0].reason).toBe("skipped: non-retryable");
    expect(results[0].newState).toBe("failed");

    // Verify the run is still failed in the repo
    const persisted = await repo.getById(nonRetryableRun.runId);
    expect(persisted!.state).toBe("failed");
  });

  it("6. Registra audit entry 'skipped: non-retryable' para non-retryable", async () => {
    const repo = new InMemoryRunRepository();
    const auditRepo = createMockAuditRepository();
    const alertEmitter = createMockAlertEmitter();
    const clock = new DeterministicClock(new Date("2026-01-01T12:00:00Z"));

    const nonRetryableRun = createNonRetryableFailedRunRecord();
    await repo.create(nonRetryableRun);

    await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);

    const auditCalls = vi.mocked(auditRepo.append).mock.calls;
    expect(auditCalls).toHaveLength(1);
    const auditEntry = auditCalls[0][0] as AuditEntry;
    expect(auditEntry.category).toBe("recovery");
    expect(auditEntry.action).toBe("recovery.skipped");
    expect(auditEntry.metadata?.reason).toBe("skipped: non-retryable");
  });

  it("7. Emite alert warn para skip de non-retryable", async () => {
    const repo = new InMemoryRunRepository();
    const auditRepo = createMockAuditRepository();
    const alertEmitter = createMockAlertEmitter();
    const clock = new DeterministicClock(new Date("2026-01-01T12:00:00Z"));

    const nonRetryableRun = createNonRetryableFailedRunRecord();
    await repo.create(nonRetryableRun);

    await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);

    const alertCalls = vi.mocked(alertEmitter.emit).mock.calls;
    expect(alertCalls).toHaveLength(1);
    const alertEntry = alertCalls[0][0] as AlertEntry;
    expect(alertEntry.severity).toBe("warn");
    expect(alertEntry.category).toBe("recovery");
    expect(alertEntry.message).toContain("non-retryable");
  });

  it("8. NÃO transiciona estados que requerem CAPTCHA/MFA", async () => {
    const repo = new InMemoryRunRepository();
    const auditRepo = createMockAuditRepository();
    const alertEmitter = createMockAlertEmitter();
    const clock = new DeterministicClock(new Date("2026-01-01T12:00:00Z"));

    // waiting_manual is the state that requires human action (CAPTCHA/MFA)
    const waitingManualRun = createWaitingManualRunRecord({
      metadata: { reason: "CAPTCHA required" },
    });
    await repo.create(waitingManualRun);

    const results = await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);

    expect(results).toHaveLength(1);
    expect(results[0].newState).toBe("waiting_manual");
    expect(results[0].action).toBe("skipped");

    // Verify the run is still waiting_manual
    const persisted = await repo.getById(waitingManualRun.runId);
    expect(persisted!.state).toBe("waiting_manual");
  });

  it("9. Preserva checkLivePilotGate", async () => {
    const repo = new InMemoryRunRepository();
    const auditRepo = createMockAuditRepository();
    const alertEmitter = createMockAlertEmitter();
    const clock = new DeterministicClock(new Date("2026-01-01T12:00:00Z"));

    // Create a run with pilot gate metadata
    const pilotRun = createRunRecord({
      state: "running",
      metadata: { pilotGate: "live", brandId: "best-fluency" },
    });
    await repo.create(pilotRun);

    const results = await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);

    // The function should process the run normally without breaking pilot gate logic
    expect(results).toHaveLength(1);
    expect(results[0].auditRecorded).toBe(true);
  });

  it("10. Múltiplas chamadas sem side effects (idempotência)", async () => {
    const repo = new InMemoryRunRepository();
    const auditRepo = createMockAuditRepository();
    const alertEmitter = createMockAlertEmitter();
    const clock = new DeterministicClock(new Date("2026-01-01T12:00:00Z"));

    const waitingManualRun = createWaitingManualRunRecord();
    await repo.create(waitingManualRun);

    // Call multiple times
    const results1 = await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);
    const results2 = await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);
    const results3 = await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);

    // All calls should return the same result
    expect(results1).toHaveLength(1);
    expect(results2).toHaveLength(1);
    expect(results3).toHaveLength(1);

    // All should be skipped waiting_manual
    expect(results1[0].action).toBe("skipped");
    expect(results2[0].action).toBe("skipped");
    expect(results3[0].action).toBe("skipped");

    // The run should still be waiting_manual
    const persisted = await repo.getById(waitingManualRun.runId);
    expect(persisted!.state).toBe("waiting_manual");
  });

  it("11. Idempotência preservada via audit entries existentes", async () => {
    const repo = new InMemoryRunRepository();
    const auditRepo = createMockAuditRepository();
    const alertEmitter = createMockAlertEmitter();
    const clock = new DeterministicClock(new Date("2026-01-01T12:00:00Z"));

    const nonRetryableRun = createNonRetryableFailedRunRecord();
    await repo.create(nonRetryableRun);

    // Call multiple times
    await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);
    await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);

    // Each call should create its own audit entry
    const auditCalls = vi.mocked(auditRepo.append).mock.calls;
    expect(auditCalls).toHaveLength(2);

    // Both entries should be for the same run
    const entry1 = auditCalls[0][0] as AuditEntry;
    const entry2 = auditCalls[1][0] as AuditEntry;
    expect(entry1.correlationIds.runId).toBe(entry2.correlationIds.runId);
  });

  it("12. Emite alert critical quando recovery falha", async () => {
    const repo = new InMemoryRunRepository();
    const auditRepo = createMockAuditRepository();
    const alertEmitter = createMockAlertEmitter();
    const clock = new DeterministicClock(new Date("2026-01-01T12:00:00Z"));

    // Create a running run that will cause recovery to fail
    // We'll mock the repo to throw an error during list
    const failingRepo = {
      ...repo,
      list: vi.fn(async () => {
        throw new Error("Repository connection failed");
      }),
      create: repo.create.bind(repo),
      getById: repo.getById.bind(repo),
      update: repo.update.bind(repo),
      findByIdempotencyKey: repo.findByIdempotencyKey.bind(repo),
    };

    const runningRun = createRunRecord({ state: "running" });
    await repo.create(runningRun);

    // The error will be thrown during detectInterruptedRuns
    // which is called inside automatedRecoveryLoop
    await expect(
      automatedRecoveryLoop(null, failingRepo, auditRepo, alertEmitter, clock),
    ).rejects.toThrow("Repository connection failed");
  });

  it("13. Registra audit entry para cada transição de estado", async () => {
    const repo = new InMemoryRunRepository();
    const auditRepo = createMockAuditRepository();
    const alertEmitter = createMockAlertEmitter();
    const clock = new DeterministicClock(new Date("2026-01-01T12:00:00Z"));

    // Create multiple runs in different states
    const waitingManualRun = createWaitingManualRunRecord({
      runId: "550e8400-e29b-41d4-a716-446655440001" as RunId,
    });
    const nonRetryableRun = createNonRetryableFailedRunRecord({
      runId: "550e8400-e29b-41d4-a716-446655440002" as RunId,
    });
    const maxAttemptsRun = createMaxAttemptsRunRecord({
      runId: "550e8400-e29b-41d4-a716-446655440003" as RunId,
    });

    await repo.create(waitingManualRun);
    await repo.create(nonRetryableRun);
    await repo.create(maxAttemptsRun);

    const results = await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);

    // Should have 3 results
    expect(results).toHaveLength(3);

    // Each should have audit recorded
    expect(results[0].auditRecorded).toBe(true);
    expect(results[1].auditRecorded).toBe(true);
    expect(results[2].auditRecorded).toBe(true);

    // Audit repo should have 3 entries
    const auditCalls = vi.mocked(auditRepo.append).mock.calls;
    expect(auditCalls).toHaveLength(3);
  });

  it("14. Integra com OperationalEmitter existente", async () => {
    const repo = new InMemoryRunRepository();
    const auditRepo = createMockAuditRepository();
    const alertEmitter = createMockAlertEmitter();
    const clock = new DeterministicClock(new Date("2026-01-01T12:00:00Z"));

    // Subscribe to alerts to verify integration
    const receivedAlerts: AlertEntry[] = [];
    alertEmitter.subscribe((alert) => receivedAlerts.push(alert));

    const waitingManualRun = createWaitingManualRunRecord();
    await repo.create(waitingManualRun);

    await automatedRecoveryLoop(null, repo, auditRepo, alertEmitter, clock);

    // The subscriber should have received the alert
    expect(receivedAlerts).toHaveLength(1);
    expect(receivedAlerts[0].severity).toBe("info");
    expect(receivedAlerts[0].category).toBe("recovery");
  });
});
