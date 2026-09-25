/**
 * Sanitized, actionable mapping for SQL Server connection errors
 * (Sprint 5 — Seção 7 / AC-09, AC-60).
 *
 * Invariants:
 * - Password-like values are always redacted before a message is
 *   ever produced.
 * - Credential-bearing connection strings are never emitted whole.
 * - Every mapped error carries an `action` the operator can follow.
 */

const REDACTED = "[REDACTED]";
const MAX_MESSAGE_LENGTH = 500;

/** Pairs whose *value* must never appear in logs or errors. */
const SECRET_PAIR_PATTERN =
  /\b(password|pwd|passwd|passphrase|secret|api[_-]?key|token)\b(\s*[:=]\s*)([^\s;,'"]+)/gi;

/** Credential-bearing connection strings are never emitted whole. */
const CONNECTION_STRING_PATTERN = /\b(?:server|data source)\s*=\s*[^;]+(?:;[^;]*=[^;]*)*;?/i;

const CONNECTION_STRING_PLACEHOLDER = "[CONNECTION_STRING_REDACTED]";

/** A single sanitized, actionable view of a connection failure. */
export interface SanitizedSqlError {
  readonly code: string;
  readonly message: string;
  readonly action: string;
}

/**
 * Redacts secrets from a raw driver/operator message.
 * Applied to every message before it leaves this module.
 */
export function sanitizeSqlErrorMessage(raw: string): string {
  if (CONNECTION_STRING_PATTERN.test(raw)) {
    raw = raw.replace(
      new RegExp(CONNECTION_STRING_PATTERN.source, "gi"),
      CONNECTION_STRING_PLACEHOLDER,
    );
  }

  const redacted = raw.replace(SECRET_PAIR_PATTERN, (_match, key: string, sep: string) => {
    return `${key}${sep}${REDACTED}`;
  });

  if (redacted.length > MAX_MESSAGE_LENGTH) {
    return `${redacted.slice(0, MAX_MESSAGE_LENGTH)}…`;
  }

  return redacted;
}

function extractCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return "EUNKNOWN";
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error !== null && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}

const REACHABILITY_CODES = new Set([
  "ECONNREFUSED",
  "ESOCKET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EPIPE",
]);

const AUTH_CODES = new Set(["ELOGIN", "EAUTH"]);

const TIMEOUT_CODES = new Set(["ETIMEOUT", "ETIMEDOUT"]);

/**
 * Sanitized stand-in for an underlying error, safe to attach as
 * `Error.cause`. The raw error object is never forwarded: logs and
 * `util.inspect` only ever see this plain, redacted view (SEC-01).
 */
export interface SanitizedErrorCause {
  readonly code: string;
  readonly message: string;
}

/**
 * Builds the `{ code, message }` stand-in used everywhere an underlying
 * error would otherwise be attached as `cause`. The message goes through
 * the same redaction as every other outgoing message.
 */
export function sanitizedErrorCause(error: unknown): SanitizedErrorCause {
  return {
    code: extractCode(error),
    message: sanitizeSqlErrorMessage(extractMessage(error)),
  };
}

/**
 * Maps an unknown connection/driver error to a sanitized, actionable
 * description. The raw error is never forwarded unmodified.
 */
export function mapSqlConnectionError(error: unknown): SanitizedSqlError {
  const code = extractCode(error);
  const message = sanitizeSqlErrorMessage(extractMessage(error));

  if (AUTH_CODES.has(code)) {
    return {
      code,
      message: `SQL Server authentication failed: ${message}`,
      action:
        "Verify SQL_SERVER_USER, SQL_SERVER_PASSWORD and SQL_SERVER_DATABASE (login enabled, correct database). Never log the password.",
    };
  }

  if (REACHABILITY_CODES.has(code)) {
    return {
      code,
      message: `Cannot reach SQL Server: ${message}`,
      action:
        "Verify SQL_SERVER_HOST and SQL_SERVER_PORT, network/firewall reachability, and that the instance is listening.",
    };
  }

  if (TIMEOUT_CODES.has(code)) {
    return {
      code,
      message: `SQL Server connection timed out: ${message}`,
      action:
        "Check SQL_SERVER_HOST/SQL_SERVER_PORT, server load and network latency, then retry the controlled operation.",
    };
  }

  return {
    code,
    message: `SQL Server connection failed: ${message}`,
    action:
      "Inspect the sanitized message, verify the SQL_SERVER_* configuration, and follow database/README.md troubleshooting.",
  };
}
