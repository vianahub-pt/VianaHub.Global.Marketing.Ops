import { z } from "zod";

import type { RunId } from "../domain/idempotency.js";
import type { RunState } from "../domain/run-state.js";
import { redactError, redactLog } from "../domain/redaction.js";

import type {
  AdapterContext,
  AdapterResult,
  PlatformAdapter,
  StatusCheckResult,
} from "./platform-adapter.js";
import { checkGbpPreflight, loadGbpConfig } from "./access-preflight-gate.js";
import type { GbpTransport, GbpTransportError } from "./gbp-http-transport.js";
import { checkLivePilotGate } from "./pilot-scope.js";

// ─── Payload Schema — createLocalPost ────────────────────────────────────────

export const createLocalPostPayloadSchema = z
  .object({
    summary: z.string().min(1).max(1500),
    callToAction: z.enum(["LEARN_MORE", "CALL", "ORDER", "SHOP", "SIGN_UP"]).optional(),
    url: z.string().url().optional(),
  })
  .strict();

export type CreateLocalPostPayload = z.infer<typeof createLocalPostPayloadSchema>;

// ─── Result Schema — createLocalPost ─────────────────────────────────────────

export interface CreateLocalPostResult {
  readonly postId: string;
  readonly summary: string;
  readonly callToAction?: string;
  readonly url?: string;
  readonly dryRun: boolean;
}

// ─── Internal state ──────────────────────────────────────────────────────────

interface AdapterInternalState {
  lastRunId: RunId | undefined;
  lastResult: AdapterResult | undefined;
  configLoaded: boolean;
  dryRunExecuted: boolean;
}

// ─── Resolved live context ───────────────────────────────────────────────────

interface ResolvedLiveContext {
  readonly transport: GbpTransport;
  readonly accountId: string;
  readonly locationId: string;
}

// ─── GoogleBusinessProfileAdapter ────────────────────────────────────────────

/**
 * Google Business Profile adapter implementing PlatformAdapter.
 *
 * RA-01: Implements PlatformAdapter
 * RA-02: createLocalPost with payload schema and expected result
 * RA-03: Supports verifiable dry-run mode
 * RA-04: Distinct from FakeAdapter — explicit test documents this
 *
 * Security:
 * SG-01: Credentials loaded only via process.env; redactError() applied to all errors
 * SG-02: redactLog() applied to all execution logs
 * SG-03: No token, API key or password in RunRecord.metadata, checkpoint or output
 *
 * The adapter never makes real HTTP calls without valid credentials.
 * When credentials are missing, it returns BLOCKED_NEEDS_HUMAN.
 */
export class GoogleBusinessProfileAdapter implements PlatformAdapter {
  private state: AdapterInternalState = {
    lastRunId: undefined,
    lastResult: undefined,
    configLoaded: false,
    dryRunExecuted: false,
  };

  private dryRun: boolean;
  private transport: GbpTransport | null;

  constructor(dryRun = false, transport: GbpTransport | null = null) {
    this.dryRun = dryRun;
    this.transport = transport;
  }

  // ─── Private gate helpers ───────────────────────────────────────────────────

  /**
   * AP-05: Ensures GBP preflight passes and config loads.
   * Called before any execution (live or dry-run).
   * Throws GbpGateError on failure.
   */
  private ensureGbpPreflightReady(): void {
    const preflight = checkGbpPreflight();
    if (preflight.status === "BLOCKED_NEEDS_HUMAN") {
      throw new GbpGateError(preflight.message, "BLOCKED_NEEDS_HUMAN", true);
    }
    try {
      loadGbpConfig();
      this.state.configLoaded = true;
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      throw new GbpGateError(errMessage, "CONFIG_ERROR", false);
    }
  }

