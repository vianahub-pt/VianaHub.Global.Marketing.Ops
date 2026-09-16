import type { RunId } from "../domain/idempotency.js";
import type { RunState } from "../domain/run-state.js";

import type {
  AdapterContext,
  AdapterResult,
  PlatformAdapter,
  StatusCheckResult,
} from "./platform-adapter.js";

// ─── Mode ────────────────────────────────────────────────────────────────────

export type FakeAdapterMode = "success" | "failure" | "manual" | "permanentFailure";

// ─── FakeAdapter ─────────────────────────────────────────────────────────────

/**
 * Deterministic adapter for testing the execution pipeline.
 *
 * Every mode produces a predictable outcome:
 *  - `success`            → success: true
 *  - `failure`            → success: false, error.retryable: true
 *  - `manual`             → requiresManual: true
 *  - `permanentFailure`   → success: false, error.retryable: false
 *
 * `checkStatus()` always returns a state consistent with the last `execute()`.
 */
export class FakeAdapter implements PlatformAdapter {
  private readonly mode: FakeAdapterMode;
  private lastRunId: RunId | undefined;
  private lastResult: AdapterResult | undefined;

  constructor(mode: FakeAdapterMode = "success") {
    this.mode = mode;
  }

  async execute(context: AdapterContext): Promise<AdapterResult> {
    this.lastRunId = context.runId;

    switch (this.mode) {
      case "success": {
        const result: AdapterResult = { success: true, requiresManual: false };
        this.lastResult = result;
        return result;
      }

      case "failure": {
        const result: AdapterResult = {
          success: false,
          error: {
            message: "Simulated transient failure",
            code: "FAKE_TRANSIENT",
            retryable: true,
          },
          requiresManual: false,
        };
        this.lastResult = result;
        return result;
      }

      case "manual": {
        const result: AdapterResult = {
          success: false,
          requiresManual: true,
        };
        this.lastResult = result;
        return result;
      }

      case "permanentFailure": {
        const result: AdapterResult = {
          success: false,
          error: {
            message: "Simulated permanent failure",
            code: "FAKE_PERMANENT",
            retryable: false,
          },
          requiresManual: false,
        };
        this.lastResult = result;
        return result;
      }
    }
  }

  async checkStatus(_runId: RunId): Promise<StatusCheckResult> {
    if (!this.lastResult) {
      return { state: "queued" };
    }

    const state: RunState = resolveState(this.lastResult);
    return {
      state,
      output: this.lastResult.output,
      error: this.lastResult.error,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveState(result: AdapterResult): RunState {
  if (result.requiresManual) {
    return "waiting_manual";
  }
  if (result.success) {
    return "succeeded";
  }
  // result.success === false
  if (result.error?.retryable === false) {
    return "failed";
  }
  return "failed";
}
