import { z } from "zod";
import type { GbpTransport } from "./gbp-http-transport.js";

// ─── Preflight Check Result ──────────────────────────────────────────────────

export type PreflightStatus = "READY" | "BLOCKED_NEEDS_HUMAN";

export interface PreflightCheckResult {
  readonly status: PreflightStatus;
  readonly checks: readonly PreflightCheck[];
  readonly message: string;
}

export interface PreflightCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

// ─── Environment schema for Google Business Profile ──────────────────────────

const gbpEnvSchema = z.object({
  GBP_PROJECT_ID: z.string().min(1),
  GBP_OAUTH_CLIENT_ID: z.string().min(1),
  GBP_OAUTH_CLIENT_SECRET: z.string().min(1),
  GBP_OAUTH_REFRESH_TOKEN: z.string().min(1),
  GBP_ACCOUNT_ID: z.string().min(1),
  GBP_LOCATION_ID: z.string().min(1),
});

type GbpEnv = z.infer<typeof gbpEnvSchema>;

// ─── Access Preflight Gate ───────────────────────────────────────────────────

/**
 * Access Preflight Gate for Google Business Profile adapter.
 *
 * Verifies that all required configuration and credentials are available
 * before any live execution or real adapter instantiation.
 *
 * AP-01: Verifies GBP API is configured in GCP project
 * AP-02: Verifies OAuth 2.0 is available via secret mechanism
 * AP-03: Verifies account/location IDs are available via environment variables
 * AP-04: No credentials appear in AdapterContext, RunRecord, checkpoint, log or fixture
 * AP-05: Gate is executed before any live execution and before real adapter instantiation
 *
 * When any required credential or configuration is missing, the gate
 * returns BLOCKED_NEEDS_HUMAN — never proceeds without full configuration.
 */
export function checkGbpPreflight(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): PreflightCheckResult {
  const checks: PreflightCheck[] = [];

  // AP-01: GBP API configured in GCP project
  const projectId = typeof env.GBP_PROJECT_ID === "string" ? env.GBP_PROJECT_ID.trim() : undefined;
  checks.push({
    name: "GBP_PROJECT_ID",
    passed: typeof projectId === "string" && projectId.length > 0,
    detail:
      typeof projectId === "string" && projectId.length > 0
        ? undefined
        : "GBP_PROJECT_ID environment variable is missing or empty",
  });

  // AP-02: OAuth 2.0 available via secret mechanism
  const oauthClientId =
    typeof env.GBP_OAUTH_CLIENT_ID === "string" ? env.GBP_OAUTH_CLIENT_ID.trim() : undefined;
  checks.push({
    name: "GBP_OAUTH_CLIENT_ID",
    passed: typeof oauthClientId === "string" && oauthClientId.length > 0,
    detail:
      typeof oauthClientId === "string" && oauthClientId.length > 0
        ? undefined
        : "GBP_OAUTH_CLIENT_ID environment variable is missing or empty",
  });

  const oauthClientSecret =
    typeof env.GBP_OAUTH_CLIENT_SECRET === "string"
      ? env.GBP_OAUTH_CLIENT_SECRET.trim()
      : undefined;
  checks.push({
    name: "GBP_OAUTH_CLIENT_SECRET",
    passed: typeof oauthClientSecret === "string" && oauthClientSecret.length > 0,
    detail:
      typeof oauthClientSecret === "string" && oauthClientSecret.length > 0
        ? undefined
        : "GBP_OAUTH_CLIENT_SECRET environment variable is missing or empty",
  });

  const oauthRefreshToken =
    typeof env.GBP_OAUTH_REFRESH_TOKEN === "string"
      ? env.GBP_OAUTH_REFRESH_TOKEN.trim()
      : undefined;
  checks.push({
    name: "GBP_OAUTH_REFRESH_TOKEN",
    passed: typeof oauthRefreshToken === "string" && oauthRefreshToken.length > 0,
    detail:
      typeof oauthRefreshToken === "string" && oauthRefreshToken.length > 0
        ? undefined
        : "GBP_OAUTH_REFRESH_TOKEN environment variable is missing or empty",
  });

  // AP-03: Account/Location IDs available
  const accountId = typeof env.GBP_ACCOUNT_ID === "string" ? env.GBP_ACCOUNT_ID.trim() : undefined;
  checks.push({
    name: "GBP_ACCOUNT_ID",
    passed: typeof accountId === "string" && accountId.length > 0,
    detail:
      typeof accountId === "string" && accountId.length > 0
        ? undefined
        : "GBP_ACCOUNT_ID environment variable is missing or empty",
  });

  const locationId =
    typeof env.GBP_LOCATION_ID === "string" ? env.GBP_LOCATION_ID.trim() : undefined;
  checks.push({
    name: "GBP_LOCATION_ID",
    passed: typeof locationId === "string" && locationId.length > 0,
    detail:
      typeof locationId === "string" && locationId.length > 0
        ? undefined
        : "GBP_LOCATION_ID environment variable is missing or empty",
  });

  // Determine overall status
  const allPassed = checks.every((c) => c.passed);
  const status: PreflightStatus = allPassed ? "READY" : "BLOCKED_NEEDS_HUMAN";

  const failedChecks = checks.filter((c) => !c.passed);
  const message = allPassed
    ? "All GBP preflight checks passed — adapter is ready for live execution"
    : `GBP preflight blocked: ${failedChecks.map((c) => c.name).join(", ")} missing. Manual configuration required.`;

  return { status, checks, message };
}