  /**
   * HUMAN-004: Resolves live execution context by checking pilot gate,
   * CI environment, credentials, and transport.
   * Called only for live (non-dry-run) execution.
   * Throws GbpGateError on failure.
   */
  private async resolveLiveContext(): Promise<ResolvedLiveContext> {
    const livePilotGate = checkLivePilotGate(process.env, {
      dryRunExecuted: this.state.dryRunExecuted,
    });
    if (livePilotGate.status !== "ALLOWED") {
      throw new GbpGateError(livePilotGate.reason, "BLOCKED_NEEDS_HUMAN", true);
    }

    if (process.env.GITHUB_ACTIONS === "true") {
      throw new GbpGateError(
        "Live execution blocked in CI environment — GITHUB_ACTIONS=true",
        "BLOCKED_NEEDS_HUMAN",
        true,
      );
    }

    const accountId = process.env.GBP_ACCOUNT_ID;
    const locationId = process.env.GBP_LOCATION_ID;
    if (!accountId || !locationId) {
      throw new GbpGateError(
        "GBP_ACCOUNT_ID or GBP_LOCATION_ID not configured",
        "BLOCKED_NEEDS_HUMAN",
        true,
      );
    }

    let transport = this.transport;
    if (!transport) {
      try {
        const { createGbpTransport } = await import("./gbp-http-transport.js");
        transport = createGbpTransport();
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : String(error);
        throw new GbpGateError(errMessage, "CONFIG_ERROR", false);
      }
    }

    return { transport, accountId, locationId };
  }

  async execute(context: AdapterContext): Promise<AdapterResult> {
    this.state.lastRunId = context.runId;

    // Validate context (required even in dry-run mode)
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
      this.state.lastResult = result;
      return result;
    }

    // Validate payload (required in both dry-run and live modes, but only when provided)
    if (context.payload !== undefined && context.payload !== null) {
      const payloadValidation = validatePostPayload(context.payload as CreateLocalPostPayload);
      if (!payloadValidation.valid) {
        const result: AdapterResult = {
          success: false,
          error: {
            message: payloadValidation.error!,
            code: "PAYLOAD_VALIDATION_ERROR",
            retryable: false,
          },
          requiresManual: false,
        };
        this.state.lastResult = result;
        return result;
      }
    }

    // AP-05: Preflight gate + config (required even in dry-run mode)
    try {
      this.ensureGbpPreflightReady();
    } catch (error) {
      if (error instanceof GbpGateError) {
        const result: AdapterResult = {
          success: false,
          error: redactError({
            message: error.message,
            code: error.code,
            retryable: false,
          }),
          requiresManual: error.requiresManual,
        };
        this.state.lastResult = result;
        return result;
      }
      throw error;
    }

    if (this.dryRun) {
      // RA-03: Dry-run mode — validation, preflight and config all executed.
      // No HTTP request is sent to transport.
      const payload = context.payload as CreateLocalPostPayload | undefined;
      const result: AdapterResult = {
        success: true,
        output: {
          dryRun: true,
          postId: `dry-run-${context.runId}`,
          summary: payload?.summary,
          callToAction: payload?.callToAction,
          url: payload?.url,
        },
        requiresManual: false,
      };
      this.state.dryRunExecuted = true;
      this.state.lastResult = result;
      return result;
    }

    // HUMAN-004: Live gates + transport resolution
    let liveCtx: ResolvedLiveContext;
    try {
      liveCtx = await this.resolveLiveContext();
    } catch (error) {
      if (error instanceof GbpGateError) {
        const result: AdapterResult = {
          success: false,
          error: redactError({
            message: error.message,
            code: error.code,
            retryable: false,
          }),
          requiresManual: error.requiresManual,
        };
        this.state.lastResult = result;
        return result;
      }
      throw error;
    }

    // Live execution — SG-02: redactLog applied to execution logs
    const payload = context.payload as CreateLocalPostPayload | undefined;
    if (!payload) {
      const result: AdapterResult = {
        success: false,
        error: {
          message: "Payload is required for live execution",
          code: "VALIDATION_ERROR",
          retryable: false,
        },
        requiresManual: false,
      };
      this.state.lastResult = result;
      return result;
    }

    // SG-02: redactLog — log before calling API
    console.log(
      JSON.stringify(
        redactLog({
          adapter: "google-business-profile",
          operation: "createLocalPost",
          message: "Executing live API call",
          runId: context.runId,
          accountId: liveCtx.accountId.slice(0, 4) + "***",
          locationId: liveCtx.locationId.slice(0, 4) + "***",
        }),
      ),
    );

