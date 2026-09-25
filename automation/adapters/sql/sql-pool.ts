/**
 * Minimal SQL Server pool infrastructure (Sprint 5 — Seção 14, Seção 8).
 *
 * The driver (`mssql` / tedious — no ORM) sits behind an injectable
 * interface (`SqlExecutor`), so domain-facing adapters and tests never
 * depend on the concrete driver. TLS/encryption behavior is explicit:
 * `encrypt: true`, `trustServerCertificate: false` (Seção 7).
 *
 * The module is loaded lazily: environments that only use
 * `PERSISTENCE_PROVIDER=filesystem` (the default) never require the
 * driver to be installed.
 */

import {
  mapSqlConnectionError,
  sanitizedErrorCause,
  type SanitizedSqlError,
} from "./error-mapping.js";
import type { SqlServerConfig } from "./sql-config.js";

// --- Injectable interface -----------------------------------------------------

/** A single parameterized statement. Never concatenate untrusted input. */
export interface SqlStatement {
  readonly text: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * Marker: bind this string parameter explicitly as NVARCHAR(MAX).
 * Scripts can exceed 4000 characters, so the migration runner never
 * relies on the driver's implicit string-type inference (REV-01).
 */
export interface SqlNVarCharMax {
  readonly type: "NVarCharMax";
  readonly value: string;
}

/** Wraps a string so `applyParams` binds it as `NVarChar(MAX)`. */
export function nvarcharMax(value: string): SqlNVarCharMax {
  return { type: "NVarCharMax", value };
}

function isSqlNVarCharMax(value: unknown): value is SqlNVarCharMax {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { readonly type?: unknown; readonly value?: unknown };
  return candidate.type === "NVarCharMax" && typeof candidate.value === "string";
}

/** Result of a query: column names plus positional rows. */
export interface SqlQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly unknown[][];
}

/**
 * Injectable pool-backed executor. Repository adapters and the
 * migration runner depend only on this interface.
 */
export interface SqlExecutor {
  query(text: string, params?: Readonly<Record<string, unknown>>): Promise<SqlQueryResult>;
  /** Runs statements inside one bounded transaction; rolls back on failure. */
  transaction(statements: readonly SqlStatement[]): Promise<void>;
  close(): Promise<void>;
}

/** Connection options with explicit, fail-closed TLS behavior. */
export interface MssqlConnectOptions {
  readonly server: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly options: {
    readonly encrypt: true;
    readonly trustServerCertificate: false;
  };
}

/** Maps validated config to driver options with explicit TLS settings. */
export function toMssqlConnectOptions(config: SqlServerConfig): MssqlConnectOptions {
  return {
    server: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
  };
}

// --- Actionable executor error -------------------------------------------------

/** Connection/execution failure with a sanitized message and an action. */
export class SqlExecutorError extends Error {
  readonly code: string;
  readonly sanitizedMessage: string;
  readonly action: string;

  constructor(mapped: SanitizedSqlError, options?: ErrorOptions) {
    super(mapped.message, options);
    this.name = "SqlExecutorError";
    this.code = mapped.code;
    this.sanitizedMessage = mapped.message;
    this.action = mapped.action;
  }
}

// --- Driver surface (structural, resolved lazily) ------------------------------

/**
 * First recordset of a driver result in DEFAULT row mode: an array of
 * row objects with column metadata attached as a non-enumerable
 * `columns` property. `arrayRowMode` is never enabled, so the
 * top-level `result.columns` reported by the driver does not exist
 * here (REV-01).
 */
export interface MssqlRecordsetLike extends ReadonlyArray<Readonly<Record<string, unknown>>> {
  readonly columns?: Readonly<Record<string, unknown>>;
}

export interface MssqlQueryLike {
  readonly recordset?: MssqlRecordsetLike;
}

interface MssqlRequestLike {
  input(name: string, value: unknown): MssqlRequestLike;
  input(name: string, type: unknown, value: unknown): MssqlRequestLike;
  query(text: string): Promise<MssqlQueryLike>;
}

interface MssqlPoolLike {
  request(): MssqlRequestLike;
  close(): Promise<void>;
}

