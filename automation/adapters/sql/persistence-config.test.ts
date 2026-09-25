import { describe, expect, it } from "vitest";

import {
  resolvePersistenceProvider,
  resolvePersistenceConfig,
  PersistenceConfigError,
} from "./persistence-config.js";
import { SqlConfigValidationError } from "./sql-config.js";

function sqlEnv(): Record<string, string> {
  return {
    SQL_SERVER_HOST: "sql01.internal.example",
    SQL_SERVER_PORT: "1433",
    SQL_SERVER_DATABASE: "opsdb",
    SQL_SERVER_USER: "marketing_ops_runtime",
    SQL_SERVER_PASSWORD: "placeholder-not-a-real-secret",
  };
}

describe("resolvePersistenceProvider", () => {
  it("defaults to filesystem when the variable is absent (retrocompatible)", () => {
    expect(resolvePersistenceProvider({})).toBe("filesystem");
  });

  it("accepts the explicit filesystem value", () => {
    expect(resolvePersistenceProvider({ PERSISTENCE_PROVIDER: "filesystem" })).toBe("filesystem");
  });

  it("accepts the explicit sqlserver value", () => {
    expect(resolvePersistenceProvider({ PERSISTENCE_PROVIDER: "sqlserver" })).toBe(
      "sqlserver" as const,
    );
  });

  it("trims surrounding whitespace", () => {
    expect(resolvePersistenceProvider({ PERSISTENCE_PROVIDER: " filesystem " })).toBe("filesystem");
  });

  it("fails closed on unknown values with an actionable error", () => {
    expect(() => resolvePersistenceProvider({ PERSISTENCE_PROVIDER: "postgres" })).toThrow(
      PersistenceConfigError,
    );

    let caught: unknown;
    try {
      resolvePersistenceProvider({ PERSISTENCE_PROVIDER: "postgres" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PersistenceConfigError);
    const configError = caught as PersistenceConfigError;
    expect(configError.message).toContain('"postgres"');
    expect(configError.action).toContain("filesystem");
    expect(configError.action).toContain("sqlserver");
  });

  it("fails closed on an empty value", () => {
    expect(() => resolvePersistenceProvider({ PERSISTENCE_PROVIDER: "" })).toThrow(
      PersistenceConfigError,
    );
  });

  it("fails closed on case variants (exact literals only)", () => {
    expect(() => resolvePersistenceProvider({ PERSISTENCE_PROVIDER: "FileSystem" })).toThrow(
      PersistenceConfigError,
    );
  });
});

describe("resolvePersistenceConfig", () => {
  it("returns filesystem without requiring SQL variables", () => {
    expect(resolvePersistenceConfig({})).toEqual({ provider: "filesystem" });
  });

  it("validates SQL configuration before any connection when sqlserver is selected", () => {
    const config = resolvePersistenceConfig({
      PERSISTENCE_PROVIDER: "sqlserver",
      ...sqlEnv(),
    });

    expect(config.provider).toBe("sqlserver");
    if (config.provider !== "sqlserver") {
      return;
    }
    expect(config.sql.database).toBe("opsdb");
    expect(config.sql.port).toBe(1433);
  });

  it("fails closed when sqlserver is selected without SQL variables", () => {
    expect(() => resolvePersistenceConfig({ PERSISTENCE_PROVIDER: "sqlserver" })).toThrow(
      SqlConfigValidationError,
    );

    let caught: unknown;
    try {
      resolvePersistenceConfig({ PERSISTENCE_PROVIDER: "sqlserver" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SqlConfigValidationError);
    const validationError = caught as SqlConfigValidationError;
    expect(validationError.issues.join("; ")).toContain("SQL_SERVER_HOST");
    expect(validationError.issues.join("; ")).toContain("SQL_SERVER_PASSWORD");
  });

  it("still fails closed on unknown providers even with SQL variables present", () => {
    expect(() => resolvePersistenceConfig({ PERSISTENCE_PROVIDER: "mysql", ...sqlEnv() })).toThrow(
      PersistenceConfigError,
    );
  });
});
