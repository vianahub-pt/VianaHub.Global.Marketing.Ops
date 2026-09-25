/**
 * Data-only transaction helper (Sprint 5 — AC-37, AC-38).
 *
 * `runInTransaction` accepts a batch of plain statement objects and never
 * callbacks (AC-37): no caller-supplied code can execute while the
 * transaction is open, so platform adapter and transport calls are
 * structurally impossible inside the transaction scope. The optional
 * runtime guard rejects callback-shaped input before the transaction is
 * even opened.
 *
 * Transaction protocol (AC-38): begin, run each statement in list order
 * (one request per statement, named bindings through `request.input`),
 * commit; on any failure roll back and propagate a sanitized, actionable
 * error. A rollback failure never hides the original error (same policy
 * as sql-pool.ts).
 *
 * The driver surface is structural, exactly like sql-pool.ts and
 * index-sql-integration.test.ts: this module never depends on concrete
 * driver typings and never loads the driver itself.
 */

import { mapSqlConnectionError, sanitizedErrorCause } from "./error-mapping.js";
import { SqlExecutorError } from "./sql-pool.js";

// --- Data-only statement contract (AC-37) ------------------------------------

/** One named binding, passed through to `request.input(name, value)`. */
export interface SqlInput {
  readonly name: string;
  readonly value: unknown;
}

/**
 * One data-only statement. The shape structurally excludes callbacks:
 * the helper only reads `sql` and `inputs` and never invokes caller code.
 *
 * Note: distinct from `SqlStatement` in sql-pool.ts (which carries a
 * parameter record). This shape uses an ordered list of named bindings.
 */
export interface SqlStatement {
  readonly sql: string;
  readonly inputs?: readonly SqlInput[];
}

/** The data-only batch executed inside one transaction. */
export type SqlStatementList = readonly SqlStatement[];

function isSqlInput(value: unknown): value is SqlInput {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const name = (value as { readonly name?: unknown }).name;
  return typeof name === "string" && name.length > 0;
}

/**
 * Optional runtime guard for untyped callers (AC-37). Accepts only plain
 * `{ sql, inputs }` objects; functions and other shapes are rejected.
 */
export function isSqlStatement(value: unknown): value is SqlStatement {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { readonly sql?: unknown; readonly inputs?: unknown };
  if (typeof candidate.sql !== "string" || candidate.sql.length === 0) {
    return false;
  }
  if (candidate.inputs === undefined) {
    return true;
  }
  return Array.isArray(candidate.inputs) && candidate.inputs.every(isSqlInput);
}

/** Optional runtime guard for a whole batch (AC-37). */
export function isSqlStatementList(value: unknown): value is SqlStatementList {
  return Array.isArray(value) && value.every(isSqlStatement);
}

// --- Structural driver surface (no concrete driver types) ---------------------

/** One request bound to a transaction: named inputs plus one plain query. */
export interface SqlTransactionRequestLike {
  input(name: string, value: unknown): SqlTransactionRequestLike;
  query(sql: string): Promise<unknown>;
}

/** One transaction scope: begin, per-statement requests, commit or rollback. */
export interface SqlTransactionScopeLike {
  begin(): Promise<void>;
  request(): SqlTransactionRequestLike;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Structural pool surface. A thin wrapper adapts the concrete driver's
 * transaction/request constructors to this shape.
 */
export interface SqlTransactionPoolLike {
  createTransaction(): SqlTransactionScopeLike;
}

// --- Sanitized, actionable errors --------------------------------------------

function mapError(cause: unknown): SqlExecutorError {
  if (cause instanceof SqlExecutorError) {
    return cause;
  }
  return new SqlExecutorError(mapSqlConnectionError(cause), { cause: sanitizedErrorCause(cause) });
}

function invalidStatementError(): SqlExecutorError {
  return new SqlExecutorError({
    code: "EINVALID_STATEMENT",
    message:
      "Transaction statements must be data-only { sql, inputs } objects; callbacks are not accepted (AC-37).",
    action:
      "Build plain SqlStatement objects at the call site; never pass functions into runInTransaction.",
  });
}

// --- Runner ------------------------------------------------------------------

/**
 * Runs the batch atomically (AC-38): begin, execute every statement in
 * order, commit; on any failure roll back and throw the sanitized error.
 *
 * The whole batch is validated as data-only before the transaction is
 * opened (AC-37): invalid or callback-shaped input never starts one.
 *
 * @throws {SqlExecutorError} sanitized and actionable on invalid input,
 *   begin failure, statement failure or commit failure.
 */
export async function runInTransaction(
  pool: SqlTransactionPoolLike,
  statements: SqlStatementList,
): Promise<void> {
  for (const statement of statements) {
    if (!isSqlStatement(statement)) {
      throw invalidStatementError();
    }
  }

  let transaction: SqlTransactionScopeLike;
  try {
    transaction = pool.createTransaction();
    await transaction.begin();
  } catch (cause) {
    throw mapError(cause);
  }

  try {
    for (const statement of statements) {
      const request = transaction.request();
      for (const input of statement.inputs ?? []) {
        request.input(input.name, input.value);
      }
      await request.query(statement.sql);
    }
    await transaction.commit();
  } catch (cause) {
    try {
      await transaction.rollback();
    } catch {
      // Rollback failure leaves a potentially partial state; the caller
      // must treat this as an actionable incident (same policy as
      // sql-pool.ts). The original sanitized error still propagates.
    }
    throw mapError(cause);
  }
}
