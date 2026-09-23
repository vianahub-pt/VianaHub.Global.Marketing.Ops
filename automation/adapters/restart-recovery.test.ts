/**
 * Restart/Recovery Tests
 *
 * AC-44: Simulate crash during batch: recovery loop detects
 * interrupted runs, recovers correctly, audit trail preserved;
 * lock file remains and is NOT automatically cleaned.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileRunRepository } from "./file-run-repo.js";
import { FileAuditRepository } from "./file-audit-repo.js";
import { DeterministicClock } from "../domain/clock.js";
import { createRunId, computeIdempotencyKey } from "../domain/idempotency.js";
import type { PayloadFingerprint } from "../domain/idempotency.js";
import { automatedRecoveryLoop } from "./recovery.js";
import { createAlertEmitter } from "../domain/alert-emitter.js";

describe("Restart/Recovery Tests (AC-44)", () => {
  let tempDir: string;
  let runRepo: FileRunRepository;
  let auditRepo: FileAuditRepository;
  let clock: DeterministicClock;

  const identity = {
    brandId: "best-fluency",
    market: "PT",
    platform: "instagram",
    operation: "post",
  } as const;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "restart-recovery-"));
    clock = new DeterministicClock(new Date("2026-01-01T00:00:00Z"));
    runRepo = new FileRunRepository(join(tempDir, "runs"));
    auditRepo = new FileAuditRepository(join(tempDir, "audit"), clock);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ─── Scenario 1 ─────────────────────────────────────────────────────────────

  it("1. crash during batch → recovery detects interrupted runs", async () => {
    const runId1 = createRunId();
    const runId2 = createRunId();
    const runId3 = createRunId();

    // Item 1: succeeded before crash
    await runRepo.create({
      schemaVersion: 1,
      runId: runId1,
      ...identity,
      state: "succeeded",
      attempt: 1,
      maxAttempts: 3,
      idempotencyKey: computeIdempotencyKey(identity, { item: 1 }),
      payloadFingerprint: "fp-1" as PayloadFingerprint,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });

    // Item 2: running when crash occurred
    await runRepo.create({
      schemaVersion: 1,
      runId: runId2,
      ...identity,
      state: "running",
      attempt: 1,
      maxAttempts: 3,
      idempotencyKey: computeIdempotencyKey(identity, { item: 2 }),
      payloadFingerprint: "fp-2" as PayloadFingerprint,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });

    // Item 3: queued (not started)
    await runRepo.create({
      schemaVersion: 1,
      runId: runId3,
      ...identity,
      state: "queued",
      attempt: 0,
      maxAttempts: 3,
      idempotencyKey: computeIdempotencyKey(identity, { item: 3 }),
      payloadFingerprint: "fp-3" as PayloadFingerprint,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });

    const alertEmitter = createAlertEmitter(undefined, clock);
    const results = await automatedRecoveryLoop(null, runRepo, auditRepo, alertEmitter, clock);

    // Only item 2 (running) should be detected as needing recovery
    expect(results.length).toBeGreaterThanOrEqual(1);

    const item2Result = results.find((r) => r.runId === runId2);
    expect(item2Result).toBeDefined();
    expect(item2Result?.previousState).toBe("running");
  });

  // ─── Scenario 2 ─────────────────────────────────────────────────────────────

  it("2. recovery recovers item 2, preserves items 1 and 3", async () => {
    const runId1 = createRunId();
    const runId2 = createRunId();
    const runId3 = createRunId();

    await runRepo.create({
      schemaVersion: 1,
      runId: runId1,
      ...identity,
      state: "succeeded",
      attempt: 1,
      maxAttempts: 3,
      idempotencyKey: computeIdempotencyKey(identity, { item: 1 }),
      payloadFingerprint: "fp-1" as PayloadFingerprint,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });

    await runRepo.create({
      schemaVersion: 1,
      runId: runId2,
      ...identity,
      state: "running",
      attempt: 1,
      maxAttempts: 3,
      idempotencyKey: computeIdempotencyKey(identity, { item: 2 }),
      payloadFingerprint: "fp-2" as PayloadFingerprint,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });

    await runRepo.create({
      schemaVersion: 1,
      runId: runId3,
      ...identity,
      state: "queued",
      attempt: 0,
      maxAttempts: 3,
      idempotencyKey: computeIdempotencyKey(identity, { item: 3 }),
      payloadFingerprint: "fp-3" as PayloadFingerprint,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });

    const alertEmitter = createAlertEmitter(undefined, clock);
    await automatedRecoveryLoop(null, runRepo, auditRepo, alertEmitter, clock);

    // Item 1: still succeeded (terminal state — not touched by recovery)
    const item1 = await runRepo.getById(runId1);
    expect(item1?.state).toBe("succeeded");

    // Item 2: recovered — still running, but with recovery metadata attached
    const item2 = await runRepo.getById(runId2);
    expect(item2?.state).toBe("running");
    expect(item2?.metadata?.recovery).toBeDefined();

    // Item 3: still queued (not interrupted — not touched by recovery)
    const item3 = await runRepo.getById(runId3);
    expect(item3?.state).toBe("queued");
  });

  // ─── Scenario 3 ─────────────────────────────────────────────────────────────

  it("3. lock file remains after crash", async () => {
    // Create a lock file simulating a crash that left a lock behind
    const lockFile = join(tempDir, "runs", "test-run.lock");
    writeFileSync(lockFile, "12345");

    // Verify lock file exists before recovery
    expect(existsSync(lockFile)).toBe(true);

    // Run recovery (should NOT delete lock files)
    const alertEmitter = createAlertEmitter(undefined, clock);
    await automatedRecoveryLoop(null, runRepo, auditRepo, alertEmitter, clock);

    // Lock file must still exist — NEVER automatically cleaned
    expect(existsSync(lockFile)).toBe(true);
  });

  // ─── Scenario 4 ─────────────────────────────────────────────────────────────

  it("4. next startup detects lock → actionable error", async () => {
    // Use fake timers to skip the exponential backoff delays (~27s total)
    // without waiting in real time. The test verifies lock detection,
    // not backoff behavior.
    vi.useFakeTimers();

    try {
      const runId = createRunId();

      // Create a lock file simulating a crash that left a lock behind
      const lockFile = join(tempDir, "runs", `${runId}.lock`);
      writeFileSync(lockFile, "99999");

      expect(existsSync(lockFile)).toBe(true);

      // Start the create call — it will hit EEXIST and enter the retry loop
      const createPromise = runRepo.create({
        schemaVersion: 1,
        runId,
        ...identity,
        state: "queued",
        attempt: 0,
        maxAttempts: 3,
        idempotencyKey: computeIdempotencyKey(identity, { data: "test" }),
        payloadFingerprint: "fp-lock" as PayloadFingerprint,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });

      // Attach rejection handler BEFORE advancing timers to prevent
      // PromiseRejectionHandledWarning / unhandled rejection in Vitest
      const assertionsPromise = expect(createPromise).rejects.toThrow(/Lock contention/);

      // Advance timers by 30s to exhaust all 60 retry backoff delays
      // (max total: ~27s with exponential backoff capped at 500ms)
      await vi.advanceTimersByTimeAsync(30_000);

      await assertionsPromise;

      // Lock file must still exist after the failed attempt
      expect(existsSync(lockFile)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── Scenario 5 ─────────────────────────────────────────────────────────────

  it("5. audit trail preserved after recovery", async () => {
    const runId = createRunId();

    await runRepo.create({
      schemaVersion: 1,
      runId,
      ...identity,
      state: "running",
      attempt: 1,
      maxAttempts: 3,
      idempotencyKey: computeIdempotencyKey(identity, { data: "test" }),
      payloadFingerprint: "fp-audit" as PayloadFingerprint,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });

    const alertEmitter = createAlertEmitter(undefined, clock);
    await automatedRecoveryLoop(null, runRepo, auditRepo, alertEmitter, clock);

    // Verify audit entries were created for this run
    const auditEntries = await auditRepo.listByCorrelation({ runId });
    expect(auditEntries.length).toBeGreaterThan(0);

    // Verify the audit entry has the expected recovery action
    const recoveryEntry = auditEntries.find((e) => e.action.startsWith("recovery."));
    expect(recoveryEntry).toBeDefined();
    expect(recoveryEntry?.correlationIds.runId).toBe(runId);
    expect(recoveryEntry?.category).toBe("recovery");
  });
});
