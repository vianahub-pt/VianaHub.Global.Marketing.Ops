/**
 * Unit battery for the data-only transaction helper (AC-37, AC-38).
 *
 * The fake pool/request harnesses are inline: the helper is exercised
 * purely against its structural driver surface — no live connection, no
 * concrete driver dependency.
 *
 * The static sweep (AC-37) reads sql-transaction.ts and proves it stays
 * free of platform adapter/transport imports and HTTP call literals, so
 * nothing external can run while a transaction is open.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SqlExecutorError } from "./sql-pool.js";
import {
  isSqlStatement,
  isSqlStatementList,
  runInTransaction,
  type SqlInput,
  type SqlStatement,
  type SqlTransactionPoolLike,
  type SqlTransactionRequestLike,
  type SqlTransactionScopeLike,
} from "./sql-transaction.js";

// ─── Fake pool harness (inline) ─────────────────────────────────────────────

interface FakeQueryRecord {
  readonly sql: string;
  readonly inputs: Readonly<Record<string, unknown>>;
}

interface FakeState {
  readonly log: string[];
  readonly queries: FakeQueryRecord[];
  begins: number;
  commits: number;
  rollbacks: number;
}

interface FakePoolOptions {
  /** 1-based ordinal of the query that throws `queryError`. */
  readonly failOnQuery?: number;
  readonly queryError?: unknown;
  readonly beginError?: unknown;
  readonly rollbackError?: unknown;
}

function createFakePool(options: FakePoolOptions = {}): {
  readonly pool: SqlTransactionPoolLike;
  readonly fake: FakeState;
} {
  const fake: FakeState = { log: [], queries: [], begins: 0, commits: 0, rollbacks: 0 };

  function createRequest(): SqlTransactionRequestLike {
    const inputs: Record<string, unknown> = {};
    const request: SqlTransactionRequestLike = {
      input(name: string, value: unknown): SqlTransactionRequestLike {
        inputs[name] = value;
        fake.log.push("input:" + name);
        return request;
      },
      query(sql: string): Promise<unknown> {
        fake.queries.push({ sql, inputs: { ...inputs } });
        fake.log.push("query:" + sql);
        if (options.failOnQuery !== undefined && options.failOnQuery === fake.queries.length) {
          return Promise.reject(options.queryError ?? new Error("injected query failure"));
        }
        return Promise.resolve({});
      },
    };
    return request;
  }

  const pool: SqlTransactionPoolLike = {
    createTransaction(): SqlTransactionScopeLike {
      return {
        async begin(): Promise<void> {
          fake.begins += 1;
          fake.log.push("begin");
          if (options.beginError !== undefined) {
            throw options.beginError;
          }
        },
        request: createRequest,
        async commit(): Promise<void> {
          fake.commits += 1;
          fake.log.push("commit");
        },
        async rollback(): Promise<void> {
          fake.rollbacks += 1;
          fake.log.push("rollback");
          if (options.rollbackError !== undefined) {
            throw options.rollbackError;
          }
        },
      };
    },
  };

  return { pool, fake };
}

// ─── Static sweep patterns (AC-37) ──────────────────────────────────────────

const SOURCE = readFileSync(fileURLToPath(new URL("sql-transaction.ts", import.meta.url)), "utf8");

