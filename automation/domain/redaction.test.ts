import { describe, expect, it } from "vitest";

import type { RunError } from "./run-state.js";
import { redactError, redactLog } from "./redaction.js";

const STRIPE_LIKE_TEST_KEY = ["sk", "live", "abc123def456ghi789jkl0mno"].join("_");
const STRIPE_TEST_LIKE_TEST_KEY = ["sk", "test", "abcdef1234567890abcdef"].join("_");
// ─── redactError ─────────────────────────────────────────────────────────────

describe("redactError", () => {
  it("redacts JWT tokens from error message", () => {
    const error: RunError = {
      message:
        "Request failed with token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U in header",
    };
    const result = redactError(error);

    expect(result.message).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(result.message).toContain("[REDACTED]");
  });

  it("redacts API keys from error message", () => {
    const error: RunError = {
      message: `Authentication failed: ${STRIPE_LIKE_TEST_KEY} is invalid`,
    };
    const result = redactError(error);

    expect(result.message).not.toContain(STRIPE_LIKE_TEST_KEY);
    expect(result.message).toContain("[REDACTED]");
  });

  it("redacts passwords from error message", () => {
    const error: RunError = {
      message: "Connection failed: password=S3cr3tP@ssw0rd on host db.example.com",
    };
    const result = redactError(error);

    expect(result.message).not.toContain("S3cr3tP@ssw0rd");
    expect(result.message).toContain("[REDACTED]");
  });

  it("redacts session IDs from error message", () => {
    const error: RunError = {
      message: "Session expired: session_id=abc123xyz789 for user 42",
    };
    const result = redactError(error);

    expect(result.message).not.toContain("abc123xyz789");
    expect(result.message).toContain("[REDACTED]");
  });

  it("preserves code and retryable fields", () => {
    const error: RunError = {
      message: "Auth failed: token=secret123",
      code: "AUTH_ERROR",
      retryable: true,
    };
    const result = redactError(error);

    expect(result.code).toBe("AUTH_ERROR");
    expect(result.retryable).toBe(true);
  });

  it("handles string without sensitive data (passthrough)", () => {
    const error: RunError = { message: "Connection timed out after 30s" };
    const result = redactError(error);

    expect(result.message).toBe("Connection timed out after 30s");
  });

  it("does not mutate the original error", () => {
    const error: RunError = { message: "Token: eyJabc.def.ghi" };
    const originalMessage = error.message;
    redactError(error);

    expect(error.message).toBe(originalMessage);
  });
});

// ─── redactLog ───────────────────────────────────────────────────────────────

describe("redactLog", () => {
  it("redacts sensitive values in message field", () => {
    const entry = { message: "Auth failed: password=MySecret123" };
    const result = redactLog(entry);

    expect(result.message).toBe("Auth failed: password= [REDACTED]");
  });

  it("redacts sensitive values in error field", () => {
    const entry = { error: `token=${STRIPE_TEST_LIKE_TEST_KEY}` };
    const result = redactLog(entry);

    expect(result.error).not.toContain(STRIPE_TEST_LIKE_TEST_KEY);
    expect(result.error).toContain("[REDACTED]");
  });

  it("redacts sensitive values in detail field", () => {
    const entry = { detail: "Bearer eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE2" };
    const result = redactLog(entry);

    expect(result.detail).not.toContain("eyJhbGciOiJSUzI1NiJ9");
    expect(result.detail).toContain("[REDACTED]");
  });

  it("preserves non-sensitive fields unchanged", () => {
    const entry = {
      level: "error",
      timestamp: "2026-01-01T00:00:00Z",
      userId: 42,
      message: "Something went wrong",
    };
    const result = redactLog(entry);

    expect(result.level).toBe("error");
    expect(result.timestamp).toBe("2026-01-01T00:00:00Z");
    expect(result.userId).toBe(42);
  });

  it("redacts JWT in nested object values", () => {
    const entry = {
      headers: { Authorization: "Bearer eyJabc.def.ghi" },
    };
    const result = redactLog(entry);

    const headers = result.headers as Record<string, string>;
    expect(headers.Authorization).toContain("[REDACTED]");
  });

  it("redacts values in array elements", () => {
    const entry = {
      tokens: ["eyJabc.def.ghi", "normal-string", STRIPE_LIKE_TEST_KEY],
    };
    const result = redactLog(entry);

    const tokens = result.tokens as string[];
    expect(tokens[0]).toContain("[REDACTED]");
    expect(tokens[1]).toBe("normal-string");
    expect(tokens[2]).toContain("[REDACTED]");
  });

  it("handles empty log entry", () => {
    const entry: Record<string, unknown> = {};
    const result = redactLog(entry);

    expect(result).toEqual({});
  });

  it("does not mutate the original entry", () => {
    const entry = { message: "password=secret123" };
    const original = JSON.parse(JSON.stringify(entry));
    redactLog(entry);

    expect(entry).toEqual(original);
  });

  it("handles string without sensitive data (passthrough)", () => {
    const entry = { message: "Job completed successfully in 42ms" };
    const result = redactLog(entry);

    expect(result.message).toBe("Job completed successfully in 42ms");
  });

  it("redacts PEM keys in string values", () => {
    const entry = {
      detail: "Key: -----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
    };
    const result = redactLog(entry);

    expect(result.detail).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(result.detail).toContain("[REDACTED]");
  });
});
