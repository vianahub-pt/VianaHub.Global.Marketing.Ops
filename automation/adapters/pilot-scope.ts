// ─── Pilot Scope Constants ───────────────────────────────────────────────────

/**
 * Allowed brand IDs for the production pilot.
 * Only "best-fluency" is permitted during Sprint 3 pilot phase.
 */
export const PILOT_ALLOWED_BRANDS = ["best-fluency"] as const;

/**
 * Allowed market codes for the production pilot.
 * Only "PT" (Portugal) is permitted during Sprint 3 pilot phase.
 */
export const PILOT_ALLOWED_MARKETS = ["PT"] as const;

/**
 * Allowed platform IDs for the production pilot.
 * Only Google Business Profile is permitted during Sprint 3 pilot phase.
 */
export const PILOT_ALLOWED_PLATFORMS = ["google-business-profile"] as const;

/**
 * Allowed operation IDs for the production pilot.
 * Only "createLocalPost" is permitted during Sprint 3 pilot phase.
 */
export const PILOT_ALLOWED_OPERATIONS = ["createLocalPost"] as const;

// ─── Pilot Scope Validation ──────────────────────────────────────────────────

export interface PilotScopeCheckResult {
  readonly withinScope: boolean;
  readonly violations: readonly PilotScopeViolation[];
  readonly message: string;
}

export interface PilotScopeViolation {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

/**
 * Validates that a run request is within the pilot scope.
 *
 * FP-01: Pilot limited to brand "best-fluency", market "PT",
 * Google Business Profile platform, operation "createLocalPost".
 *
 * Returns a detailed result indicating whether the request is
 * within scope and which specific fields (if any) violate the constraints.
 */
export function checkPilotScope(params: {
  readonly brandId: string;
  readonly market: string;
  readonly platform: string;
  readonly operation: string;
}): PilotScopeCheckResult {
  const violations: PilotScopeViolation[] = [];

  if (!(PILOT_ALLOWED_BRANDS as readonly string[]).includes(params.brandId)) {
    violations.push({
      field: "brandId",
      expected: PILOT_ALLOWED_BRANDS.join(", "),
      actual: params.brandId,
    });
  }

  if (!(PILOT_ALLOWED_MARKETS as readonly string[]).includes(params.market)) {
    violations.push({
      field: "market",
      expected: PILOT_ALLOWED_MARKETS.join(", "),
      actual: params.market,
    });
  }

  if (!(PILOT_ALLOWED_PLATFORMS as readonly string[]).includes(params.platform)) {
    violations.push({
      field: "platform",
      expected: PILOT_ALLOWED_PLATFORMS.join(", "),
      actual: params.platform,
    });
  }

  if (!(PILOT_ALLOWED_OPERATIONS as readonly string[]).includes(params.operation)) {
    violations.push({
      field: "operation",
      expected: PILOT_ALLOWED_OPERATIONS.join(", "),
      actual: params.operation,
    });
  }

  const withinScope = violations.length === 0;
  const message = withinScope
    ? "Run is within pilot scope"
    : `Pilot scope violations: ${violations.map((v) => `${v.field}="${v.actual}" (expected: ${v.expected})`).join("; ")}`;

  return { withinScope, violations, message };
}

// ─── Live Pilot Opt-in Gate ──────────────────────────────────────────────────

export type LivePilotGateStatus = "ALLOWED" | "BLOCKED" | "BLOCKED_NEEDS_HUMAN";

export interface LivePilotGateResult {
  readonly status: LivePilotGateStatus;
  readonly reason: string;
  readonly checks: readonly LivePilotCheck[];
}

export interface LivePilotCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

/**
 * Checks whether live pilot execution is permitted.
 *
 * FP-02: Pilot is opt-in via LIVE_PILOT_ENABLED=true;
 * CI never executes live execution; dry-run must be executed
 * successfully before any live execution.
 *
 * Checks:
 *  1. LIVE_PILOT_ENABLED environment variable is "true"
 *  2. Not running in CI environment (CI=true blocks live execution)
 *  3. Dry-run must have been executed before live execution
 */
export function checkLivePilotGate(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  options?: { readonly dryRunExecuted?: boolean },
): LivePilotGateResult {
  const checks: LivePilotCheck[] = [];

  // Check 1: LIVE_PILOT_ENABLED must be "true"
  const pilotEnabled = env["LIVE_PILOT_ENABLED"] === "true";
  checks.push({
    name: "LIVE_PILOT_ENABLED",
    passed: pilotEnabled,
    detail: pilotEnabled
      ? undefined
      : "LIVE_PILOT_ENABLED is not set to 'true'; live pilot is disabled (opt-in required)",
  });

  // Check 2: Not in CI environment
  const isCI = env["CI"] === "true" || env["GITHUB_ACTIONS"] === "true";
  checks.push({
    name: "NOT_IN_CI",
    passed: !isCI,
    detail: isCI
      ? "CI environment detected; live execution is forbidden in CI pipelines"
      : undefined,
  });

  // Check 3: Dry-run must have been executed before live
  const dryRunExecuted = options?.dryRunExecuted === true;
  checks.push({
    name: "DRY_RUN_EXECUTED",
    passed: dryRunExecuted,
    detail: dryRunExecuted
      ? undefined
      : "Dry-run must be executed successfully before any live execution",
  });

  const allPassed = checks.every((c) => c.passed);

  let status: LivePilotGateStatus;
  if (allPassed) {
    status = "ALLOWED";
  } else if (!pilotEnabled) {
    status = "BLOCKED";
  } else {
    status = "BLOCKED_NEEDS_HUMAN";
  }

  const failedChecks = checks.filter((c) => !c.passed);
  const reason = allPassed
    ? "Live pilot execution is permitted"
    : `Live pilot blocked: ${failedChecks.map((c) => c.name).join(", ")}`;

  return { status, reason, checks };
}
