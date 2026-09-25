import { describe, expect, it } from "vitest";

import {
  parseSqlServerConfig,
  describeSqlServerConfig,
  SqlConfigValidationError,
} from "./sql-config.js";

const SECRET_VALUE = "Sup3rS3cret!Value";

function validEnv(): Record<string, string> {
  return {
    SQL_SERVER_HOST: "sql01.internal.example",
    SQL_SERVER_PORT: "1433",
    SQL_SERVER_DATABASE: "opsdb",
    SQL_SERVER_USER: "marketing_ops_runtime",
    SQL_SERVER_PASSWORD: SECRET_VALUE,
  };
}

describe("parseSqlServerConfig", () => {
  it("supports the existing SQL_SERVER_* configuration names (AC-06)", () => {
    const config = parseSqlServerConfig(validEnv());

    expect(config).toEqual({
      host: "sql01.internal.example",
      port: 1433,
      database: "opsdb",
      user: "marketing_ops_runtime",
      password: SECRET_VALUE,
    });
  });

  it("accepts a non-default port", () => {
    const env = { ...validEnv(), SQL_SERVER_PORT: "14330" };

    expect(parseSqlServerConfig(env).port).toBe(14330);
  });

  it("validates before connecting: rejects an invalid port with an actionable error (AC-08)", () => {
    const env = { ...validEnv(), SQL_SERVER_PORT: "not-a-port" };

    expect(() => parseSqlServerConfig(env)).toThrow(SqlConfigValidationError);

    let caught: unknown;
    try {
      parseSqlServerConfig(env);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SqlConfigValidationError);
    const validationError = caught as SqlConfigValidationError;
    expect(validationError.issues.join("; ")).toContain("SQL_SERVER_PORT");
    expect(validationError.issues.join("; ")).toContain("between 1 and 65535");
  });

  it("rejects ports outside 1..65535", () => {
    for (const port of ["0", "70000", "65536"]) {
      const env = { ...validEnv(), SQL_SERVER_PORT: port };
      expect(() => parseSqlServerConfig(env)).toThrow(SqlConfigValidationError);
    }
  });

  it("reports every missing variable by name (AC-08)", () => {
    let caught: unknown;
    try {
      parseSqlServerConfig({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SqlConfigValidationError);
    const issues = (caught as SqlConfigValidationError).issues.join("; ");
    expect(issues).toContain("SQL_SERVER_HOST");
    expect(issues).toContain("SQL_SERVER_PORT");
    expect(issues).toContain("SQL_SERVER_DATABASE");
    expect(issues).toContain("SQL_SERVER_USER");
    expect(issues).toContain("SQL_SERVER_PASSWORD");
  });

  it("rejects empty values", () => {
    const env = { ...validEnv(), SQL_SERVER_HOST: "", SQL_SERVER_PASSWORD: "" };

    let caught: unknown;
    try {
      parseSqlServerConfig(env);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SqlConfigValidationError);
    const issues = (caught as SqlConfigValidationError).issues.join("; ");
    expect(issues).toContain("SQL_SERVER_HOST");
    expect(issues).toContain("SQL_SERVER_PASSWORD");
  });

  it("never includes configuration values — especially the password — in errors (AC-07/AC-60)", () => {
    const env = { ...validEnv(), SQL_SERVER_DATABASE: "" };

    let caught: unknown;
    try {
      parseSqlServerConfig(env);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SqlConfigValidationError);
    const validationError = caught as SqlConfigValidationError;
    expect(validationError.message).not.toContain(SECRET_VALUE);
    expect(validationError.message).not.toContain("sql01.internal.example");
    expect(validationError.issues.join("; ")).not.toContain(SECRET_VALUE);
  });
});

describe("describeSqlServerConfig", () => {
  it("describes the configuration without the password", () => {
    const config = parseSqlServerConfig(validEnv());
    const described = describeSqlServerConfig(config);
    const serialized = JSON.stringify(described);

    expect(described.host).toBe("sql01.internal.example");
    expect(described.port).toBe(1433);
    expect(described.database).toBe("opsdb");
    expect(described.user).toBe("marketing_ops_runtime");
    expect(Object.keys(described)).not.toContain("password");
    expect(serialized).not.toContain(SECRET_VALUE);
  });
});
