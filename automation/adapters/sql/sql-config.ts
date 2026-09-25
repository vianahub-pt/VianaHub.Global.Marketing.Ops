/**
 * SQL Server connection configuration (Sprint 5 — Seção 7 / AC-06 / AC-08).
 *
 * Reads the existing GitHub configuration names (`SQL_SERVER_HOST`,
 * `SQL_SERVER_PORT`, `SQL_SERVER_DATABASE`, `SQL_SERVER_USER`,
 * `SQL_SERVER_PASSWORD`) and validates them with Zod BEFORE any
 * connection attempt.
 *
 * Security invariants:
 * - Validation error messages never include configuration *values*
 *   (they only name the offending variable), so passwords can never
 *   leak through validation failures.
 * - `describeSqlServerConfig` is the only approved way to describe a
 *   config for logging, and it omits the password entirely.
 */

import { z } from "zod";

/** Read-only environment source (injectable for tests). */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Validated SQL Server connection settings. Never log `password`. */
export interface SqlServerConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

/** Actionable validation failure — issues name variables, never values. */
export class SqlConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`SQL Server configuration invalid: ${issues.join("; ")}`);
    this.name = "SqlConfigValidationError";
    this.issues = issues;
  }
}

const sqlServerEnvSchema = z.object({
  SQL_SERVER_HOST: z
    .string({ required_error: "is required" })
    .trim()
    .min(1, "must be a non-empty string"),
  SQL_SERVER_PORT: z
    .string({ required_error: "is required" })
    .trim()
    .regex(/^\d+$/, "must be an integer between 1 and 65535")
    .transform((value) => Number.parseInt(value, 10))
    .refine((value) => value >= 1 && value <= 65535, "must be an integer between 1 and 65535"),
  SQL_SERVER_DATABASE: z
    .string({ required_error: "is required" })
    .trim()
    .min(1, "must be a non-empty string"),
  SQL_SERVER_USER: z
    .string({ required_error: "is required" })
    .trim()
    .min(1, "must be a non-empty string"),
  SQL_SERVER_PASSWORD: z
    .string({ required_error: "is required" })
    .min(1, "must be a non-empty string"),
});

function formatIssues(issues: readonly z.ZodIssue[]): string[] {
  return issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

/**
 * Validates SQL Server configuration from environment variable names.
 *
 * @throws {SqlConfigValidationError} listing every offending variable
 *   (by name only) before any connection is attempted.
 */
export function parseSqlServerConfig(env: EnvSource): SqlServerConfig {
  const parsed = sqlServerEnvSchema.safeParse(env);

  if (!parsed.success) {
    throw new SqlConfigValidationError(formatIssues(parsed.error.issues));
  }

  return {
    host: parsed.data.SQL_SERVER_HOST,
    port: parsed.data.SQL_SERVER_PORT,
    database: parsed.data.SQL_SERVER_DATABASE,
    user: parsed.data.SQL_SERVER_USER,
    password: parsed.data.SQL_SERVER_PASSWORD,
  };
}

/**
 * Returns a log-safe description of the configuration.
 * The password is intentionally and permanently omitted.
 */
export function describeSqlServerConfig(
  config: SqlServerConfig,
): Readonly<Record<string, string | number>> {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
  };
}