interface MssqlTransactionLike {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

interface MssqlConnectionPoolLike {
  connect(): Promise<MssqlPoolLike>;
}

export interface MssqlModuleLike {
  readonly ConnectionPool: new (options: MssqlConnectOptions) => MssqlConnectionPoolLike;
  readonly Request: new (parent: MssqlPoolLike | MssqlTransactionLike) => MssqlRequestLike;
  readonly Transaction: new (pool: MssqlPoolLike) => MssqlTransactionLike;
  /** Driver type factory used to bind NVARCHAR(MAX) explicitly (REV-01). */
  readonly NVarChar: (length: number) => unknown;
  /** Driver type factory used to bind DATETIME2(3) explicitly (AC-14). */
  readonly DateTime2: (scale: number) => unknown;
  /** Driver MAX sentinel (65535) passed to `NVarChar`. */
  readonly MAX: number;
}

export type MssqlModuleLoader = () => Promise<MssqlModuleLike>;

const DRIVER_NAME = "mssql";

/**
 * Lazily loads the maintained `mssql` driver. Uses a non-literal
 * specifier so this module compiles even before the dependency is
 * installed; a missing driver fails closed with an actionable error.
 */
export const defaultMssqlModuleLoader: MssqlModuleLoader = async (): Promise<MssqlModuleLike> => {
  const specifier = DRIVER_NAME;
  try {
    return (await import(specifier)) as MssqlModuleLike;
  } catch (cause) {
    throw new SqlExecutorError(
      {
        code: "DRIVER_UNAVAILABLE",
        message: "SQL Server driver 'mssql' is not available in this environment.",
        action:
          "Install the maintained driver with `npm install mssql` (spec §8) before enabling PERSISTENCE_PROVIDER=sqlserver.",
      },
      { cause: sanitizedErrorCause(cause) },
    );
  }
};

// --- Construction ---------------------------------------------------------------

export interface CreateSqlExecutorOptions {
  readonly loadModule?: MssqlModuleLoader;
}

function mapError(cause: unknown): SqlExecutorError {
  if (cause instanceof SqlExecutorError) {
    return cause;
  }
  return new SqlExecutorError(mapSqlConnectionError(cause), { cause: sanitizedErrorCause(cause) });
}

function applyParams(
  module: MssqlModuleLike,
  request: MssqlRequestLike,
  params?: Readonly<Record<string, unknown>>,
): void {
  if (params === undefined) {
    return;
  }
  for (const [name, value] of Object.entries(params)) {
    if (isSqlNVarCharMax(value)) {
      request.input(name, module.NVarChar(module.MAX), value.value);
    } else if (value instanceof Date) {
      // DATETIME2(3) columns: the driver's inferred type for Date is
      // DateTime (scale 0, ~3.33ms steps), which would silently lose
      // millisecond precision — bind DateTime2(3) explicitly instead.
      request.input(name, module.DateTime2(3), value);
    } else {
      request.input(name, value);
    }
  }
}

/**
 * Normalizes the driver's DEFAULT-mode result into the injectable
 * `SqlQueryResult` (column names + positional rows). Column order comes
 * from the non-enumerable `recordset.columns` metadata; DDL statements
 * (no recordset) yield an empty result (REV-01).
 */
function toQueryResult(result: MssqlQueryLike): SqlQueryResult {
  const recordset = result.recordset;
  if (recordset === undefined) {
    return { columns: [], rows: [] };
  }
  const metadata = recordset.columns;
  const columns =
    metadata !== undefined
      ? Object.keys(metadata)
      : recordset.length > 0
        ? Object.keys(recordset[0])
        : [];
  const rows = recordset.map((row) => columns.map((name) => row[name]));
  return { columns, rows };
}

/**
 * Creates a pool-backed executor for the validated configuration.
 *
 * @throws {SqlExecutorError} sanitized and actionable on driver
 *   load failure or connection failure (AC-09).
 */
export async function createSqlExecutor(
  config: SqlServerConfig,
  options?: CreateSqlExecutorOptions,
): Promise<SqlExecutor> {
  const loadModule = options?.loadModule ?? defaultMssqlModuleLoader;

  let module: MssqlModuleLike;
  try {
    module = await loadModule();
  } catch (cause) {
    throw mapError(cause);
  }

  let pool: MssqlPoolLike;
  try {
    const poolWrapper = new module.ConnectionPool(toMssqlConnectOptions(config));
    pool = await poolWrapper.connect();
  } catch (cause) {
    throw mapError(cause);
  }

  return {
    async query(text: string, params?: Readonly<Record<string, unknown>>): Promise<SqlQueryResult> {
      try {
        const request = pool.request();
        applyParams(module, request, params);
        const result = await request.query(text);
        return toQueryResult(result);
      } catch (cause) {
        throw mapError(cause);
      }
    },

    async transaction(statements: readonly SqlStatement[]): Promise<void> {
      let transaction: MssqlTransactionLike;
      try {
        transaction = new module.Transaction(pool);
        await transaction.begin();
      } catch (cause) {
        throw mapError(cause);
      }

      try {
        for (const statement of statements) {
          const request = new module.Request(transaction);
          applyParams(module, request, statement.params);
          await request.query(statement.text);
        }
        await transaction.commit();
      } catch (cause) {
        try {
          await transaction.rollback();
        } catch {
          // Rollback failure leaves a potentially partial state; the
          // caller must treat this as an actionable incident.
        }
        throw mapError(cause);
      }
    },

    async close(): Promise<void> {
      try {
        await pool.close();
      } catch (cause) {
        throw mapError(cause);
      }
    },
  };
}