const SPECIFIER_PATTERN = /(?:from\s+|import\(|require\()\s*["']([^"']+)["']/g;

/** Specifiers that leave automation/adapters/sql/ or load the concrete driver. */
const FORBIDDEN_SPECIFIER =
  /(?:\.\.|^automation\/|mssql|tedious|platform|transport|gbp|adapter-context|fake-adapter)/i;

/** Literals that would issue an external HTTP-family call. */
const HTTP_CALL_PATTERN =
  /\bfetch\s*\(|\bXMLHttpRequest\b|\baxios\b|\bWebSocket\b|\bEventSource\b|https?:\/\/|\bhttps?\.(?:request|get)\b/;

function importViolations(source: string): readonly string[] {
  const violations: string[] = [];
  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? "";
    if (FORBIDDEN_SPECIFIER.test(specifier)) {
      violations.push(`import of "${specifier}"`);
    }
  }
  return violations;
}

// ─── AC-38: rollback prevents partial writes ────────────────────────────────

describe("runInTransaction — atomic execution (AC-38)", () => {
  it("runs every statement in order and commits exactly once", async () => {
    const { pool, fake } = createFakePool();

    await runInTransaction(pool, [
      { sql: "update-one" },
      { sql: "update-two", inputs: [{ name: "state", value: "succeeded" }] },
      { sql: "insert-three", inputs: [{ name: "attempt", value: 2 }] },
    ]);

    expect(fake.begins).toBe(1);
    expect(fake.commits).toBe(1);
    expect(fake.rollbacks).toBe(0);
    expect(fake.queries.map((entry) => entry.sql)).toEqual([
      "update-one",
      "update-two",
      "insert-three",
    ]);
    expect(fake.log[0]).toBe("begin");
    expect(fake.log[fake.log.length - 1]).toBe("commit");
  });

  it("rolls back, never commits and propagates when the second of three statements fails", async () => {
    const rawError = Object.assign(new Error("constraint violation password=S3cret-Not-Logged"), {
      code: "EREQUEST",
    });
    const { pool, fake } = createFakePool({ failOnQuery: 2, queryError: rawError });

    let caught: unknown;
    try {
      await runInTransaction(pool, [
        { sql: "update-one" },
        { sql: "update-two" },
        { sql: "insert-three" },
      ]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SqlExecutorError);
    expect(fake.rollbacks).toBe(1);
    expect(fake.commits).toBe(0);
    // The third statement never runs, so no partial write can escape.
    expect(fake.queries.map((entry) => entry.sql)).toEqual(["update-one", "update-two"]);
  });

  it("propagates a sanitized, actionable error with only a redacted cause (SEC-01)", async () => {
    const rawError = Object.assign(new Error("constraint violation password=S3cret-Not-Logged"), {
      code: "EREQUEST",
    });
    const { pool } = createFakePool({ failOnQuery: 2, queryError: rawError });

    let caught: unknown;
    try {
      await runInTransaction(pool, [{ sql: "update-one" }, { sql: "update-two" }]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SqlExecutorError);
    const executorError = caught as SqlExecutorError;
    expect(executorError.sanitizedMessage).not.toContain("S3cret-Not-Logged");
    expect(executorError.action.length).toBeGreaterThan(0);
    expect(executorError.cause).toEqual({
      code: "EREQUEST",
      message: "constraint violation password=[REDACTED]",
    });
  });

  it("propagates an already-sanitized SqlExecutorError unchanged", async () => {
    const driverError = new SqlExecutorError({
      code: "EREQUEST",
      message: "already sanitized",
      action: "Inspect the sanitized message.",
    });
    const { pool, fake } = createFakePool({ failOnQuery: 1, queryError: driverError });

    let caught: unknown;
    try {
      await runInTransaction(pool, [{ sql: "update-one" }]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(driverError);
    expect(fake.rollbacks).toBe(1);
    expect(fake.commits).toBe(0);
  });

  it("still propagates the original error when the rollback itself fails", async () => {
    const rawError = Object.assign(new Error("statement failed"), { code: "EREQUEST" });
    const { pool, fake } = createFakePool({
      failOnQuery: 2,
      queryError: rawError,
      rollbackError: new Error("rollback failed"),
    });

    let caught: unknown;
    try {
      await runInTransaction(pool, [{ sql: "update-one" }, { sql: "update-two" }]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SqlExecutorError);
    expect((caught as SqlExecutorError).sanitizedMessage).toContain("statement failed");
    expect(fake.rollbacks).toBe(1);
    expect(fake.commits).toBe(0);
  });

  it("maps begin failures without committing or rolling back", async () => {
    const beginError = Object.assign(new Error("begin timed out"), { code: "ETIMEOUT" });
    const { pool, fake } = createFakePool({ beginError });

    await expect(runInTransaction(pool, [{ sql: "update-one" }])).rejects.toThrow(SqlExecutorError);
    expect(fake.begins).toBe(1);
    expect(fake.commits).toBe(0);
    expect(fake.rollbacks).toBe(0);
    expect(fake.queries).toEqual([]);
  });
});

// ─── AC-37: data-only API, never callbacks ──────────────────────────────────

describe("runInTransaction — data-only contract (AC-37)", () => {
  it("binds each named input through request.input before its statement", async () => {
    const { pool, fake } = createFakePool();
    const inputs: readonly SqlInput[] = [
      { name: "runId", value: "run-1" },
      { name: "attempt", value: 3 },
    ];

    await runInTransaction(pool, [{ sql: "update-one", inputs }]);

    expect(fake.log).toEqual([
      "begin",
      "input:runId",
      "input:attempt",
      "query:update-one",
      "commit",
    ]);
    expect(fake.queries[0].inputs).toEqual({ runId: "run-1", attempt: 3 });
  });

  it("never opens a transaction for callback-shaped input", async () => {
    const { pool, fake } = createFakePool();
    const callbackStatement = { sql: () => Promise.resolve() } as unknown as SqlStatement;
    const callbackBatch = [() => Promise.resolve()] as unknown as readonly SqlStatement[];

    await expect(runInTransaction(pool, [callbackStatement])).rejects.toThrow(SqlExecutorError);
    await expect(runInTransaction(pool, callbackBatch)).rejects.toThrow(SqlExecutorError);

    expect(fake.begins).toBe(0);
    expect(fake.queries).toEqual([]);
    expect(fake.log).toEqual([]);
  });
});

describe("isSqlStatement / isSqlStatementList (AC-37)", () => {
  it("accepts data-only statements and rejects callback-shaped values", () => {
    expect(isSqlStatement({ sql: "update-one" })).toBe(true);
    expect(isSqlStatement({ sql: "update-one", inputs: [{ name: "id", value: 1 }] })).toBe(true);
    expect(isSqlStatement({ sql: "update-one", inputs: [] })).toBe(true);

    expect(isSqlStatement(() => undefined)).toBe(false);
    expect(isSqlStatement(null)).toBe(false);
    expect(isSqlStatement("update-one")).toBe(false);
    expect(isSqlStatement({ sql: 7 })).toBe(false);
    expect(isSqlStatement({ sql: "" })).toBe(false);
    expect(isSqlStatement({ sql: "update-one", inputs: "nope" })).toBe(false);
    expect(isSqlStatement({ sql: "update-one", inputs: [{ name: "", value: 1 }] })).toBe(false);
    expect(isSqlStatement({ sql: "update-one", inputs: [7] })).toBe(false);
    expect(isSqlStatement({ sql: "update-one", inputs: [{ value: 1 }] })).toBe(false);
  });

  it("accepts whole data-only batches and rejects mixed ones", () => {
    expect(isSqlStatementList([])).toBe(true);
    expect(isSqlStatementList([{ sql: "update-one" }, { sql: "update-two" }])).toBe(true);

    expect(isSqlStatementList("update-one")).toBe(false);
    expect(isSqlStatementList(undefined)).toBe(false);
    expect(isSqlStatementList([{ sql: "update-one" }, () => undefined])).toBe(false);
    expect(isSqlStatementList([{ sql: "" }])).toBe(false);
  });
});

// ─── AC-37: static sweep — no adapter/transport imports, no HTTP calls ──────

describe("static sweep of sql-transaction.ts (AC-37)", () => {
  it("self-checks the detection patterns against synthetic fixtures", () => {
    const fixture = 'import { runInTransaction } from "./sql-transaction.js";';
    expect(fixture.match(new RegExp(SPECIFIER_PATTERN.source))?.[1]).toBe("./sql-transaction.js");

    expect(FORBIDDEN_SPECIFIER.test("./error-mapping.js")).toBe(false);
    expect(FORBIDDEN_SPECIFIER.test("./sql-pool.js")).toBe(false);
    expect(FORBIDDEN_SPECIFIER.test("../platform-adapter.js")).toBe(true);
    expect(FORBIDDEN_SPECIFIER.test("../gbp-http-transport.js")).toBe(true);
    expect(FORBIDDEN_SPECIFIER.test("automation/adapters/gbp-http-transport.js")).toBe(true);
    expect(FORBIDDEN_SPECIFIER.test("mssql")).toBe(true);

    expect('fetch("/v1/items")'.match(HTTP_CALL_PATTERN)).not.toBeNull();
    expect("new XMLHttpRequest()".match(HTTP_CALL_PATTERN)).not.toBeNull();
    expect("axios.get(url)".match(HTTP_CALL_PATTERN)).not.toBeNull();
    expect("new WebSocket(url)".match(HTTP_CALL_PATTERN)).not.toBeNull();
    expect("new EventSource(url)".match(HTTP_CALL_PATTERN)).not.toBeNull();
    expect("https://api.example.test/v1".match(HTTP_CALL_PATTERN)).not.toBeNull();
    expect("http.request(options)".match(HTTP_CALL_PATTERN)).not.toBeNull();
    expect("https.request(options)".match(HTTP_CALL_PATTERN)).not.toBeNull();
    expect("request.query(statement.sql)".match(HTTP_CALL_PATTERN)).toBeNull();
    expect("transaction.commit()".match(HTTP_CALL_PATTERN)).toBeNull();
  });

  it("imports nothing from the platform adapter/transport layer", () => {
    expect(importViolations(SOURCE)).toEqual([]);
  });

  it("contains no HTTP call literals", () => {
    expect(SOURCE.match(HTTP_CALL_PATTERN)).toBeNull();
  });
});
