import type { RunId } from "../domain/idempotency.js";
import type { RunState } from "../domain/run-state.js";

import type { AdapterResult, PlatformAdapter, StatusCheckResult } from "./platform-adapter.js";

// ─── Reconciliation priority ─────────────────────────────────────────────────
// Higher index = more conservative (takes precedence in conflicts).

const STATE_PRIORITY: Record<RunState, number> = {
  failed: 4,
  waiting_manual: 3,
  running: 2,
  succeeded: 1,
  queued: 0,
  cancelled: 0,
};

// ─── Reconciled result ───────────────────────────────────────────────────────

export interface ReconciledResult {
  readonly state: RunState;
  readonly output?: unknown;
  readonly error?: import("../domain/run-state.js").RunError;
  readonly statusCheck: StatusCheckResult;
}

// ─── synchronizeStatus ───────────────────────────────────────────────────────

/**
 * Synchronizes the adapter's local AdapterResult with the remote status
 * reported by `adapter.checkStatus()`.
 *
 * When the two sources disagree, the more conservative (higher-priority)
 * state wins according to the reconciliation rule:
 *   failed > waiting_manual > running > succeeded
 *
 * The `statusCheck` is always returned so callers can persist it.
 *
 * @param adapter      - The platform adapter (used for checkStatus)
 * @param runId        - The run identifier
 * @param adapterResult - The result from adapter.execute()
 * @returns           - A ReconciledResult with the winning state
 */
export async function synchronizeStatus(
  adapter: PlatformAdapter,
  runId: RunId,
  adapterResult: AdapterResult,
): Promise<ReconciledResult> {
  const statusCheck = await adapter.checkStatus(runId);

  const adapterState = resolveAdapterState(adapterResult);
  const remoteState = statusCheck.state;

  const winningState = reconcile(adapterState, remoteState);

  // When remote wins with richer data, prefer it.
  if (remoteState === winningState && remoteState !== adapterState) {
    return {
      state: winningState,
      output: statusCheck.output ?? adapterResult.output,
      error: statusCheck.error ?? adapterResult.error,
      statusCheck,
    };
  }

  // Adapter result is the winner (or they agree).
  return {
    state: winningState,
    output: adapterResult.output,
    error: adapterResult.error,
    statusCheck,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolves the RunState implied by an AdapterResult.
 */
export function resolveAdapterState(result: AdapterResult): RunState {
  if (result.requiresManual) {
    return "waiting_manual";
  }
  if (result.success) {
    return "succeeded";
  }
  return "failed";
}

/**
 * Returns the more conservative state between two RunStates.
 */
function reconcile(a: RunState, b: RunState): RunState {
  return STATE_PRIORITY[a] >= STATE_PRIORITY[b] ? a : b;
}
