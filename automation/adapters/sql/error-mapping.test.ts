import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import {
  sanitizeSqlErrorMessage,
  mapSqlConnectionError,
  sanitizedErrorCause,
} from "./error-mapping.js";

const SECRET = "TopSecret99";

describe("sanitizeSqlErrorMessage", () => {
  it("redacts password-like pairs", () => {
    const sanitized = sanitizeSqlErrorMessage(`login failed password=${SECRET} on server`);

    expect(sanitized).not.toContain(SECRET);
    expect(sanitized).toContain("password=[REDACTED]");
  });

  it("redacts pwd/passphrase/token style pairs", () => {
    const sanitized = sanitizeSqlErrorMessage(`auth error: pwd: ${SECRET}; token=${SECRET}`);

    expect(sanitized).not.toContain(SECRET);
    expect(sanitized).toContain("[REDACTED]");
  });

  it("never emits a credential-bearing connection string whole (AC-09)", () => {
    const raw = `Server=db01;Database=opsdb;User Id=svc;Password=${SECRET};`;
    const sanitized = sanitizeSqlErrorMessage(raw);

    expect(sanitized).toContain("[CONNECTION_STRING_REDACTED]");
    expect(sanitized).not.toContain(SECRET);
    expect(sanitized).not.toContain("db01");
    expect(sanitized).not.toContain("opsdb");
  });

  it("truncates very long messages", () => {
    const sanitized = sanitizeSqlErrorMessage("x".repeat(2000));

    expect(sanitized.length).toBeLessThanOrEqual(501);
    expect(sanitized.endsWith("…")).toBe(true);
  });

  it("leaves ordinary messages intact", () => {
    expect(sanitizeSqlErrorMessage("connection refused")).toBe("connection refused");
  });
});

describe("mapSqlConnectionError", () => {
  it("maps authentication failures to an actionable, sanitized error (AC-09)", () => {
    const cause = Object.assign(new Error(`Login failed. password=${SECRET}`), {
      code: "ELOGIN",
    });

    const mapped = mapSqlConnectionError(cause);

    expect(mapped.code).toBe("ELOGIN");
    expect(mapped.message).toContain("authentication failed");
    expect(mapped.message).not.toContain(SECRET);
    expect(mapped.action).toContain("SQL_SERVER_USER");
    expect(mapped.action).toContain("SQL_SERVER_PASSWORD");
    expect(mapped.action).toContain("SQL_SERVER_DATABASE");
  });

  it("maps reachability failures to host/port guidance", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:1433"), {
      code: "ECONNREFUSED",
    });

    const mapped = mapSqlConnectionError(cause);

    expect(mapped.code).toBe("ECONNREFUSED");
    expect(mapped.message).toContain("Cannot reach SQL Server");
    expect(mapped.action).toContain("SQL_SERVER_HOST");
    expect(mapped.action).toContain("SQL_SERVER_PORT");
  });

  it("maps timeouts to a retry-oriented action", () => {
    const cause = Object.assign(new Error("timeout"), { code: "ETIMEOUT" });

    const mapped = mapSqlConnectionError(cause);

    expect(mapped.code).toBe("ETIMEOUT");
    expect(mapped.message).toContain("timed out");
    expect(mapped.action).toContain("SQL_SERVER_HOST");
  });

  it("maps unknown failures with a generic actionable message", () => {
    const mapped = mapSqlConnectionError(new Error("something broke"));

    expect(mapped.code).toBe("EUNKNOWN");
    expect(mapped.message).toContain("SQL Server connection failed");
    expect(mapped.action).toContain("database/README.md");
  });

  it("handles non-Error values without leaking secrets", () => {
    const mapped = mapSqlConnectionError({
      code: "ELOGIN",
      message: `bad password=${SECRET}`,
    });

    expect(mapped.code).toBe("ELOGIN");
    expect(mapped.message).not.toContain(SECRET);
    expect(mapped.action.length).toBeGreaterThan(0);
  });

  it("sanitizes connection strings embedded in driver messages", () => {
    const cause = Object.assign(
      new Error(`Unable to connect: Server=db01;Database=opsdb;Password=${SECRET};`),
      { code: "ESOCKET" },
    );

    const mapped = mapSqlConnectionError(cause);

    expect(mapped.message).not.toContain(SECRET);
    expect(mapped.message).not.toContain("db01");
  });
});

describe("sanitizedErrorCause", () => {
  it("returns a plain { code, message } stand-in, never an Error instance (SEC-01)", () => {
    const cause = Object.assign(new Error(`login failed password=${SECRET}`), {
      code: "ELOGIN",
    });

    const standIn = sanitizedErrorCause(cause);

    expect(standIn).toEqual({ code: "ELOGIN", message: "login failed password=[REDACTED]" });
    expect(standIn).not.toBeInstanceOf(Error);
    expect(standIn.message).not.toContain(SECRET);
    expect(inspect(standIn)).not.toContain(SECRET);
  });

  it("redacts credential-bearing connection strings in the stand-in (SEC-01)", () => {
    const cause = Object.assign(
      new Error(`Server=db01;Database=opsdb;User Id=svc;Password=${SECRET};`),
      { code: "ESOCKET" },
    );

    const standIn = sanitizedErrorCause(cause);

    expect(standIn.code).toBe("ESOCKET");
    expect(standIn.message).toContain("[CONNECTION_STRING_REDACTED]");
    expect(standIn.message).not.toContain(SECRET);
    expect(inspect(standIn)).not.toContain(SECRET);
  });

  it("maps non-Error and string failures to EUNKNOWN without leaking values (SEC-01)", () => {
    const fromString = sanitizedErrorCause(`boom password=${SECRET}`);
    expect(fromString).toEqual({ code: "EUNKNOWN", message: "boom password=[REDACTED]" });
    expect(fromString).not.toBeInstanceOf(Error);

    const fromObject = sanitizedErrorCause({
      code: "EREQUEST",
      message: `bad password=${SECRET}`,
    });
    expect(fromObject).toEqual({ code: "EREQUEST", message: "bad password=[REDACTED]" });
    expect(inspect(fromObject)).not.toContain(SECRET);
  });

  it("falls back to String(error) for values without a message", () => {
    expect(sanitizedErrorCause(undefined)).toEqual({
      code: "EUNKNOWN",
      message: "undefined",
    });
  });
});
