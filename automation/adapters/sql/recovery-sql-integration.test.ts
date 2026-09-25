/**
 * Env-gated SQL integration tests — AC-44 (restart/recuperação SQL).
 *
 * These tests exercise `recoverRun` and `recoveryLoop` from
 * `automation/adapters/recovery.ts` against a real SQL Server database
 * through `SqlRunRepository`.
 *
 * The tests verify that recovery logic correctly detects interrupted runs,
 * evaluates recovery strategies, and transitions run states through SQL
 * persistence — covering AC-43 (idempotência) and AC-44 (restart/recovery).
 *
 * Every test is skipped unless `SQL_INTEGRATION_URL` is set (AC-50).
 * The URL must point to a NON-production integration database.
 * No credentials live in this file; the connection string comes
 * exclusively from the operator's environment.
 *
 * Setup/teardown: creates runs via `SqlRunRepository`, cleans up after
 * each test. If `SQL_INTEGRATION_URL` is not defined, all tests are
 * skipped (exit 0).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../../domain/idempotency.js";
import type { RunRecord } from "../../domain/run-record.js";
import type { PlatformAdapter, StatusCheckResult } from "../platform-adapter.js";
import { detectInterruptedRuns, recoveryLoop, recoverRun } from "../recovery.js";

import { createSqlExecutor, type SqlExecutor } from "./sql-pool.js";
import { SqlRunRepository } from "./sql-run-repo.js";

// ─── SQL connection helpers ──────────────────────────────────────────────────

function parseConnectionString(url: string): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
} {
  const parts = Object.fromEntries(
    url
      .split(";")
      .filter((p) => p.trim().length > 0)
      .map((p) => {
        const eqIndex = p.indexOf("=");
        if (eqIndex === -1) {
          return [p.trim().toLowerCase(), ""];
        }
        return [p.slice(0, eqIndex).trim().toLowerCase(), p.slice(eqIndex + 1).trim()];
      }),
  );

  const ALLOWED_KEYS = new Set([
    "data source",
    "server",
    "initial catalog",
    "database",
    "user id",
    "uid",
    "password",
    "pwd",
    "encrypt",
    "trustservercertificate",
    "connection timeout",
    "multipleactiveresultsets",
  ]);
  for (const key of Object.keys(parts)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Unexpected parameter in SQL_INTEGRATION_URL: ${key}`);
    }
  }

  const serverPart = parts["server"] ?? parts["data source"] ?? "localhost";
  const hostPort = serverPart.split(",");
  const host = hostPort[0] ?? "localhost";
  const port = hostPort[1] ? Number(hostPort[1]) : 1433;
  const database = parts["database"] ?? parts["initial catalog"] ?? "test";
  const user = parts["user id"] ?? parts["uid"];
  if (!user) {
    throw new Error("SQL_INTEGRATION_URL must contain a User ID or UID parameter");
  }
  const password = parts["password"] ?? parts["pwd"] ?? "";

  return { host, port, database, user, password };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let nextSequence = 0;

function makeRunId(): RunId {
  nextSequence += 1;
  return `recovery-sql-${Date.now()}-${nextSequence}` as RunId;
}

function makeIdempotencyKey(): IdempotencyKey {
  nextSequence += 1;
  return `recovery-idem-${Date.now()}-${nextSequence}` as IdempotencyKey;
}

function createRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date();
  return {
    schemaVersion: 1,
    runId: makeRunId(),
    brandId: "best-fluency",
    market: "PT",
    platform: "google-business-profile",
    operation: "createLocalPost",
    state: "queued",
    attempt: 0,
    maxAttempts: 3,
    idempotencyKey: makeIdempotencyKey(),
    payloadFingerprint: "a".repeat(64) as PayloadFingerprint,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ─── Adapter helpers ─────────────────────────────────────────────────────────

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

// ─── Test suite ──────────────────────────────────────────────────────────────

describe.skipIf(!process.env.SQL_INTEGRATION_URL)(
  "Recovery SQL Integration (AC-44, env-gated)",
  () => {
    let executor: SqlExecutor;
    let repo: SqlRunRepository;
    const createdRunIds: RunId[] = [];

    beforeAll(async () => {
      const url = process.env.SQL_INTEGRATION_URL ?? "";
      const config = parseConnectionString(url);
      executor = await createSqlExecutor(config);
      repo = new SqlRunRepository(executor);
    });

    afterAll(async () => {
      await executor?.close();
    });

    afterEach(async () => {
      // Cleanup: delete all runs created during the test
      for (const runId of createdRunIds) {
        try {
          await executor.query("DELETE FROM dbo.Runs WHERE RunId = @runId", { runId });
        } catch {
          // Best-effort cleanup
        }
      }
      createdRunIds.length = 0;
    });

    // Helper: create a run and track it for cleanup
    async function seedRun(record: RunRecord): Promise<RunRecord> {
      createdRunIds.push(record.runId);
      return repo.create(record);
    }

    // Helper: transition a run to a specific state via SQL update
    async function forceState(
      runId: RunId,
      state: RunRecord["state"],
      overrides: Partial<RunRecord> = {},
    ): Promise<void> {
      const record = await repo.getById(runId);
      if (!record) {
        throw new Error(`Run not found: ${runId}`);
      }

      const now = new Date();
      const updated: RunRecord = {
        ...record,
        state,
        updatedAt: now,
        ...(state === "running" ? { startedAt: now } : {}),
        ...(state === "succeeded" || state === "failed" || state === "cancelled"
          ? { finishedAt: now }
          : {}),
        ...overrides,
      };
      await repo.update(updated);
    }

    // ─── AC-44: Cenário 1 — running → recovery detecta → transição correta ───

    it("run running → recovery detecta → transição correta via SQL repo", async () => {
      const record = createRunRecord({ attempt: 1, maxAttempts: 3 });
      await seedRun(record);
      await forceState(record.runId, "running");

      // Verify it's detected as interrupted
      const interrupted = await detectInterruptedRuns(repo);
      const found = interrupted.find((r) => r.runId === record.runId);
      expect(found).toBeDefined();
      expect(found!.state).toBe("running");

      // Recover with adapter reporting success
      const adapter = createAdapterWithStatus({ state: "succeeded" });
      const recovered = await recoverRun(found!, adapter, repo);

      expect(recovered.state).toBe("succeeded");
      expect(recovered.runId).toBe(record.runId);

      // Verify persisted state
      const persisted = await repo.getById(record.runId);
      expect(persisted).not.toBeNull();
      expect(persisted!.state).toBe("succeeded");
      expect(persisted!.metadata).toBeDefined();
      expect((persisted!.metadata as Record<string, unknown>)["recovery"]).toBeDefined();
    });

    // ─── AC-44: Cenário 2 — failed retryable → recovery → queued ─────────────

    it("run failed retryable → recovery → failed → queued via SQL repo", async () => {
      const record = createRunRecord({
        attempt: 1,
        maxAttempts: 3,
        state: "failed",
        error: { message: "Timeout", retryable: true },
        finishedAt: new Date(),
      });
      await seedRun(record);

      // Verify it's detected as interrupted (failed + retryable + attempt < max)
      const interrupted = await detectInterruptedRuns(repo);
      const found = interrupted.find((r) => r.runId === record.runId);
      expect(found).toBeDefined();
      expect(found!.state).toBe("failed");
      expect(found!.error?.retryable).toBe(true);

      // Recover — no adapter needed for failed → queued
      const recovered = await recoverRun(found!, null, repo);

      expect(recovered.state).toBe("queued");
      expect(recovered.runId).toBe(record.runId);
      expect(recovered.attempt).toBe(1); // attempt preserved

      // Verify persisted state
      const persisted = await repo.getById(record.runId);
      expect(persisted).not.toBeNull();
      expect(persisted!.state).toBe("queued");
      expect(persisted!.metadata).toBeDefined();
      const recoveryMeta = (persisted!.metadata as Record<string, unknown>)["recovery"] as Record<
        string,
        unknown
      >;
      expect(recoveryMeta).toBeDefined();
      expect(recoveryMeta["action"]).toBe("retry");
    });

    // ─── AC-44: Cenário 3 — waiting_manual → recovery preserva (skip) ────────

    it("run waiting_manual → recovery preserva via SQL repo", async () => {
      const record = createRunRecord({
        attempt: 1,
        maxAttempts: 3,
        state: "waiting_manual",
        startedAt: new Date(),
      });
      await seedRun(record);

      // waiting_manual is not in detectInterruptedRuns (only running + failed retryable)
      // But recoveryLoop includes waiting_manual runs
      const adapter = createAdapterWithStatus({ state: "waiting_manual" });
      const results = await recoveryLoop(adapter, repo);

      const result = results.find((r) => r.runId === record.runId);
      expect(result).toBeDefined();
      expect(result!.newState).toBe("waiting_manual");
      expect(result!.action).toBe("skipped");

      // Verify persisted state unchanged
      const persisted = await repo.getById(record.runId);
      expect(persisted).not.toBeNull();
      expect(persisted!.state).toBe("waiting_manual");

      // Verify recovery metadata was recorded
      const recoveryMeta = (persisted!.metadata as Record<string, unknown>)["recovery"] as Record<
        string,
        unknown
      >;
      expect(recoveryMeta).toBeDefined();
      expect(recoveryMeta["action"]).toBe("skipped");
      expect(recoveryMeta["idempotencyKey"]).toBe(record.idempotencyKey);
    });

    // ─── AC-44: Cenário 4 — succeeded/cancelled → recovery ignora ────────────

    it("run succeeded → recovery ignora via SQL repo", async () => {
      const record = createRunRecord({
        attempt: 1,
        maxAttempts: 3,
        state: "succeeded",
        startedAt: new Date(),
        finishedAt: new Date(),
      });
      await seedRun(record);

      // Terminal states are NOT detected as interrupted
      const interrupted = await detectInterruptedRuns(repo);
      const found = interrupted.find((r) => r.runId === record.runId);
      expect(found).toBeUndefined();

      // recoveryLoop should not process it either (it only processes
      // interrupted + waiting_manual)
      const adapter = createAdapterWithStatus({ state: "succeeded" });
      const results = await recoveryLoop(adapter, repo);

      const result = results.find((r) => r.runId === record.runId);
      expect(result).toBeUndefined();

      // Verify state unchanged
      const persisted = await repo.getById(record.runId);
      expect(persisted).not.toBeNull();
      expect(persisted!.state).toBe("succeeded");
    });

    it("run cancelled → recovery ignora via SQL repo", async () => {
      const record = createRunRecord({
        attempt: 1,
        maxAttempts: 3,
        state: "cancelled",
        startedAt: new Date(),
        finishedAt: new Date(),
      });
      await seedRun(record);

      const interrupted = await detectInterruptedRuns(repo);
      const found = interrupted.find((r) => r.runId === record.runId);
      expect(found).toBeUndefined();

      const adapter = createAdapterWithStatus({ state: "cancelled" });
      const results = await recoveryLoop(adapter, repo);

      const result = results.find((r) => r.runId === record.runId);
      expect(result).toBeUndefined();

      const persisted = await repo.getById(record.runId);
      expect(persisted).not.toBeNull();
      expect(persisted!.state).toBe("cancelled");
    });

    // ─── AC-44: Cenário 5 — Idempotência preservada após recovery ────────────

    it("idempotencyKey preservado após recovery via SQL repo", async () => {
      const idempotencyKey = ("idem-recovery-preserved-" + Date.now()) as IdempotencyKey;
      const payloadFingerprint = "b".repeat(64) as PayloadFingerprint;

      const record = createRunRecord({
        attempt: 1,
        maxAttempts: 3,
        idempotencyKey,
        payloadFingerprint,
      });
      await seedRun(record);
      await forceState(record.runId, "running");

      // Recover
      const adapter = createAdapterWithStatus({ state: "succeeded" });
      const interrupted = await detectInterruptedRuns(repo);
      const found = interrupted.find((r) => r.runId === record.runId);
      expect(found).toBeDefined();

      const recovered = await recoverRun(found!, adapter, repo);

      // IdempotencyKey and payloadFingerprint unchanged
      expect(recovered.idempotencyKey).toBe(idempotencyKey);
      expect(recovered.payloadFingerprint).toBe(payloadFingerprint);

      // Verify persisted
      const persisted = await repo.getById(record.runId);
      expect(persisted).not.toBeNull();
      expect(persisted!.idempotencyKey).toBe(idempotencyKey);
      expect(persisted!.payloadFingerprint).toBe(payloadFingerprint);

      // Verify findByIdempotencyKey still works
      const foundByKey = await repo.findByIdempotencyKey(idempotencyKey);
      expect(foundByKey).not.toBeNull();
      expect(foundByKey!.runId).toBe(record.runId);
    });

    // ─── AC-44: Cenário 6 — recoveryLoop com SQL repo ────────────────────────

    it("recoveryLoop com SQL repo — detecta + recupera múltiplos runs", async () => {
      // Create a running run
      const runningRecord = createRunRecord({ attempt: 1, maxAttempts: 3 });
      await seedRun(runningRecord);
      await forceState(runningRecord.runId, "running");

      // Create a failed retryable run
      const failedRecord = createRunRecord({
        attempt: 1,
        maxAttempts: 3,
        state: "failed",
        error: { message: "Network error", retryable: true },
        finishedAt: new Date(),
      });
      await seedRun(failedRecord);

      // Create a waiting_manual run (recoveryLoop includes these)
      const waitingRecord = createRunRecord({
        attempt: 1,
        maxAttempts: 3,
        state: "waiting_manual",
        startedAt: new Date(),
      });
      await seedRun(waitingRecord);

      // Run recoveryLoop with adapter confirming running succeeded
      const adapter = createAdapterWithStatus({ state: "succeeded" });
      const results = await recoveryLoop(adapter, repo);

      // Should process all 3 runs
      expect(results.length).toBeGreaterThanOrEqual(3);

      // Running run → succeeded
      const runningResult = results.find((r) => r.runId === runningRecord.runId);
      expect(runningResult).toBeDefined();
      expect(runningResult!.previousState).toBe("running");
      expect(runningResult!.newState).toBe("succeeded");

      // Failed retryable → queued
      const failedResult = results.find((r) => r.runId === failedRecord.runId);
      expect(failedResult).toBeDefined();
      expect(failedResult!.previousState).toBe("failed");
      expect(failedResult!.newState).toBe("queued");

      // Waiting manual → preserved
      const waitingResult = results.find((r) => r.runId === waitingRecord.runId);
      expect(waitingResult).toBeDefined();
      expect(waitingResult!.previousState).toBe("waiting_manual");
      expect(waitingResult!.newState).toBe("waiting_manual");
      expect(waitingResult!.action).toBe("skipped");

      // Verify persisted states
      const persistedRunning = await repo.getById(runningRecord.runId);
      expect(persistedRunning!.state).toBe("succeeded");

      const persistedFailed = await repo.getById(failedRecord.runId);
      expect(persistedFailed!.state).toBe("queued");

      const persistedWaiting = await repo.getById(waitingRecord.runId);
      expect(persistedWaiting!.state).toBe("waiting_manual");

      // No more interrupted runs
      const remaining = await detectInterruptedRuns(repo);
      const remainingIds = remaining.map((r) => r.runId);
      expect(remainingIds).not.toContain(runningRecord.runId);
      expect(remainingIds).not.toContain(failedRecord.runId);
    });
  },
);