// ─── Adapter Environment Config ──────────────────────────────────────────────

/**
 * Extracts and validates the GBP configuration from environment variables.
 *
 * Returns the validated config or throws if any required field is missing.
 * Credentials are never logged, serialized or stored in any record.
 */
export function loadGbpConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): GbpEnv {
  const result = gbpEnvSchema.safeParse(env);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing GBP configuration: ${missing}`);
  }
  return result.data;
}

// ─── Real Access Preflight Gate ──────────────────────────────────────────────

export interface RealPreflightCheckResult {
  readonly status: PreflightStatus;
  readonly checks: readonly PreflightCheck[];
  readonly message: string;
}

/**
 * Real (non-mutating) access preflight gate for Google Business Profile.
 *
 * Uses an injectable GbpTransport to verify that:
 * - OAuth credentials are valid (transport is ready)
 * - The GBP API endpoint is reachable (GET request to accounts)
 * - The specified account is accessible
 * - The specified location is accessible
 *
 * AP-01: Real verification — no mutations are performed (only GET requests)
 * AP-05: Must be called before any live execution
 *
 * Security:
 * - No credentials are logged, serialized or stored
 * - Only GET requests are used (no mutations)
 * - Errors are sanitized and never expose secrets
 *
 * @param transport - Injectable GbpTransport instance (CI uses mock)
 * @param accountId - The GBP account ID to verify
 * @param locationId - The GBP location ID to verify
 * @returns PreflightCheckResult with status READY or BLOCKED_NEEDS_HUMAN
 */
export async function checkGbpPreflightReal(
  transport: GbpTransport | null,
  accountId: string,
  locationId: string,
): Promise<RealPreflightCheckResult> {
  const checks: PreflightCheck[] = [];

  // Check 1: Transport is available and ready (OAuth/config valid)
  const transportReady = transport !== null && transport.isReady();
  checks.push({
    name: "REAL_OAUTH_VALID",
    passed: transportReady,
    detail: transportReady
      ? undefined
      : "Transport not available or OAuth credentials invalid — BLOCKED_NEEDS_HUMAN",
  });

  // If transport is not ready, return immediately
  if (!transportReady) {
    return {
      status: "BLOCKED_NEEDS_HUMAN",
      checks,
      message:
        "Real preflight blocked: transport not ready or OAuth credentials invalid. Manual configuration required.",
    };
  }

  // Check 2: GBP API endpoint is reachable (GET accounts)
  let endpointReachable = false;
  try {
    await transport!.request({
      method: "GET",
      path: `/accounts/${accountId}`,
    });
    endpointReachable = true;
  } catch {
    endpointReachable = false;
  }

  checks.push({
    name: "REAL_ENDPOINT_REACHABLE",
    passed: endpointReachable,
    detail: endpointReachable
      ? undefined
      : "GBP API endpoint not reachable or returned an error — BLOCKED_NEEDS_HUMAN",
  });

  // Check 3: Account is accessible (verified by the GET accounts call above)
  checks.push({
    name: "REAL_ACCOUNT_ACCESSIBLE",
    passed: endpointReachable,
    detail: endpointReachable
      ? undefined
      : "GBP account not accessible — verify account ID and authorization — BLOCKED_NEEDS_HUMAN",
  });

  // Check 4: Location is accessible (GET the specific location)
  let locationAccessible = false;
  try {
    await transport!.request({
      method: "GET",
      path: `/accounts/${accountId}/locations/${locationId}`,
    });
    locationAccessible = true;
  } catch {
    locationAccessible = false;
  }

  checks.push({
    name: "REAL_LOCATION_ACCESSIBLE",
    passed: locationAccessible,
    detail: locationAccessible
      ? undefined
      : "GBP location not accessible — verify location ID and authorization — BLOCKED_NEEDS_HUMAN",
  });

  // Determine overall status
  const allPassed = checks.every((c) => c.passed);
  const status: PreflightStatus = allPassed ? "READY" : "BLOCKED_NEEDS_HUMAN";

  const failedChecks = checks.filter((c) => !c.passed);
  const message = allPassed
    ? "All real GBP preflight checks passed — adapter is ready for live execution"
    : `Real preflight blocked: ${failedChecks.map((c) => c.name).join(", ")} failed. Manual configuration required.`;

  return { status, checks, message };
}
