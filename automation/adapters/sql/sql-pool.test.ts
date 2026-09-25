import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { createSqlMigrationExecutor, type MigrationFile } from "./migration-runner.js";
import {
  createSqlExecutor,
  defaultMssqlModuleLoader,
  nvarcharMax,
  toMssqlConnectOptions,
  SqlExecutorError,
  type MssqlConnectOptions,
  type MssqlModuleLike,
  type MssqlQueryLike,
  type MssqlRecordsetLike,
} from "./sql-pool.js";
import type { SqlServerConfig } from "./sql-config.js";

const CONFIG: SqlServerConfig = {
  host: "sql01.internal.example",
  port: 1433,
  database: "opsdb",
  user: "marketing_ops_runtime",
  password: "S3cret-Pass-Not-Logged",
};

/**
 * Builds a DEFAULT-mode driver result exactly like `mssql`/tedious does
 * with `arrayRowMode` off (REV-01): an array of row objects with column
 * metadata attached as a NON-enumerable `columns` property.
 */
function createDriverResult(
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): MssqlQueryLike {
  const recordset = rows.map((row) =>
    Object.fromEntries(columns.map((name, index) => [name, row[index]])),
  );
  Object.defineProperty(recordset, "columns", {
    enumerable: false,
    value: Object.fromEntries(columns.map((name) => [name, {}])),
  });
  return { recordset: recordset as unknown as MssqlRecordsetLike };
}

interface FakeTypedInput {
  readonly name: string;
  readonly type: unknown;
  readonly value: unknown;
}

interface FakeModuleOptions {
  readonly queryResult?: MssqlQueryLike;
  readonly queryError?: Error;
  readonly connectError?: Error;
  readonly beginError?: Error;
  readonly commitError?: Error;
  readonly closeError?: Error;
}

interface FakeModuleRecorded {
  connectOptions: MssqlConnectOptions | null;
  readonly queries: {
    text: string;
    params: Record<string, unknown>;
    typedInputs: FakeTypedInput[];
    viaTransaction: boolean;
  }[];
  begins: number;
  commits: number;
  rollbacks: number;
  closes: number;
}

function createFakeMssqlModule(options: FakeModuleOptions = {}): {
  readonly module: MssqlModuleLike;
  readonly recorded: FakeModuleRecorded;
} {
  const recorded: FakeModuleRecorded = {
    connectOptions: null,
    queries: [],
    begins: 0,
    commits: 0,
    rollbacks: 0,
    closes: 0,
  };

  class FakeRequest {
    readonly params: Record<string, unknown> = {};
    readonly typedInputs: FakeTypedInput[] = [];
    readonly parent: unknown;

    constructor(parent: unknown) {
      this.parent = parent;
    }

    // Overloads mirror MssqlRequestLike: plain inference vs explicit type.
    input(...args: [string, unknown] | [string, unknown, unknown]): this {
      if (args.length === 3) {
        const [name, type, value] = args as [string, unknown, unknown];
        this.typedInputs.push({ name, type, value });
        this.params[name] = value;
        return this;
      }
      const [name, value] = args;
      this.params[name] = value;
      return this;
    }

    async query(text: string): Promise<MssqlQueryLike> {
      recorded.queries.push({
        text,
        params: { ...this.params },
        typedInputs: [...this.typedInputs],
        viaTransaction: this.parent instanceof FakeTransaction,
      });
      if (options.queryError !== undefined) {
        throw options.queryError;
      }
      return options.queryResult ?? {};
    }
  }

  class FakeTransaction {
    constructor(_pool: unknown) {}

    async begin(): Promise<void> {
      recorded.begins += 1;
      if (options.beginError !== undefined) {
        throw options.beginError;
      }
    }

    async commit(): Promise<void> {
      recorded.commits += 1;
      if (options.commitError !== undefined) {
        throw options.commitError;
      }
    }

    async rollback(): Promise<void> {
      recorded.rollbacks += 1;
    }
  }

  class FakePool {
    request(): FakeRequest {
      return new FakeRequest("pool");
    }

    async close(): Promise<void> {
      recorded.closes += 1;
      if (options.closeError !== undefined) {
        throw options.closeError;
      }
    }
  }

  class FakeConnectionPool {
    constructor(connectOptions: MssqlConnectOptions) {
      recorded.connectOptions = connectOptions;
    }

    async connect(): Promise<FakePool> {
      if (options.connectError !== undefined) {
        throw options.connectError;
      }
      return new FakePool();
    }
  }

  return {
    module: {
      ConnectionPool: FakeConnectionPool,
      Request: FakeRequest,
      Transaction: FakeTransaction,
      NVarChar: (length: number) => ({ nVarChar: length }),
      DateTime2: (scale: number) => ({ dateTime2: scale }),
      MAX: 65535,
    },
    recorded,
  };
}

