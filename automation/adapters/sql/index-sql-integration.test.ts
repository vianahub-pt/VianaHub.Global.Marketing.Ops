/**
 * Env-gated SQL integration skeleton — AC-18 live index verification.
 *
 * The unit battery can only prove *statically* that
 * `UQ_Runs_IdempotencyKey UNIQUE (IdempotencyKey)` exists in
 * database/migrations/001_initial_schema.sql (see sql-run-repo.test.ts —
 * SQL Server creates a unique index for every UNIQUE constraint). Verifying
 * that the engine actually exposes a unique index over
 * `dbo.Runs.IdempotencyKey` through `sys.indexes` / `sys.index_columns`
 * requires a real database, so this file is skipped entirely unless
 * `SQL_INTEGRATION_URL` is set (AC-50): ordinary PR CI has no SQL Server and
 * never opens a connection.
 *
 * The URL must point to a NON-production integration database — never to
 * production opsdb (AC-50 / Seção 19). No credentials live in this file; the
 * connection string comes exclusively from the operator's environment.
 *
 * Scheduled for cycle I-4 (isolated SQL integration tests); committed with
 * the AC-18 correction so the `sys.indexes` check has a designated home.
 */

import { describe, expect, it } from "vitest";

/** Key-1 index columns covering `dbo.Runs.IdempotencyKey` (AC-18). */
const INDEX_ON_IDEMPOTENCY_KEY_SQL = `
  SELECT
    i.name AS IndexName,
    i.is_unique AS IsUnique,
    c.name AS ColumnName
  FROM sys.indexes AS i
  INNER JOIN sys.index_columns AS ic
    ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  INNER JOIN sys.columns AS c
    ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID(N'dbo.Runs')
    AND ic.key_ordinal = 1
    AND c.name = N'IdempotencyKey';
`;

// Structural driver surface — mirrors the lazy, non-literal import pattern of
// sql-pool.ts so this file compiles without driver type declarations.
interface IntegrationRequestLike {
  query(text: string): Promise<{ readonly recordset?: readonly Record<string, unknown>[] }>;
}

interface IntegrationPoolLike {
  request(): IntegrationRequestLike;
  close(): Promise<void>;
}

interface IntegrationDriverModule {
  readonly ConnectionPool: new (connectionString: string) => {
    connect(): Promise<IntegrationPoolLike>;
  };
}

/** Opens a pool against the operator-provided integration endpoint. */
async function connect(): Promise<IntegrationPoolLike> {
  const specifier = "mssql";
  const driver = (await import(specifier)) as unknown as IntegrationDriverModule;
  const pool = new driver.ConnectionPool(process.env.SQL_INTEGRATION_URL ?? "");
  return pool.connect();
}

describe.skipIf(!process.env.SQL_INTEGRATION_URL)(
  "dbo.Runs unique index over IdempotencyKey (AC-18, env-gated)",
  () => {
    it("reports a unique index on dbo.Runs.IdempotencyKey through sys.indexes", async () => {
      const pool = await connect();
      try {
        const result = await pool.request().query(INDEX_ON_IDEMPOTENCY_KEY_SQL);
        const rows = result.recordset ?? [];

        expect(rows.length).toBeGreaterThan(0);
        expect(rows.some((row) => row["IndexName"] === "UQ_Runs_IdempotencyKey")).toBe(true);
        expect(rows.some((row) => row["IsUnique"] === true)).toBe(true);
        expect(rows.every((row) => row["ColumnName"] === "IdempotencyKey")).toBe(true);
      } finally {
        await pool.close();
      }
    });
  },
);
