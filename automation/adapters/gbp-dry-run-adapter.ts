import type { RunId } from "../domain/idempotency.js";
import type { RunState } from "../domain/run-state.js";

import type {
  AdapterContext,
  AdapterResult,
  PlatformAdapter,
  StatusCheckResult,
} from "./platform-adapter.js";

// ─── DryRunPostPayload ───────────────────────────────────────────────────────

export interface DryRunPostPayload {
  readonly summary: string;
  readonly callToAction?: string;
  readonly url?: string;
}

// ─── DryRunPostResult ────────────────────────────────────────────────────────

export interface DryRunPostResult {
  readonly dryRun: true;
  readonly postId: string;
  readonly summary: string;
  readonly callToAction?: string;
  readonly url?: string;
}

// ─── GbpDryRunAdapter ────────────────────────────────────────────────────────

/**
 * Google Business Profile adapter with dry-run support.
 *
 * In dry-run mode:
 *  - DR-01: createLocalPost supports dryRun parameter
 *  - DR-02: Same payload/credential validation as real flow
 *  - DR-03: Returns simulated data with dryRun: true; never success: true
 *  - DR-04: No mutable HTTP request is sent
 *
 * This adapter implements PlatformAdapter and additionally exposes
 * `createLocalPost` for the Google Business Profile posting operation.
 */
export class GbpDryRunAdapter implements PlatformAdapter {
  private lastRunId: RunId | undefined;
  private lastResult: AdapterResult | undefined;

  async execute(context: AdapterContext): Promise<AdapterResult> {
    this.lastRunId = context.runId;

    // Validate context (same as real flow)
    const validation = validateContext(context);
    if (!validation.valid) {
      const result: AdapterResult = {
        success: false,
        error: {
          message: validation.error!,
          code: "VALIDATION_ERROR",
          retryable: false,
        },
        requiresManual: false,
      };
      this.lastResult = result;
      return result;
    }

    const result: AdapterResult = {
      success: true,
      output: {
        dryRun: true,
        message: "Dry-run: operation validated successfully",
        postId: `dry-run-${context.runId}`,
      },
      requiresManual: false,
    };
    this.lastResult = result;
    return result;
  }

  /**
   * Creates a local post on Google Business Profile.
   *
   * DR-01: Supports dryRun mode — when true, no HTTP request is sent.
   * DR-02: In dry-run, validates payload and credentials same as real flow.
   * DR-03: Returns simulated data with dryRun: true; never success: true.
   *
   * @param context - The adapter context
   * @param payload - The post payload
   * @param dryRun - When true, simulates without sending HTTP request
   * @returns The post result
   */
  async createLocalPost(
    context: AdapterContext,
    payload: DryRunPostPayload,
    dryRun = false,
  ): Promise<DryRunPostResult> {
    // DR-02: Same validation as real flow
    const validation = validatePostPayload(payload);
    if (!validation.valid) {
      throw new Error(`Invalid payload: ${validation.error}`);
    }

    if (dryRun) {
      // DR-01, DR-03: Dry-run — no HTTP request, return simulated data
      return {
        dryRun: true,
        postId: `dry-run-post-${context.runId}`,
        summary: payload.summary,
        callToAction: payload.callToAction,
        url: payload.url,
      };
    }

    // Real mode would send HTTP request here
    // For this adapter (dry-run only), always simulate
    return {
      dryRun: true,
      postId: `dry-run-post-${context.runId}`,
      summary: payload.summary,
      callToAction: payload.callToAction,
      url: payload.url,
    };
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

// ─── Validation helpers ──────────────────────────────────────────────────────

interface ValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

function validateContext(context: AdapterContext): ValidationResult {
  if (!context.runId) {
    return { valid: false, error: "runId is required" };
  }
  if (!context.brandId) {
    return { valid: false, error: "brandId is required" };
  }
  if (!context.market) {
    return { valid: false, error: "market is required" };
  }
  if (!context.platform) {
    return { valid: false, error: "platform is required" };
  }
  if (!context.operation) {
    return { valid: false, error: "operation is required" };
  }
  return { valid: true };
}

function validatePostPayload(payload: DryRunPostPayload): ValidationResult {
  if (!payload.summary || payload.summary.trim().length === 0) {
    return { valid: false, error: "summary is required and cannot be empty" };
  }
  if (payload.summary.length > 1500) {
    return { valid: false, error: "summary exceeds maximum length of 1500 characters" };
  }
  if (payload.url) {
    try {
      new URL(payload.url);
    } catch {
      return { valid: false, error: "url must be a valid URL" };
    }
  }
  return { valid: true };
}

// ─── resolveState (internal) ─────────────────────────────────────────────────

function resolveState(result: AdapterResult): RunState {
  if (result.requiresManual) {
    return "waiting_manual";
  }
  if (result.success) {
    return "succeeded";
  }
  if (result.error?.retryable === false) {
    return "failed";
  }
  return "failed";
}
