import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import {
  computeMigrationChecksum,
  createSqlMigrationExecutor,
  loadMigrations,
  runMigrations,
  MigrationApprovalRequiredError,
  MigrationChecksumMismatchError,
  MigrationDirectoryError,
  MigrationExecutionError,
  MigrationStateError,
  type AppliedMigration,
  type MigrationExecutor,
  type MigrationFile,
} from "./migration-runner.js";
import type { SqlExecutor, SqlQueryResult, SqlStatement } from "./sql-pool.js";

// --- Helpers -------------------------------------------------------------------

const tempDirs: string[] = [];

function createTempMigrations(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "sprint5-migrations-"));
  tempDirs.push(dir);
  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(join(dir, fileName), content, "utf8");
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const SECRET = "S3cret-Pass-Not-Logged";

class FakeMigrationExecutor implements MigrationExecutor {
  readonly ledger: AppliedMigration[] = [];
  readonly appliedFiles: MigrationFile[] = [];
  failOnVersion: number | null = null;
  /** When set together with failOnVersion, thrown as the raw driver error. */
  failureError: Error | null = null;
  ensureCalled = false;

  async ensureMigrationsTable(): Promise<void> {
    this.ensureCalled = true;
  }

  async listApplied(): Promise<readonly AppliedMigration[]> {
    return [...this.ledger];
  }

  async applyMigration(file: MigrationFile): Promise<void> {
    if (this.failOnVersion === file.version) {
      throw this.failureError ?? new Error(`simulated failure at version ${file.version}`);
    }
    this.appliedFiles.push(file);
    this.ledger.push({
      version: file.version,
      name: file.name,
      checksum: file.checksum,
      appliedAt: new Date("2026-01-01T00:00:00Z"),
    });
  }
}

const TWO_MIGRATIONS: Record<string, string> = {
  "001_first.sql": "CREATE TABLE dbo.Alpha (Id INT NOT NULL);\n",
  "002_second.sql": "CREATE TABLE dbo.Beta (Id INT NOT NULL);\n",
};

// --- Checksums -----------------------------------------------------------------

