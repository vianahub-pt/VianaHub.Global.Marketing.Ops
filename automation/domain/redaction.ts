import type { RunError } from "./run-state.js";

// ─── Sensitive value patterns ────────────────────────────────────────────────

const JWT_PATTERN = /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g;

const API_KEY_PATTERN =
  /(?:^|[=:\s])(?:sk[-_](?:live|test|api)?[-_][a-zA-Z0-9]{20,}|ak[-_][a-zA-Z0-9]{20,}|[a-zA-Z0-9]{32,})(?:$|[&\s,])/g;

const PASSWORD_PATTERN = /(?:(?:password|passwd|pwd|secret|token)\s*[=:]\s*)([^\s,;]+)/gi;

const SESSION_ID_PATTERN =
  /(?:session[_-]?id|sid|jsessionid|phpsessid|asp\.net_sessionid)\s*[=:]\s*([^\s,;]+)/gi;

const BEARER_PATTERN = /Bearer\s+[a-zA-Z0-9._-]+/gi;

const PEM_PATTERN = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;

// ─── Internal helpers ────────────────────────────────────────────────────────

const REPLACEMENT = "[REDACTED]";

function redactValue(value: string): string {
  let result = value;
  result = result.replace(JWT_PATTERN, REPLACEMENT);
  result = result.replace(PEM_PATTERN, REPLACEMENT);
  result = result.replace(BEARER_PATTERN, `Bearer ${REPLACEMENT}`);
  result = result.replace(SESSION_ID_PATTERN, (match) => {
    const idx = match.search(/[=:]/);
    return match.slice(0, idx + 1) + " " + REPLACEMENT;
  });
  result = result.replace(PASSWORD_PATTERN, (match) => {
    const idx = match.search(/[=:]/);
    return match.slice(0, idx + 1) + " " + REPLACEMENT;
  });
  result = result.replace(API_KEY_PATTERN, (match) => {
    const eqIdx = match.search(/[=:\s]/);
    const prefix = match.slice(0, eqIdx + 1);
    const rest = match.slice(eqIdx + 1);
    const trimmed = rest.trim();
    if (trimmed.length === 0) {
      return prefix + REPLACEMENT;
    }
    return prefix + " " + REPLACEMENT;
  });
  return result;
}

function redactString(value: string): string {
  if (typeof value !== "string") {
    return value;
  }
  return redactValue(value);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns a new RunError with the message sanitized.
 * Sensitive tokens (JWT, API keys, passwords, session IDs, PEM) are replaced.
 * The original error is never mutated.
 */
export function redactError(error: RunError): RunError {
  return {
    ...error,
    message: redactString(error.message),
  };
}

function redactEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(entry)) {
    if (typeof value === "string") {
      result[key] = redactValue(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === "string") {
          return redactValue(item);
        }
        if (item !== null && typeof item === "object") {
          return redactEntry(item as Record<string, unknown>);
        }
        return item;
      });
    } else if (value !== null && typeof value === "object") {
      result[key] = redactEntry(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Returns a new log entry with sensitive values sanitized.
 * The original entry is never mutated.
 */
export function redactLog(entry: Record<string, unknown>): Record<string, unknown> {
  return redactEntry(entry);
}