describe("toMssqlConnectOptions", () => {
  it("maps validated config with explicit fail-closed TLS behavior", () => {
    const options = toMssqlConnectOptions(CONFIG);

    expect(options.server).toBe(CONFIG.host);
    expect(options.port).toBe(1433);
    expect(options.database).toBe("opsdb");
    expect(options.user).toBe(CONFIG.user);
    expect(options.password).toBe(CONFIG.password);
    expect(options.options.encrypt).toBe(true);
    expect(options.options.trustServerCertificate).toBe(false);
  });
});

describe("createSqlExecutor", () => {
  it("connects through the injected module and reports query results", async () => {
    const { module, recorded } = createFakeMssqlModule({
      queryResult: createDriverResult(
        ["Version", "Name"],
        [
          [1, "initial_schema"],
          [2, "second"],
        ],
      ),
    });

    const executor = await createSqlExecutor(CONFIG, { loadModule: async () => module });

    expect(recorded.connectOptions?.server).toBe(CONFIG.host);
    expect(recorded.connectOptions?.options.encrypt).toBe(true);

    const result = await executor.query("SELECT Version, Name FROM dbo.SchemaMigrations");

    expect(result.columns).toEqual(["Version", "Name"]);
    expect(result.rows).toEqual([
      [1, "initial_schema"],
      [2, "second"],
    ]);
  });

  it("reads column order from non-enumerable recordset.columns metadata (REV-01)", async () => {
    const { module } = createFakeMssqlModule({
      queryResult: createDriverResult(["Name", "Version"], [["first", 1]]),
    });

    const executor = await createSqlExecutor(CONFIG, { loadModule: async () => module });
    const result = await executor.query("SELECT Name, Version FROM dbo.SchemaMigrations");

    expect(result.columns).toEqual(["Name", "Version"]);
    expect(result.rows).toEqual([["first", 1]]);
  });

  it("returns columns with zero rows when metadata exists but the recordset is empty (REV-01)", async () => {
    const { module } = createFakeMssqlModule({
      queryResult: createDriverResult(["Version", "Name"], []),
    });

    const executor = await createSqlExecutor(CONFIG, { loadModule: async () => module });
    const result = await executor.query("SELECT Version, Name FROM dbo.SchemaMigrations");

    expect(result.columns).toEqual(["Version", "Name"]);
    expect(result.rows).toEqual([]);
  });

  it("falls back to the first row's keys when columns metadata is absent (REV-01)", async () => {
    const { module } = createFakeMssqlModule({
      queryResult: {
        recordset: [{ Version: 1, Name: "initial_schema" }],
      },
    });

    const executor = await createSqlExecutor(CONFIG, { loadModule: async () => module });
    const result = await executor.query("SELECT Version, Name FROM dbo.SchemaMigrations");

    expect(result.columns).toEqual(["Version", "Name"]);
    expect(result.rows).toEqual([[1, "initial_schema"]]);
  });

  it("returns an empty result for an empty recordset without metadata (REV-01)", async () => {
    const { module } = createFakeMssqlModule({
      queryResult: { recordset: [] },
    });

    const executor = await createSqlExecutor(CONFIG, { loadModule: async () => module });
    const result = await executor.query("SELECT 1 WHERE 1 = 0");

    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("passes parameters through input() instead of string concatenation", async () => {
    const { module, recorded } = createFakeMssqlModule();

    const executor = await createSqlExecutor(CONFIG, { loadModule: async () => module });
    await executor.query("SELECT @greeting AS Greeting", { greeting: "hello" });

    expect(recorded.queries).toHaveLength(1);
    expect(recorded.queries[0].params).toEqual({ greeting: "hello" });
    expect(recorded.queries[0].typedInputs).toEqual([]);
    expect(recorded.queries[0].viaTransaction).toBe(false);
  });

  it("binds NVARCHAR(MAX) markers with an explicit driver type (REV-01)", async () => {
    const { module, recorded } = createFakeMssqlModule();

    const executor = await createSqlExecutor(CONFIG, { loadModule: async () => module });
    await executor.query("SELECT @script AS Script", { script: nvarcharMax("SELECT 1;") });

    expect(recorded.queries[0].typedInputs).toEqual([
      { name: "script", type: { nVarChar: 65535 }, value: "SELECT 1;" },
    ]);
  });

  it("binds Date parameters as DATETIME2(3) to preserve milliseconds (AC-14)", async () => {
    const { module, recorded } = createFakeMssqlModule();
    const createdAt = new Date("2026-03-04T05:06:07.008Z");

    const executor = await createSqlExecutor(CONFIG, { loadModule: async () => module });
    await executor.query("SELECT @createdAt AS CreatedAt", { createdAt });

    expect(recorded.queries[0].typedInputs).toEqual([
      { name: "createdAt", type: { dateTime2: 3 }, value: createdAt },
    ]);
    // Untyped values still flow through plain input() inference.
    expect(recorded.queries[0].params).toEqual({ createdAt });
  });

  it("returns an empty result when there is no recordset (DDL)", async () => {
    const { module } = createFakeMssqlModule();

    const executor = await createSqlExecutor(CONFIG, { loadModule: async () => module });
    const result = await executor.query("CREATE TABLE dbo.Dummy (Id INT NOT NULL)");

    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("runs statements in one transaction and commits on success", async () => {
    const { module, recorded } = createFakeMssqlModule();

    const executor = await createSqlExecutor(CONFIG, { loadModule: async () => module });
    await executor.transaction([
      { text: "EXEC sys.sp_executesql @script", params: { script: "SELECT 1;" } },
      {
        text: "INSERT INTO dbo.SchemaMigrations (Version) VALUES (@version)",
        params: { version: 1 },
      },
    ]);

    expect(recorded.begins).toBe(1);
    expect(recorded.commits).toBe(1);
    expect(recorded.rollbacks).toBe(0);
    expect(recorded.queries).toHaveLength(2);
    expect(recorded.queries.every((query) => query.viaTransaction)).toBe(true);
    expect(recorded.queries[0].params).toEqual({ script: "SELECT 1;" });
    expect(recorded.queries[1].params).toEqual({ version: 1 });
  });

  it("rolls back and raises an actionable error when a statement fails", async () => {
    const { module, recorded } = createFakeMssqlModule({
      commitError: Object.assign(new Error("statement blew up"), { code: "EREQUEST" }),
    });

    const executor = await createSqlExecutor(CONFIG, { loadModule: async () => module });

    let caught: unknown;
    try {
      await executor.transaction([{ text: "SELECT 1/0;" }]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SqlExecutorError);
    expect(recorded.commits).toBe(1);
    expect(recorded.rollbacks).toBe(1);
  });

  it("maps transaction begin failures", async () => {
    const { module, recorded } = createFakeMssqlModule({
      beginError: Object.assign(new Error("begin failed"), { code: "ETIMEOUT" }),
    });

    const executor = await createSqlExecutor(CONFIG, { loadModule: async () => module });

    await expect(executor.transaction([{ text: "SELECT 1;" }])).rejects.toThrow(SqlExecutorError);
    expect(recorded.begins).toBe(1);
    expect(recorded.commits).toBe(0);
  });

  it("sanitizes connection failures and stays actionable (AC-09)", async () => {
    const { module } = createFakeMssqlModule({
      connectError: Object.assign(
        new Error(`connect failed password=${CONFIG.password} on endpoint`),
        { code: "ECONNREFUSED" },
      ),
    });

    let caught: unknown;
    try {
      await createSqlExecutor(CONFIG, { loadModule: async () => module });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SqlExecutorError);
    const executorError = caught as SqlExecutorError;
    expect(executorError.sanitizedMessage).not.toContain(CONFIG.password);
    expect(executorError.action).toContain("SQL_SERVER_HOST");
    expect(executorError.action).toContain("SQL_SERVER_PORT");
  });

  it("attaches only a sanitized stand-in as cause for connection failures (SEC-01)", async () => {
    const { module } = createFakeMssqlModule({
      connectError: Object.assign(
        new Error(`connect failed password=${CONFIG.password} on endpoint`),
        { code: "ECONNREFUSED" },
      ),
    });

    let caught: unknown;
    try {
      await createSqlExecutor(CONFIG, { loadModule: async () => module });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SqlExecutorError);
    const executorError = caught as SqlExecutorError;
    expect(executorError.cause).toEqual({
      code: "ECONNREFUSED",
      message: "connect failed password=[REDACTED] on endpoint",
    });
    expect(executorError.cause).not.toBeInstanceOf(Error);
    expect(inspect(executorError)).not.toContain(CONFIG.password);
    expect(inspect(executorError.cause)).not.toContain(CONFIG.password);
  });

  it("fails actionably when the module loader fails", async () => {
    let caught: unknown;
    try {
      await createSqlExecutor(CONFIG, {
        loadModule: async () => {
          throw new Error("Cannot find module 'mssql'");
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SqlExecutorError);
    expect((caught as SqlExecutorError).message).toContain("connection failed");
  });

  it("attaches only a sanitized stand-in as cause when the loader fails (SEC-01)", async () => {
    let caught: unknown;
    try {
      await createSqlExecutor(CONFIG, {
        loadModule: async () => {
          throw new Error(`Cannot find module "mssql" password=${CONFIG.password}`);
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SqlExecutorError);
    const loaderError = caught as SqlExecutorError;
    expect(loaderError.cause).toEqual({
      code: "EUNKNOWN",
      message: 'Cannot find module "mssql" password=[REDACTED]',
    });
    expect(loaderError.cause).not.toBeInstanceOf(Error);
    expect(inspect(loaderError)).not.toContain(CONFIG.password);
  });

  it("propagates an already-sanitized SqlExecutorError unchanged", async () => {
    const driverError = new SqlExecutorError({
      code: "DRIVER_UNAVAILABLE",
      message: "SQL Server driver 'mssql' is not available in this environment.",
      action: "Install the maintained driver with `npm install mssql` (spec §8).",
    });

    let caught: unknown;
    try {
      await createSqlExecutor(CONFIG, {
        loadModule: async () => {
          throw driverError;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(driverError);
  });

  it("maps query failures to sanitized executor errors", async () => {
    const { module } = createFakeMssqlModule({
      queryError: Object.assign(new Error(`bad request password=${CONFIG.password}`), {
        code: "EREQUEST",
      }),
    });

    const executor = await createSqlExecutor(CONFIG, { loadModule: async () => module });

    let caught: unknown;
    try {
      await executor.query("SELECT 1;");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SqlExecutorError);
    expect((caught as SqlExecutorError).sanitizedMessage).not.toContain(CONFIG.password);
  });

  it("attaches only a sanitized stand-in as cause for query failures (SEC-01)", async () => {
    const { module } = createFakeMssqlModule({
      queryError: Object.assign(new Error(`bad request password=${CONFIG.password}`), {
        code: "EREQUEST",
      }),
    });

    const executor = await createSqlExecutor(CONFIG, { loadModule: async () => module });

    let caught: unknown;
    try {
      await executor.query("SELECT 1;");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SqlExecutorError);
    const executorError = caught as SqlExecutorError;
    expect(executorError.cause).toEqual({
      code: "EREQUEST",
      message: "bad request password=[REDACTED]",
    });
    expect(executorError.cause).not.toBeInstanceOf(Error);
    expect(inspect(executorError)).not.toContain(CONFIG.password);
  });

  it("closes the pool and maps close failures", async () => {
    const { module, recorded } = createFakeMssqlModule();
    const executor = await createSqlExecutor(CONFIG, { loadModule: async () => module });
    await executor.close();
    expect(recorded.closes).toBe(1);

    const failing = createFakeMssqlModule({ closeError: new Error("close failed") });
    const failingExecutor = await createSqlExecutor(CONFIG, {
      loadModule: async () => failing.module,
    });
    await expect(failingExecutor.close()).rejects.toThrow(SqlExecutorError);
  });
});

describe("migration executor over the driver-shaped executor (REV-01)", () => {
  it("binds the migration script as NVARCHAR(MAX) through the driver request", async () => {
    const { module, recorded } = createFakeMssqlModule();
    const sqlExecutor = await createSqlExecutor(CONFIG, { loadModule: async () => module });
    const migrationExecutor = createSqlMigrationExecutor(sqlExecutor);
    const file: MigrationFile = {
      version: 1,
      name: "initial_schema",
      fileName: "001_initial_schema.sql",
      checksum: "c".repeat(64),
      sql: "CREATE TABLE dbo.Runs (RunId NVARCHAR(64) NOT NULL);",
    };

    await migrationExecutor.applyMigration(file);

    expect(recorded.queries).toHaveLength(2);
    expect(recorded.queries[0].viaTransaction).toBe(true);
    expect(recorded.queries[0].typedInputs).toEqual([
      { name: "script", type: { nVarChar: 65535 }, value: file.sql },
    ]);
    expect(recorded.queries[1].params).toEqual({
      version: 1,
      name: "initial_schema",
      checksum: "c".repeat(64),
    });
  });

  it("reads the migration ledger end-to-end from a driver-shaped result", async () => {
    const appliedAt = new Date("2026-02-03T04:05:06Z");
    const { module } = createFakeMssqlModule({
      queryResult: createDriverResult(
        ["Version", "Name", "Checksum", "AppliedAt"],
        [[1, "initial_schema", "b".repeat(64), appliedAt]],
      ),
    });
    const sqlExecutor = await createSqlExecutor(CONFIG, { loadModule: async () => module });
    const migrationExecutor = createSqlMigrationExecutor(sqlExecutor);

    await migrationExecutor.ensureMigrationsTable();
    const applied = await migrationExecutor.listApplied();

    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual({
      version: 1,
      name: "initial_schema",
      checksum: "b".repeat(64),
      appliedAt,
    });
  });
});

describe("defaultMssqlModuleLoader", () => {
  it("either resolves the maintained driver or fails actionably", async () => {
    let caught: unknown;
    try {
      const module = await defaultMssqlModuleLoader();
      expect(typeof module.ConnectionPool).toBe("function");
      expect(typeof module.Request).toBe("function");
      expect(typeof module.Transaction).toBe("function");
      expect(typeof module.NVarChar).toBe("function");
      expect(typeof module.DateTime2).toBe("function");
      expect(module.MAX).toBe(65535);
    } catch (error) {
      caught = error;
    }

    if (caught !== undefined) {
      expect(caught).toBeInstanceOf(SqlExecutorError);
      const loaderError = caught as SqlExecutorError;
      expect(loaderError.action).toContain("npm install mssql");
      expect(loaderError.action).toContain("PERSISTENCE_PROVIDER=sqlserver");
    }
  }, 30_000); // First import of the real driver (mssql/tedious) can exceed the 5s default.
});
