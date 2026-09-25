/**
 * Versioned migration runner (Sprint 5 — Seções 5, 6 / AC-10..AC-13).
 *
 * Guarantees:
 * - Explicit application only: pending migrations are applied solely
 *   when `apply: true` is passed deliberately (AC-13 — ordinary PR CI
 *   never migrates production because the flag is never set there).
 * - Deterministic ordering, checksums and contiguous version sequence.
 * - Successful applications are recorded in `dbo.SchemaMigrations`
 *   inside the same transaction as the script (AC-11).
 * - Reapplying an already-recorded migration is a safe no-op (AC-12).
 * - A recorded migration whose file changed never runs again silently:
 *   checksum mismatch fails loudly and requires a human (Seção 6).
 * - Partial/incompatible recorded state fails loudly (Seção 6).
 * - Scripts run parameterized through `sp_executesql`; no credentials
 *   ever appear in scripts or errors (AC-60).
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { sanitizedErrorCause } from "./error-mapping.js";
import { nvarcharMax, type SqlExecutor } from "./sql-pool.js";

// --- Types ---------------------------------------------------------------------

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

/**
 * Executor boundary used by the runner. The SQL implementation runs
 * each migration and its ledger insert in one bounded transaction.
 */
export interface MigrationExecutor {
  ensureMigrationsTable(): Promise<void>;
  listApplied(): Promise<readonly AppliedMigration[]>;
  applyMigration(file: MigrationFile): Promise<void>;
}

export interface RunMigrationsOptions {
  readonly executor: MigrationExecutor;
  readonly migrationsDir: string;
  /** Explicit approval flag — absent/false never applies anything. */
  readonly apply?: boolean;
}

export interface MigrationRunSummary {
  readonly applied: readonly number[];
  readonly skipped: readonly number[];
  readonly pending: readonly number[];
}

// --- Errors --------------------------------------------------------------------

/** Base class for actionable migration failures. */
export class MigrationError extends Error {
  readonly action: string;

  constructor(message: string, action: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationError";
    this.action = action;
  }
}

export class MigrationDirectoryError extends MigrationError {}

export class MigrationChecksumMismatchError extends MigrationError {
  readonly version: number;

  constructor(message: string, action: string, version: number) {
    super(message, action);
    this.name = "MigrationChecksumMismatchError";
    this.version = version;
  }
}

export class MigrationStateError extends MigrationError {}

export class MigrationApprovalRequiredError extends MigrationError {
  readonly pendingVersions: readonly number[];

  constructor(message: string, action: string, pendingVersions: readonly number[]) {
    super(message, action);
    this.name = "MigrationApprovalRequiredError";
    this.pendingVersions = pendingVersions;
  }
}

export class MigrationExecutionError extends MigrationError {
  readonly version: number;
  readonly appliedBeforeFailure: readonly number[];

  constructor(params: {
    readonly message: string;
    readonly action: string;
    readonly version: number;
    readonly appliedBeforeFailure: readonly number[];
    readonly cause?: unknown;
  }) {
    // SEC-01: the underlying error is never attached raw — only the
    // sanitized `{ code, message }` stand-in reaches `Error.cause`.
    super(
      params.message,
      params.action,
      params.cause !== undefined ? { cause: sanitizedErrorCause(params.cause) } : undefined,
    );
    this.name = "MigrationExecutionError";
    this.version = params.version;
    this.appliedBeforeFailure = params.appliedBeforeFailure;
  }
}

// --- Discovery -----------------------------------------------------------------

const MIGRATION_FILE_PATTERN = /^(\d{3,})_([a-z0-9][a-z0-9_-]*)\.sql$/;

/**
 * Deterministic content checksum: line endings are normalized so the
 * same logical file yields the same checksum across platforms.
 */