    try {
      const apiBody = buildApiRequestBody(payload);
      const path = `/accounts/${liveCtx.accountId}/locations/${liveCtx.locationId}/localPosts`;
      const response = await liveCtx.transport.request<{
        name?: string;
        postId?: string;
        summary?: string;
        callToAction?: { actionType?: string; url?: string };
      }>({
        method: "POST",
        path,
        body: apiBody,
      });

      const mapped = mapApiResponse(response.data, payload);

      const result: AdapterResult = {
        success: true,
        output: mapped,
        requiresManual: false,
      };
      this.state.lastResult = result;
      return result;
    } catch (error) {
      // Detect CAPTCHA / MFA / ToS obstacles
      const errMessage = extractErrorMessage(error);
      const requiresManual = isManualInterventionRequired(errMessage);

      const transportError = toTransportError(error);

      const result: AdapterResult = {
        success: false,
        error: redactError({
          message: transportError?.message ?? errMessage,
          code: transportError?.code ?? "LIVE_EXECUTION_ERROR",
          retryable: transportError?.retryable ?? false,
        }),
        requiresManual,
      };
      this.state.lastResult = result;
      return result;
    }
  }

  async checkStatus(_runId: RunId): Promise<StatusCheckResult> {
    if (!this.state.lastResult) {
      return { state: "queued" };
    }

    const state: RunState = resolveState(this.state.lastResult);
    return {
      state,
      output: this.state.lastResult.output,
      error: this.state.lastResult.error,
    };
  }

  // ─── createLocalPost ──────────────────────────────────────────────────────

  /**
   * Creates a local post on Google Business Profile.
   *
   * RA-02: Operation with payload schema and expected result
   * RA-03: Supports dry-run mode
   *
   * @param context - The adapter context
   * @param payload - The post payload
   * @param dryRun - When true, simulates without sending HTTP request
   * @returns The post result
   */
  async createLocalPost(
    context: AdapterContext,
    payload: CreateLocalPostPayload,
    dryRun = false,
  ): Promise<CreateLocalPostResult> {
    // Validate payload
    const validation = validatePostPayload(payload);
    if (!validation.valid) {
      throw new Error(`Invalid payload: ${redactError({ message: validation.error! }).message}`);
    }

    // AP-05: Preflight gate + config (required even in dry-run mode)
    try {
      this.ensureGbpPreflightReady();
    } catch (error) {
      if (error instanceof GbpGateError) {
        const prefix = error.requiresManual ? "Preflight blocked" : "Config error";
        throw new Error(`${prefix}: ${redactError({ message: error.message }).message}`);
      }
      throw error;
    }

    if (dryRun) {
      // RA-03: Dry-run mode — validation, preflight and config all executed.
      // No HTTP request is sent to transport.
      this.state.dryRunExecuted = true;
      return {
        postId: `dry-run-post-${context.runId}`,
        summary: payload.summary,
        callToAction: payload.callToAction,
        url: payload.url,
        dryRun: true,
      };
    }

    // HUMAN-004: Live gates + transport resolution
    let liveCtx: ResolvedLiveContext;
    try {
      liveCtx = await this.resolveLiveContext();
    } catch (error) {
      if (error instanceof GbpGateError) {
        throw new Error(
          redactError({
            message: error.message,
            code: error.code,
          }).message,
        );
      }
      throw error;
    }

    // SG-02: redactLog — log before calling API
    console.log(
      JSON.stringify(
        redactLog({
          adapter: "google-business-profile",
          operation: "createLocalPost",
          message: "Executing live API call via createLocalPost",
          runId: context.runId,
          accountId: liveCtx.accountId.slice(0, 4) + "***",
          locationId: liveCtx.locationId.slice(0, 4) + "***",
        }),
      ),
    );

    try {
      const apiBody = buildApiRequestBody(payload);
      const path = `/accounts/${liveCtx.accountId}/locations/${liveCtx.locationId}/localPosts`;
      const response = await liveCtx.transport.request<{
        name?: string;
        postId?: string;
        summary?: string;
        callToAction?: { actionType?: string; url?: string };
      }>({
        method: "POST",
        path,
        body: apiBody,
      });

      return mapCreateLocalPostResponse(response.data, payload);
    } catch (error) {
      const errMessage = extractErrorMessage(error);

      if (isManualInterventionRequired(errMessage)) {
        throw new Error(
          redactError({
            message: `Manual intervention required: ${errMessage}`,
            code: "BLOCKED_NEEDS_HUMAN",
          }).message,
        );
      }
      throw new Error(`Live execution failed: ${redactError({ message: errMessage }).message}`);
    }
  }
}

