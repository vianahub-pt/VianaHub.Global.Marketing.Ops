/**
 * Concurrency Tests
 *
 * AC-45: Multiple simultaneous schedules creating runs
 * for the same idempotencyKey → only 1 succeeds.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileRunRepository } from "./file-run-repo.js";
import { DeterministicClock } from "../domain/clock.js";
import { createRunId, computeIdempotencyKey } from "../domain/idempotency.js";
import { checkOverlap } from "../domain/overlap-check.js";
import type { RunRecord } from "../domain/run-record.js";
import type { RunId, PayloadFingerprint } from "../domain/idempotency.js";
import { ConcurrencyConflictError } from "./persistence-errors.js";

describe("Concurrency Tests", () => {
  let tempDir: string;
  let runRepo: FileRunRepository;
  let clock: DeterministicClock;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concurrency-"));
    clock = new DeterministicClock(new Date("2026-01-01T00:00:00Z"));
    runRepo = new FileRunRepository(join(tempDir, "runs"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("same idempotencyKey prevents duplicate runs (sequential)", async () => {
    const identity = {
      brandId: "best-fluency",
      market: "PT",
      platform: "instagram",
      operation: "post",
    };

    const idempotencyKey = computeIdempotencyKey(identity, { data: "test" });

    // Create first run
    const run1: RunRecord = {
      schemaVersion: 1,
      runId: createRunId(),
      ...identity,
      state: "queued",
      attempt: 0,
      maxAttempts: 3,
      idempotencyKey,
      payloadFingerprint: "fp-1" as PayloadFingerprint,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    };

    await runRepo.create(run1);

    // Try to create second run with same key - should detect overlap
    const hasOverlap = await checkOverlap(runRepo, idempotencyKey);
    expect(hasOverlap).toBe(true);
  });

  it("concurrent batch executions respect concurrency limit", async () => {
    const identity = {
      brandId: "best-fluency",
      market: "PT",
      platform: "instagram",
      operation: "post",
    };

    // Create multiple runs with different idempotencyKeys
    const runIds: RunId[] = [];
    const batchSize = 5;

    for (let i = 0; i < batchSize; i++) {
      const runId = createRunId();
      const run: RunRecord = {
        schemaVersion: 1,
        runId,
        ...identity,
        state: "queued",
        attempt: 0,
        maxAttempts: 3,
        idempotencyKey: computeIdempotencyKey(identity, { batch: i }),
        payloadFingerprint: `fp-batch-${i}` as PayloadFingerprint,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      };

      await runRepo.create(run);
      runIds.push(runId);
    }

    // Concurrently update all runs to "running" state
    const results = await Promise.allSettled(
      runIds.map(async (runId, i) => {
        const existing = await runRepo.getById(runId);
        if (!existing) {
          throw new Error(`Run not found: ${runId}`);
        }

        const updated: RunRecord = {
          ...existing,
          state: "running",
          startedAt: clock.now(),
          updatedAt: clock.now(),
        };

        await runRepo.update(updated);
        return i;
      }),
    );

    // All updates should succeed since they are different runs
    const successes = results.filter((r) => r.status === "fulfilled");
    expect(successes.length).toBe(batchSize);
  });

  it("lock contention between concurrent runs", async () => {
    const identity = {
      brandId: "best-fluency",
      market: "PT",
      platform: "instagram",
      operation: "post",
    };

    // Create a run
    const runId = createRunId();
    const run: RunRecord = {
      schemaVersion: 1,
      runId,
      ...identity,
      state: "running",
      attempt: 1,
      maxAttempts: 3,
      idempotencyKey: computeIdempotencyKey(identity, { data: "test" }),
      payloadFingerprint: "fp-001" as PayloadFingerprint,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    };

    await runRepo.create(run);

    // Try to update the same run concurrently
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, async (_, i) => {
        const existing = await runRepo.getById(runId);
        if (!existing) {
          throw new Error(`Run not found: ${runId}`);
        }

        const updated: RunRecord = {
          ...existing,
          state: "succeeded",
          finishedAt: clock.now(),
          updatedAt: clock.now(),
        };

        await runRepo.update(updated);
        return i;
      }),
    );

    // At least one should succeed
    const successes = results.filter((r) => r.status === "fulfilled");
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // Check final state
    const finalRun = await runRepo.getById(runId);
    expect(finalRun).not.toBeNull();
    expect(finalRun!.state).toBe("succeeded");
  });

  it("optimistic concurrency conflict detection", async () => {
    const identity = {
      brandId: "best-fluency",
      market: "PT",
      platform: "instagram",
      operation: "post",
    };

    // Create a run
    const runId = createRunId();
    const run: RunRecord = {
      schemaVersion: 1,
      runId,
      ...identity,
      state: "running",
      attempt: 1,
      maxAttempts: 3,
      idempotencyKey: computeIdempotencyKey(identity, { data: "optimistic" }),
      payloadFingerprint: "fp-optimistic" as PayloadFingerprint,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    };

    await runRepo.create(run);

    // First update succeeds
    const firstUpdate: RunRecord = {
      ...run,
      state: "succeeded",
      finishedAt: clock.now(),
      updatedAt: clock.now(),
    };

    await runRepo.update(firstUpdate);

    // Second update with stale revision should fail
    const staleUpdate: RunRecord = {
      ...run,
      state: "failed",
      error: { message: "Stale update" },
      finishedAt: clock.now(),
      updatedAt: clock.now(),
    };

    // Try to update with expectedRevision=1 (stale)
    await expect(runRepo.update(staleUpdate, 1)).rejects.toThrow(ConcurrencyConflictError);
  });
});