describe("computeMigrationChecksum", () => {
  it("is deterministic across line-ending styles", () => {
    const lf = "CREATE TABLE dbo.T (Id INT);\nGO\n";
    const crlf = "CREATE TABLE dbo.T (Id INT);\r\nGO\r\n";

    expect(computeMigrationChecksum(lf)).toBe(computeMigrationChecksum(crlf));
  });

  it("changes when content changes", () => {
    expect(computeMigrationChecksum("a")).not.toBe(computeMigrationChecksum("b"));
  });

  it("produces a 64-character sha256 hex digest", () => {
    expect(computeMigrationChecksum("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// --- Discovery -----------------------------------------------------------------

describe("loadMigrations", () => {
  it("loads versioned migrations in ascending order", async () => {
    const dir = createTempMigrations(TWO_MIGRATIONS);

    const migrations = await loadMigrations(dir);

    expect(migrations.map((migration) => migration.version)).toEqual([1, 2]);
    expect(migrations[0].name).toBe("first");
    expect(migrations[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails actionably when the directory does not exist", async () => {
    await expect(loadMigrations(join(tmpdir(), "does-not-exist-sprint5"))).rejects.toThrow(
      MigrationDirectoryError,
    );
  });

  it("attaches only a sanitized stand-in as cause for directory failures (SEC-01)", async () => {
    let caught: unknown;
    try {
      await loadMigrations(join(tmpdir(), "does-not-exist-sprint5"));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationDirectoryError);
    const directoryError = caught as MigrationDirectoryError;
    expect(directoryError.cause).toEqual({
      code: "ENOENT",
      message: expect.stringContaining("no such file or directory"),
    });
    expect(directoryError.cause).not.toBeInstanceOf(Error);
    // The raw fs error (with its own stack and enumerable fields) must
    // never be forwarded — only the plain { code, message } stand-in.
    expect(Object.keys(directoryError.cause as object).sort()).toEqual(["code", "message"]);
  });

  it("fails actionably on malformed file names", async () => {
    const dir = createTempMigrations({ "not-versioned.sql": "SELECT 1;" });

    await expect(loadMigrations(dir)).rejects.toThrow(MigrationDirectoryError);
  });

  it("fails actionably on version gaps", async () => {
    const dir = createTempMigrations({
      "001_first.sql": "SELECT 1;",
      "003_third.sql": "SELECT 1;",
    });

    await expect(loadMigrations(dir)).rejects.toThrow(/sequence gap/i);
  });

  it("fails actionably on duplicate versions", async () => {
    const dir = createTempMigrations({
      "001_first.sql": "SELECT 1;",
      "001_other.sql": "SELECT 2;",
    });

    await expect(loadMigrations(dir)).rejects.toThrow(/Duplicate migration version 1/i);
  });
});

// --- Runner (AC-11, AC-12, Seção 6) --------------------------------------------

describe("runMigrations", () => {
  it("applies pending migrations in order when explicitly approved (AC-11)", async () => {
    const dir = createTempMigrations(TWO_MIGRATIONS);
    const executor = new FakeMigrationExecutor();

    const summary = await runMigrations({ executor, migrationsDir: dir, apply: true });

    expect(executor.ensureCalled).toBe(true);
    expect(summary.applied).toEqual([1, 2]);
    expect(summary.pending).toEqual([]);
    expect(executor.ledger.map((row) => row.version)).toEqual([1, 2]);
    expect(executor.ledger[0].name).toBe("first");
    expect(executor.ledger[0].checksum).toBe(executor.appliedFiles[0].checksum);
  });

  it("reapplication is a safe no-op (AC-12)", async () => {
    const dir = createTempMigrations(TWO_MIGRATIONS);
    const executor = new FakeMigrationExecutor();

    await runMigrations({ executor, migrationsDir: dir, apply: true });
    const second = await runMigrations({ executor, migrationsDir: dir, apply: true });

    expect(second.applied).toEqual([]);
    expect(second.pending).toEqual([]);
    expect(second.skipped).toEqual([1, 2]);
    expect(executor.appliedFiles).toHaveLength(2);
    expect(executor.ledger).toHaveLength(2);
  });

  it("is a no-op when everything is already applied and apply is omitted", async () => {
    const dir = createTempMigrations({ "001_first.sql": "SELECT 1;" });
    const executor = new FakeMigrationExecutor();

    await runMigrations({ executor, migrationsDir: dir, apply: true });
    const summary = await runMigrations({ executor, migrationsDir: dir });

    expect(summary.applied).toEqual([]);
    expect(summary.skipped).toEqual([1]);
  });

  it("never applies anything without the explicit apply flag (AC-13)", async () => {
    const dir = createTempMigrations(TWO_MIGRATIONS);
    const executor = new FakeMigrationExecutor();

    let caught: unknown;
    try {
      await runMigrations({ executor, migrationsDir: dir });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationApprovalRequiredError);
    const approvalError = caught as MigrationApprovalRequiredError;
    expect(approvalError.pendingVersions).toEqual([1, 2]);
    expect(approvalError.action).toContain("apply=true");
    expect(approvalError.action).toContain("never migrate production");
    expect(executor.appliedFiles).toHaveLength(0);
    expect(executor.ledger).toHaveLength(0);
  });

  it("treats apply: false exactly like an omitted flag", async () => {
    const dir = createTempMigrations({ "001_first.sql": "SELECT 1;" });
    const executor = new FakeMigrationExecutor();

    await expect(runMigrations({ executor, migrationsDir: dir, apply: false })).rejects.toThrow(
      MigrationApprovalRequiredError,
    );
    expect(executor.appliedFiles).toHaveLength(0);
  });

  it("fails loudly when an applied migration file was rewritten (Seção 6)", async () => {
    const dir = createTempMigrations({ "001_first.sql": "CREATE TABLE dbo.Alpha (Id INT);" });
    const executor = new FakeMigrationExecutor();

    await runMigrations({ executor, migrationsDir: dir, apply: true });

    writeFileSync(join(dir, "001_first.sql"), "CREATE TABLE dbo.Alpha (Id BIGINT);", "utf8");

    let caught: unknown;
    try {
      await runMigrations({ executor, migrationsDir: dir, apply: true });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationChecksumMismatchError);
    const mismatchError = caught as MigrationChecksumMismatchError;
    expect(mismatchError.version).toBe(1);
    expect(mismatchError.action).toContain("never rewrite");
    expect(executor.appliedFiles).toHaveLength(1);
  });

  it("fails loudly on partial recorded state (Seção 6)", async () => {
    const dir = createTempMigrations({
      "001_first.sql": "SELECT 1;",
      "002_second.sql": "SELECT 1;",
    });
    const executor = new FakeMigrationExecutor();
    executor.ledger.push({
      version: 2,
      name: "second",
      checksum: computeMigrationChecksum("SELECT 1;"),
      appliedAt: new Date(),
    });

    await expect(runMigrations({ executor, migrationsDir: dir, apply: true })).rejects.toThrow(
      MigrationStateError,
    );
    expect(executor.appliedFiles).toHaveLength(0);
  });

  it("fails loudly when the ledger references a missing file", async () => {
    const dir = createTempMigrations({ "001_first.sql": "SELECT 1;" });
    const executor = new FakeMigrationExecutor();
    executor.ledger.push({
      version: 1,
      name: "first",
      checksum: computeMigrationChecksum("SELECT 1;"),
      appliedAt: new Date(),
    });
    executor.ledger.push({
      version: 2,
      name: "ghost",
      checksum: "a".repeat(64),
      appliedAt: new Date(),
    });

    await expect(runMigrations({ executor, migrationsDir: dir, apply: true })).rejects.toThrow(
      /no corresponding file/i,
    );
  });

  it("stops at the first failing migration and reports context (Seção 6)", async () => {
    const dir = createTempMigrations(TWO_MIGRATIONS);
    const executor = new FakeMigrationExecutor();
    executor.failOnVersion = 2;

    let caught: unknown;
    try {
      await runMigrations({ executor, migrationsDir: dir, apply: true });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationExecutionError);
    const executionError = caught as MigrationExecutionError;
    expect(executionError.version).toBe(2);
    expect(executionError.appliedBeforeFailure).toEqual([1]);
    expect(executionError.action).toContain("version 2");
    expect(executor.ledger.map((row) => row.version)).toEqual([1]);
    expect(executor.appliedFiles.map((file) => file.version)).toEqual([1]);
  });

  it("attaches only a sanitized stand-in as cause for execution failures (SEC-01)", async () => {
    const dir = createTempMigrations(TWO_MIGRATIONS);
    const executor = new FakeMigrationExecutor();
    executor.failOnVersion = 2;
    executor.failureError = Object.assign(new Error(`Violation of UNIQUE KEY password=${SECRET}`), {
      code: "EREQUEST",
    });

    let caught: unknown;
    try {
      await runMigrations({ executor, migrationsDir: dir, apply: true });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationExecutionError);
    const executionError = caught as MigrationExecutionError;
    expect(executionError.cause).toEqual({
      code: "EREQUEST",
      message: `Violation of UNIQUE KEY password=[REDACTED]`,
    });
    expect(executionError.cause).not.toBeInstanceOf(Error);
    expect(inspect(executionError)).not.toContain(SECRET);
    expect(inspect(executionError.cause)).not.toContain(SECRET);
  });

  it("fails on duplicate ledger entries", async () => {
    const dir = createTempMigrations({ "001_first.sql": "SELECT 1;" });
    const executor = new FakeMigrationExecutor();
    const record: AppliedMigration = {
      version: 1,
      name: "first",
      checksum: computeMigrationChecksum("SELECT 1;"),
      appliedAt: new Date(),
    };
    executor.ledger.push(record, { ...record });

    await expect(runMigrations({ executor, migrationsDir: dir })).rejects.toThrow(
      /Duplicate ledger entry/i,
    );
  });
});

// --- SQL adapter for the runner -------------------------------------------------

describe("createSqlMigrationExecutor", () => {
  function createFakeSqlExecutor(result: SqlQueryResult): SqlExecutor & {
    readonly queries: string[];
    readonly transactions: SqlStatement[][];
    readonly closed: boolean;
  } {
    const state = {
      queries: [] as string[],
      transactions: [] as SqlStatement[][],
      closed: false,
    };

    const executor: SqlExecutor = {
      async query(text: string): Promise<SqlQueryResult> {
        state.queries.push(text);
        return result;
      },
      async transaction(statements: readonly SqlStatement[]): Promise<void> {
        state.transactions.push([...statements]);
      },
      async close(): Promise<void> {
        state.closed = true;
      },
    };

    return { ...executor, ...state };
  }

  it("ensures the ledger table with an idempotent CREATE", async () => {
    const sqlExecutor = createFakeSqlExecutor({ columns: [], rows: [] });
    const migrationExecutor = createSqlMigrationExecutor(sqlExecutor);

    await migrationExecutor.ensureMigrationsTable();

    expect(sqlExecutor.queries).toHaveLength(1);
    expect(sqlExecutor.queries[0]).toContain("CREATE TABLE dbo.SchemaMigrations");
    expect(sqlExecutor.queries[0]).toContain("IF OBJECT_ID");
  });

  it("reads the ledger rows into typed records", async () => {
    const appliedAt = new Date("2026-02-03T04:05:06Z");
    const sqlExecutor = createFakeSqlExecutor({
      columns: ["Version", "Name", "Checksum", "AppliedAt"],
      rows: [[1, "initial_schema", "b".repeat(64), appliedAt]],
    });
    const migrationExecutor = createSqlMigrationExecutor(sqlExecutor);

    const applied = await migrationExecutor.listApplied();

    expect(applied).toHaveLength(1);
    expect(applied[0].version).toBe(1);
    expect(applied[0].name).toBe("initial_schema");
    expect(applied[0].checksum).toBe("b".repeat(64));
    expect(applied[0].appliedAt).toBe(appliedAt);
  });

  it("fails actionably when the ledger query shape is unexpected", async () => {
    const sqlExecutor = createFakeSqlExecutor({ columns: ["SomethingElse"], rows: [] });
    const migrationExecutor = createSqlMigrationExecutor(sqlExecutor);

    await expect(migrationExecutor.listApplied()).rejects.toThrow(MigrationStateError);
  });

  it("applies each migration and its ledger insert in one transaction", async () => {
    const sqlExecutor = createFakeSqlExecutor({ columns: [], rows: [] });
    const migrationExecutor = createSqlMigrationExecutor(sqlExecutor);
    const file: MigrationFile = {
      version: 1,
      name: "initial_schema",
      fileName: "001_initial_schema.sql",
      checksum: "c".repeat(64),
      sql: "CREATE TABLE dbo.Runs (RunId NVARCHAR(64) NOT NULL);",
    };

    await migrationExecutor.applyMigration(file);

    expect(sqlExecutor.transactions).toHaveLength(1);
    const statements = sqlExecutor.transactions[0];
    expect(statements).toHaveLength(2);
    expect(statements[0].text).toContain("sp_executesql");
    // REV-01: the script is an explicit NVARCHAR(MAX) marker — never the
    // raw string that would rely on the driver's implicit inference.
    expect(statements[0].params?.script).toEqual({
      type: "NVarCharMax",
      value: file.sql,
    });
    expect(statements[0].params?.script).not.toBe(file.sql);
    expect(statements[1].text).toContain("INSERT INTO dbo.SchemaMigrations");
    expect(statements[1].params).toEqual({
      version: 1,
      name: "initial_schema",
      checksum: "c".repeat(64),
    });
  });

  it("keeps the CREATE SchemaMigrations block in strict parity with 001_initial_schema.sql (REV-04)", async () => {
    const sqlExecutor = createFakeSqlExecutor({ columns: [], rows: [] });
    const migrationExecutor = createSqlMigrationExecutor(sqlExecutor);

    await migrationExecutor.ensureMigrationsTable();

    const migrationFile = readFileSync(
      new URL("../../../database/migrations/001_initial_schema.sql", import.meta.url),
      "utf8",
    );

    expect(normalizeSqlBlock(extractSchemaMigrationsBlock(sqlExecutor.queries[0]))).toBe(
      normalizeSqlBlock(extractSchemaMigrationsBlock(migrationFile)),
    );
  });
});

/**
 * Extracts the guarded `IF OBJECT_ID(N'dbo.SchemaMigrations' ... END`
 * block so the runtime constant and the versioned migration can be
 * compared for strict parity (REV-04).
 */
function extractSchemaMigrationsBlock(sql: string): string {
  const match = /IF OBJECT_ID\(N'dbo\.SchemaMigrations'[\s\S]*?\bEND;?/i.exec(sql);
  if (match === null) {
    throw new Error("dbo.SchemaMigrations guard block not found");
  }
  return match[0];
}

/** Collapses whitespace, lowercases, and strips a trailing `;`. */
function normalizeSqlBlock(block: string): string {
  return block.replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();
}