// ─── Validation helpers ──────────────────────────────────────────────────────

interface ValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

/**
 * Returns true when the error message indicates a CAPTCHA, MFA, or ToS
 * obstacle that requires manual human intervention.
 */
function isManualInterventionRequired(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("captcha") ||
    lower.includes("mfa") ||
    lower.includes("multi-factor") ||
    lower.includes("terms of service") ||
    lower.includes("tos") ||
    lower.includes("consent required")
  );
}

/**
 * Internal error thrown by gate helpers to carry structured error metadata.
 * Callers catch and convert to AdapterResult or rethrow as plain Error.
 */
class GbpGateError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly requiresManual: boolean,
  ) {
    super(message);
  }
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

function validatePostPayload(payload: CreateLocalPostPayload): ValidationResult {
  const result = createLocalPostPayloadSchema.safeParse(payload);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    return { valid: false, error: firstIssue?.message ?? "Invalid payload" };
  }
  return { valid: true };
}

// ─── API Request/Response Mapping ────────────────────────────────────────────

interface ApiLocalPostBody {
  readonly summary: string;
  readonly callToAction?: {
    readonly actionType: string;
    readonly url?: string;
  };
}

interface ApiResponseData {
  readonly name?: string;
  readonly postId?: string;
  readonly summary?: string;
  readonly callToAction?: {
    readonly actionType?: string;
    readonly url?: string;
  };
}

/**
 * Builds the API request body from the adapter payload.
 *
 * Maps the adapter payload to the GBP API format:
 * - summary → summary
 * - callToAction → callToAction.actionType
 * - url → callToAction.url
 */
function buildApiRequestBody(payload: CreateLocalPostPayload): ApiLocalPostBody {
  if (payload.callToAction || payload.url) {
    const callToAction = {
      actionType: payload.callToAction ?? "LEARN_MORE",
      ...(payload.url ? { url: payload.url } : {}),
    };
    return {
      summary: payload.summary,
      callToAction,
    };
  }

  return {
    summary: payload.summary,
  };
}

/**
 * Maps the GBP API response to the adapter output format.
 *
 * Extracts postId from the `name` field (format: accounts/{id}/locations/{id}/localPosts/{postId}).
 */
function mapApiResponse(
  data: ApiResponseData,
  payload: CreateLocalPostPayload,
): CreateLocalPostResult {
  const postId = extractPostId(data.name) ?? data.postId ?? `unknown-${Date.now()}`;

  return {
    postId,
    summary: data.summary ?? payload.summary,
    callToAction: data.callToAction?.actionType ?? payload.callToAction,
    url: data.callToAction?.url ?? payload.url,
    dryRun: false,
  };
}

/**
 * Maps the API response for the createLocalPost method (throws on error).
 */
function mapCreateLocalPostResponse(
  data: ApiResponseData,
  payload: CreateLocalPostPayload,
): CreateLocalPostResult {
  return mapApiResponse(data, payload);
}

/**
 * Extracts the postId from a GBP API resource name.
 *
 * Format: accounts/{accountId}/locations/{locationId}/localPosts/{postId}
 * Returns the last segment after the final slash.
 */
function extractPostId(name?: string): string | undefined {
  if (!name) {
    return undefined;
  }
  const segments = name.split("/");
  return segments[segments.length - 1] || undefined;
}

// ─── Error helpers ───────────────────────────────────────────────────────────

/**
 * Extracts an error message from an unknown thrown value.
 *
 * Handles Error instances, plain objects with a `message` string property,
 * and falls back to String() for primitives.
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const msg = (error as Record<string, unknown>).message;
    if (typeof msg === "string") {
      return msg;
    }
  }
  return String(error);
}

/**
 * Type guard for GbpTransportError.
 */
function isGbpTransportError(error: unknown): error is GbpTransportError {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    "code" in error &&
    "retryable" in error
  );
}

/**
 * Converts an unknown error to a GbpTransportError if possible.
 */
function toTransportError(error: unknown): GbpTransportError | null {
  if (isGbpTransportError(error)) {
    return error;
  }
  return null;
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
