/**
 * Centralized persistence provider configuration (Sprint 5 — Seção 7,
 * Seção 15 / AC-05, AC-64 groundwork).
 *
 * `PERSISTENCE_PROVIDER` selects the persistence backend:
 * - `filesystem` (default when unset — backward compatible, AC-64)
 * - `sqlserver`
 *
 * Unknown or empty values fail closed with an actionable error.
 * When `sqlserver` is selected, the SQL configuration is validated
 * with Zod BEFORE any connection attempt (AC-08).
 */

import { parseSqlServerConfig, type EnvSource, type SqlServerConfig } from "./sql-config.js";

export const PERSISTENCE_PROVIDERS = ["filesystem", "sqlserver"] as const;

export type PersistenceProvider = (typeof PERSISTENCE_PROVIDERS)[number];

/** Actionable provider-selection failure (fail-closed, Seção 15). */
export class PersistenceConfigError extends Error {
  readonly action: string;

  constructor(message: string, action: string) {
    super(message);
    this.name = "PersistenceConfigError";
    this.action = action;
  }
}

export type PersistenceConfig =
  | { readonly provider: "filesystem" }
  | { readonly provider: "sqlserver"; readonly sql: SqlServerConfig };

/**
 * Resolves the configured persistence provider.
 *
 * - Variable absent → safe `filesystem` default (retrocompatible).
 * - Any value outside the exact allowed literals → fail closed.
 */
export function resolvePersistenceProvider(env: EnvSource): PersistenceProvider {
  const raw = env.PERSISTENCE_PROVIDER;

  if (raw === undefined) {
    return "filesystem";
  }

  const value = raw.trim();

  if (value === "filesystem" || value === "sqlserver") {
    return value;
  }

  throw new PersistenceConfigError(
    `Unknown PERSISTENCE_PROVIDER "${value}". Allowed values: filesystem, sqlserver.`,
    "Set PERSISTENCE_PROVIDER to filesystem or sqlserver, or remove the variable to use the backward-compatible filesystem default.",
  );
}

/**
 * Resolves the full persistence configuration.
 *
 * For `sqlserver`, SQL variables are validated here — before any pool
 * or connection is created. For `filesystem`, no SQL variables are
 * required (provider selection stays independent of SQL availability).
 */
export function resolvePersistenceConfig(env: EnvSource): PersistenceConfig {
  const provider = resolvePersistenceProvider(env);

  if (provider === "filesystem") {
    return { provider: "filesystem" };
  }

  return { provider: "sqlserver", sql: parseSqlServerConfig(env) };
}
