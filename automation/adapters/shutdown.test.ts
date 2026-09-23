import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GracefulShutdown, registerShutdownHandlers } from "./shutdown.js";
import type { ShutdownDependencies } from "./shutdown.js";
import type { RunRepository } from "../domain/repository.js";
import type { OperationalEmitter } from "../domain/operational-emitter.js";
import type { AuditRepository } from "../domain/audit-repository.js";
import type { RunRecord } from "../domain/run-record.js";

// --- Helpers ---

function createMockRepo(runningRuns: RunRecord[] = []): RunRepository {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    list: vi.fn().mockResolvedValue(runningRuns),
    findByIdempotencyKey: vi.fn(),
  };
}

function createMockEmitter(): OperationalEmitter {
  return {
    emit: vi.fn(),
    subscribe: vi.fn(),
  };
}

function createMockAuditRepo(): AuditRepository {
  return {
    append: vi.fn().mockResolvedValue(undefined),
  };
}

function createDeps(overrides?: Partial<ShutdownDependencies>): ShutdownDependencies {
  return {
    repo: createMockRepo(),
    ...overrides,
  };
}

// --- Tests ---

describe("GracefulShutdown", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = originalEnv;
  });

  it("should complete immediately when no pending runs", async () => {
    const deps = createDeps();
    const shutdown = new GracefulShutdown(deps);

    const result = await shutdown.shutdown();

    expect(result.success).toBe(true);
    expect(result.pendingRuns).toBe(0);
  });

  it("should wait for pending runs to complete", async () => {
    let runningRuns: RunRecord[] = [{ runId: "run-1" } as RunRecord];

    const repo: RunRepository = {
      create: vi.fn(),
      getById: vi.fn(),
      update: vi.fn(),
      list: vi.fn().mockImplementation(async () => runningRuns),
      findByIdempotencyKey: vi.fn(),
    };

    const deps = createDeps({ repo });
    const shutdown = new GracefulShutdown(deps);

    // Simulate run completing after first poll
    setTimeout(() => {
      runningRuns = [];
    }, 1500);

    const resultPromise = shutdown.shutdown();
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.pendingRuns).toBe(0);
  });

  it("should timeout with pending runs", async () => {
    const runningRuns: RunRecord[] = [{ runId: "run-1" } as RunRecord];

    const repo: RunRepository = {
      create: vi.fn(),
      getById: vi.fn(),
      update: vi.fn(),
      list: vi.fn().mockResolvedValue(runningRuns),
      findByIdempotencyKey: vi.fn(),
    };

    const deps = createDeps({
      repo,
      config: { timeoutMs: 5000, pollIntervalMs: 1000 },
    });
    const shutdown = new GracefulShutdown(deps);

    const resultPromise = shutdown.shutdown();
    await vi.advanceTimersByTimeAsync(6000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.pendingRuns).toBe(1);
    expect(result.reason).toContain("timeout");
  });

  it("should return isShuttingDown=true after shutdown() is called", async () => {
    const deps = createDeps();
    const shutdown = new GracefulShutdown(deps);

    expect(shutdown.isShuttingDown()).toBe(false);

    const shutdownPromise = shutdown.shutdown();

    // Check immediately after calling shutdown (before it completes)
    expect(shutdown.isShuttingDown()).toBe(true);

    await shutdownPromise;
  });

  it("should register SIGTERM and SIGINT handlers", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    const deps = createDeps();
    const shutdown = new GracefulShutdown(deps);

    registerShutdownHandlers(shutdown);

    expect(onSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));

    onSpy.mockRestore();
  });

  it("should emit system.shutdown event on shutdown", async () => {
    const emitter = createMockEmitter();
    const deps = createDeps({ emitter });
    const shutdown = new GracefulShutdown(deps);

    await shutdown.shutdown();

    // Should emit 2 events: init + complete
    expect(emitter.emit).toHaveBeenCalledTimes(2);

    const firstEvent = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(firstEvent.name).toBe("system.shutdown");
    expect(firstEvent.message).toBe("Graceful shutdown initiated");
  });

  it("should emit audit entry on shutdown", async () => {
    const auditRepo = createMockAuditRepo();
    const deps = createDeps({ auditRepo });
    const shutdown = new GracefulShutdown(deps);

    await shutdown.shutdown();

    expect(auditRepo.append).toHaveBeenCalledTimes(1);

    const entry = (auditRepo.append as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(entry.action).toBe("system.shutdown");
    expect(entry.actor).toBe("system");
  });

  it("should respect SHUTDOWN_TIMEOUT_MS env var", () => {
    process.env["SHUTDOWN_TIMEOUT_MS"] = "15000";

    const deps = createDeps();
    const shutdown = new GracefulShutdown(deps);

    expect(shutdown.getTimeoutMs()).toBe(15000);
  });

  it("should use default timeout of 30000ms", () => {
    delete process.env["SHUTDOWN_TIMEOUT_MS"];

    const deps = createDeps();
    const shutdown = new GracefulShutdown(deps);

    expect(shutdown.getTimeoutMs()).toBe(30_000);
  });
});
