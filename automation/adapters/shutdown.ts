/**
 * Graceful shutdown handler.
 *
 * AC-38: Handler for SIGTERM/SIGINT that:
 * 1. Stops scheduling new runs
 * 2. Waits for running runs to complete (configurable timeout)
 * 3. Persists state
 * 4. Exits
 *
 * Configuration via SHUTDOWN_TIMEOUT_MS env var (default: 30000ms)
 */

import type { Clock } from "../domain/clock.js";
import type { RunRepository } from "../domain/repository.js";
import type { OperationalEmitter } from "../domain/operational-emitter.js";
import type { AuditRepository } from "../domain/audit-repository.js";
import { createOperationalEvent } from "../domain/operational-event.js";
import { createAuditEntry } from "../domain/audit-entry.js";

// --- Types ---

export interface ShutdownConfig {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface ShutdownDependencies {
  readonly repo: RunRepository;
  readonly emitter?: OperationalEmitter;
  readonly auditRepo?: AuditRepository;
  readonly clock?: Clock;
  readonly config?: Partial<ShutdownConfig>;
}

export interface ShutdownState {
  readonly isShuttingDown: boolean;
  readonly startedAt: Date | null;
  readonly pendingRuns: number;
}

export interface ShutdownResult {
  readonly success: boolean;
  readonly reason?: string;
  readonly pendingRuns: number;
}

// --- Default Config ---

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

// --- GracefulShutdown ---

export class GracefulShutdown {
  private state: ShutdownState = {
    isShuttingDown: false,
    startedAt: null,
    pendingRuns: 0,
  };

  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly repo: RunRepository;
  private readonly emitter?: OperationalEmitter;
  private readonly auditRepo?: AuditRepository;
  private readonly clock?: Clock;

  constructor(deps: ShutdownDependencies) {
    this.repo = deps.repo;
    this.emitter = deps.emitter;
    this.auditRepo = deps.auditRepo;
    this.clock = deps.clock;
    this.timeoutMs =
      deps.config?.timeoutMs ?? this.parseEnvTimeout() ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.pollIntervalMs = deps.config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  private parseEnvTimeout(): number | undefined {
    const envValue = process.env["SHUTDOWN_TIMEOUT_MS"];
    if (!envValue) {
      return undefined;
    }
    const parsed = parseInt(envValue, 10);
    return isNaN(parsed) || parsed < 0 ? undefined : parsed;
  }

  /**
   * Returns current shutdown state.
   */
  getState(): ShutdownState {
    return { ...this.state };
  }

  /**
   * Returns the configured timeout in milliseconds.
   */
  getTimeoutMs(): number {
    return this.timeoutMs;
  }

  /**
   * Initiates graceful shutdown.
   *
   * 1. Sets shutdown flag
   * 2. Emits system.shutdown event
   * 3. Waits for running runs to complete or timeout
   * 4. Returns shutdown result
   */
  async shutdown(): Promise<ShutdownResult> {
    if (this.state.isShuttingDown) {
      return {
        success: false,
        reason: "Already shutting down",
        pendingRuns: 0,
      };
    }

    const now = this.clock?.now() ?? new Date();

    this.state = {
      isShuttingDown: true,
      startedAt: now,
      pendingRuns: 0,
    };

    // Emit shutdown event
    await this.emitShutdownEvent();

    // Wait for running runs
    const result = await this.waitForRunningRuns();

    // Emit final event
    await this.emitShutdownCompleteEvent(result);

    return result;
  }

  /**
   * Checks if the system is shutting down.
   * Call this before scheduling new runs.
   */
  isShuttingDown(): boolean {
    return this.state.isShuttingDown;
  }

  private async waitForRunningRuns(): Promise<ShutdownResult> {
    const deadline = Date.now() + this.timeoutMs;

    while (Date.now() < deadline) {
      const runningRuns = await this.repo.list({ state: "running" });
      this.state = {
        ...this.state,
        pendingRuns: runningRuns.length,
      };

      if (runningRuns.length === 0) {
        return { success: true, pendingRuns: 0 };
      }

      await this.sleep(this.pollIntervalMs);
    }

    // Timeout reached
    const remaining = await this.repo.list({ state: "running" });

    return {
      success: false,
      reason: `Shutdown timeout: ${remaining.length} runs still pending`,
      pendingRuns: remaining.length,
    };
  }

  private async emitShutdownEvent(): Promise<void> {
    if (this.emitter) {
      const event = createOperationalEvent({
        level: "info",
        category: "system",
        name: "system.shutdown",
        message: "Graceful shutdown initiated",
        correlationIds: {},
        clock: this.clock,
      });

      this.emitter.emit(event);
    }

    if (this.auditRepo) {
      const entry = createAuditEntry({
        category: "system",
        action: "system.shutdown",
        actor: "system",
        correlationIds: {},
        clock: this.clock,
      });
      await this.auditRepo.append(entry);
    }
  }

  private async emitShutdownCompleteEvent(result: ShutdownResult): Promise<void> {
    if (!this.emitter) {
      return;
    }

    const event = createOperationalEvent({
      level: result.success ? "info" : "warn",
      category: "system",
      name: "system.shutdown",
      message: result.success
        ? "Graceful shutdown completed"
        : `Graceful shutdown timeout: ${result.pendingRuns} runs pending`,
      correlationIds: {},
      clock: this.clock,
    });

    this.emitter.emit(event);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

// --- Signal Handler Registration ---

export function registerShutdownHandlers(shutdown: GracefulShutdown): void {
  const handler = async (): Promise<void> => {
    try {
      console.log("[shutdown] Signal received, initiating graceful shutdown...");
      const result = await shutdown.shutdown();
      if (result.success) {
        console.log("[shutdown] All runs completed, exiting.");
        process.exit(0);
      } else {
        console.error(`[shutdown] Timeout: ${result.pendingRuns} runs still pending.`);
        process.exit(1);
      }
    } catch (err) {
      console.error("[shutdown] Fatal error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}