export function computeMigrationChecksum(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Loads and validates all migration files in a directory.
 *
 * @throws {MigrationDirectoryError} on missing directory, malformed
 *   file names, duplicate versions, or gaps in the 1..N sequence.
 */
export async function loadMigrations(migrationsDir: string): Promise<readonly MigrationFile[]> {
  let realDir: string;
  try {
    realDir = realpathSync(migrationsDir);
  } catch (cause) {
    throw new MigrationDirectoryError(
      `Migrations directory not found: ${migrationsDir}`,
      "Point migrationsDir at database/migrations (see database/README.md).",
      // SEC-01: attach only the sanitized stand-in, never the raw fs error.
      { cause: sanitizedErrorCause(cause) },
    );
  }

  const entries = await readdir(realDir, { withFileTypes: true });
  const sqlFileNames = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  const malformed = sqlFileNames.filter((fileName) => !MIGRATION_FILE_PATTERN.test(fileName));
  if (malformed.length > 0) {
    throw new MigrationDirectoryError(
      `Malformed migration file name(s): ${malformed.join(", ")}. Expected NNN_name.sql.`,
      "Rename the file to NNN_name.sql with a contiguous 1-based version (e.g. 001_initial_schema.sql).",
    );
  }

  const migrations: MigrationFile[] = [];
  const seenVersions = new Set<number>();

  for (const fileName of sqlFileNames) {
    const match = MIGRATION_FILE_PATTERN.exec(fileName);
    if (match === null) {
      continue;
    }
    const version = Number.parseInt(match[1], 10);
    if (seenVersions.has(version)) {
      throw new MigrationDirectoryError(
        `Duplicate migration version ${version} (${fileName}).`,
        "Migration versions must be unique; fix the file names before applying anything.",
      );
    }
    seenVersions.add(version);

    const sql = await readFile(join(realDir, fileName), "utf8");
    migrations.push({
      version,
      name: match[2],
      fileName,
      checksum: computeMigrationChecksum(sql),
      sql,
    });
  }

  migrations.sort((left, right) => left.version - right.version);

  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new MigrationDirectoryError(
        `Migration sequence gap: expected version ${expected}, found ${migration.version} (${migration.fileName}).`,
        "Keep migration versions contiguous and 1-based; add the missing version instead of renumbering applied migrations.",
      );
    }
  });

  return migrations;
}

// --- Runner --------------------------------------------------------------------

function assertContiguousPrefix(appliedVersions: readonly number[]): void {
  const sorted = [...appliedVersions].sort((left, right) => left - right);
  sorted.forEach((version, index) => {
    const expected = index + 1;
    if (version !== expected) {
      throw new MigrationStateError(
        `Partial or incompatible migration state: recorded versions [${sorted.join(", ")}] are not a contiguous 1..N prefix (expected ${expected} at position ${index + 1}).`,
        "Do not auto-remediate. Review dbo.SchemaMigrations and the deployed objects, then reconcile manually per database/README.md before retrying.",
      );
    }
  });
}

/**
 * Discovers, validates and (only with explicit approval) applies
 * pending migrations.
 *
 * @throws {MigrationApprovalRequiredError} when migrations are pending
 *   and `apply` was not explicitly set to true.
 * @throws {MigrationChecksumMismatchError} when an applied migration's
 *   file was rewritten.
 * @throws {MigrationStateError} for recorded state that is partial,
 *   duplicated, or references missing files.
 * @throws {MigrationExecutionError} when a script fails; nothing after
 *   the failing version is attempted.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationRunSummary> {
  const { executor, migrationsDir } = options;
  const apply = options.apply === true;

  const files = await loadMigrations(migrationsDir);

  await executor.ensureMigrationsTable();
  const applied = await executor.listApplied();

  const appliedByVersion = new Map<number, AppliedMigration>();
  for (const record of applied) {
    if (appliedByVersion.has(record.version)) {
      throw new MigrationStateError(
        `Duplicate ledger entry for migration version ${record.version}.`,
        "Reconcile dbo.SchemaMigrations manually; the ledger must contain each version at most once.",
      );
    }
    appliedByVersion.set(record.version, record);
  }

  const filesByVersion = new Map<number, MigrationFile>(
    files.map((file) => [file.version, file] as const),
  );

  for (const record of applied) {
    const file = filesByVersion.get(record.version);
    if (file === undefined) {
      throw new MigrationStateError(
        `Applied migration ${record.version} (${record.name}) has no corresponding file in the migrations directory.`,
        "Restore the missing migration file or reconcile dbo.SchemaMigrations manually; applied migrations are never silently discarded.",
      );
    }
    if (file.checksum !== record.checksum) {
      throw new MigrationChecksumMismatchError(
        `Migration ${record.version} (${file.fileName}) was already applied with a different checksum.`,
        "Applied migrations are immutable: never rewrite them. Restore the original file or author a new forward migration, then reconcile with a human review.",
        record.version,
      );
    }
  }

  assertContiguousPrefix([...appliedByVersion.keys()]);

  const pending = files.filter((file) => !appliedByVersion.has(file.version));
  const skipped = files
    .filter((file) => appliedByVersion.has(file.version))
    .map((file) => file.version);

  if (pending.length === 0) {
    return { applied: [], skipped, pending: [] };
  }

  if (!apply) {
    const pendingVersions = pending.map((file) => file.version);
    throw new MigrationApprovalRequiredError(
      `Pending migration(s) require explicit approval: ${pendingVersions.join(", ")}.`,
      "Re-run with apply=true as part of a human-controlled deployment to opsdb. Ordinary PR CI must never migrate production.",
      pendingVersions,
    );
  }

  const appliedNow: number[] = [];

  for (const file of pending) {
    try {
      await executor.applyMigration(file);
    } catch (cause) {
      throw new MigrationExecutionError({
        message: `Migration ${file.version} (${file.fileName}) failed; recorded versions before the failure: [${appliedNow.join(", ")}].`,
        action: `Investigate version ${file.version} first: the transaction rolled back, so this version is NOT recorded. Do not delete data automatically; reconcile manually per database/README.md, then re-run with apply=true.`,
        version: file.version,
        appliedBeforeFailure: appliedNow,
        cause,
      });
    }
    appliedNow.push(file.version);
  }

  return { applied: appliedNow, skipped, pending: [] };
}

// --- SQL implementation ----------------------------------------------------------

const CREATE_SCHEMA_MIGRATIONS_SQL = `
IF OBJECT_ID(N'dbo.SchemaMigrations', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.SchemaMigrations (
    Id INT IDENTITY(1, 1) NOT NULL,
    Version INT NOT NULL,
    Name NVARCHAR(200) NOT NULL,
    Checksum NVARCHAR(64) NOT NULL,
    AppliedAt DATETIME2(3) NOT NULL
      CONSTRAINT DF_SchemaMigrations_AppliedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_SchemaMigrations PRIMARY KEY CLUSTERED (Id),
    CONSTRAINT UQ_SchemaMigrations_Version UNIQUE (Version),
    CONSTRAINT CK_SchemaMigrations_Checksum CHECK (LEN(Checksum) = 64)
  );
END
`;

const SELECT_APPLIED_SQL =
  "SELECT Version, Name, Checksum, AppliedAt FROM dbo.SchemaMigrations ORDER BY Version ASC";

const APPLY_SCRIPT_SQL = "EXEC sys.sp_executesql @script";

const RECORD_APPLIED_SQL =
  "INSERT INTO dbo.SchemaMigrations (Version, Name, Checksum) VALUES (@version, @name, @checksum)";

/**
 * Prepares the migration for execution.
 *
 * `requiredColumnIndex` reads the injectable `SqlQueryResult` produced by
 * `sql-pool.ts`, which already normalizes the driver's default object-row
 * shape into positional rows (REV-01) — so the indexes below are stable.
 */
function requiredColumnIndex(columns: readonly string[], name: string): number {
  const index = columns.indexOf(name);
  if (index < 0) {
    throw new MigrationStateError(
      `Unexpected query result: column "${name}" is missing from the migration ledger query.`,
      "Verify dbo.SchemaMigrations matches database/migrations/001_initial_schema.sql and that the connection targets opsdb.",
    );
  }
  return index;
}

/**
 * Adapts the injectable `SqlExecutor` to the runner boundary.
 * Each migration and its ledger insert share one bounded transaction:
 * success is recorded atomically; failure rolls back (AC-11, AC-12).
 */
export function createSqlMigrationExecutor(executor: SqlExecutor): MigrationExecutor {
  return {
    async ensureMigrationsTable(): Promise<void> {
      await executor.query(CREATE_SCHEMA_MIGRATIONS_SQL);
    },

    async listApplied(): Promise<readonly AppliedMigration[]> {
      const result = await executor.query(SELECT_APPLIED_SQL);
      const versionIndex = requiredColumnIndex(result.columns, "Version");
      const nameIndex = requiredColumnIndex(result.columns, "Name");
      const checksumIndex = requiredColumnIndex(result.columns, "Checksum");
      const appliedAtIndex = requiredColumnIndex(result.columns, "AppliedAt");

      return result.rows.map((row) => {
        const rawAppliedAt = row[appliedAtIndex];
        return {
          version: Number(row[versionIndex]),
          name: String(row[nameIndex]),
          checksum: String(row[checksumIndex]),
          appliedAt: rawAppliedAt instanceof Date ? rawAppliedAt : new Date(String(rawAppliedAt)),
        };
      });
    },

    async applyMigration(file: MigrationFile): Promise<void> {
      await executor.transaction([
        // REV-01: the script is bound explicitly as NVARCHAR(MAX) —
        // never through the driver's implicit string-type inference.
        { text: APPLY_SCRIPT_SQL, params: { script: nvarcharMax(file.sql) } },
        {
          text: RECORD_APPLIED_SQL,
          params: { version: file.version, name: file.name, checksum: file.checksum },
        },
      ]);
    },
  };
}
