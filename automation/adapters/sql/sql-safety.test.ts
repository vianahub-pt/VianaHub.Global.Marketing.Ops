import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// ─── Scope: non-test SQL adapter artifacts (the fake is exercised directly) ─

const SQL_DIR = fileURLToPath(new URL(".", import.meta.url));

function scannedFiles(): readonly { readonly name: string; readonly source: string }[] {
  return readdirSync(SQL_DIR)
    .filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.startsWith("fake-"),
    )
    .sort()
    .map((name) => ({
      name,
      source: readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8"),
    }));
}

// ─── Detection patterns (self-checked with synthetic fixtures below) ─────────

/** Template literals that interpolate AND contain SQL keywords. */
const INTERPOLATED_SQL_TEMPLATE = /`[^`]*\$\{[^`]*`/g;

/** A SQL keyword-bearing double-quoted literal concatenated with a non-literal. */
const SQL_LITERAL_THEN_PLUS = /"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^"]*"\s*\+\s*(?!["\s])/g;

/** A dynamic expression concatenated with a SQL keyword-bearing literal. */
const PLUS_THEN_SQL_LITERAL = /[\w)\]]\s*\+\s*"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b/g;

/** First argument of a `.query(...)` call. */
const QUERY_FIRST_ARG = /\.query\(\s*([^,)]+)/g;

/** Value of a `text:` field (SqlStatement objects). */
const TEXT_FIELD_VALUE = /\btext:\s*([^,\n}]+)/g;

function isDynamicSqlExpression(expression: string): boolean {
  return expression.includes("${") || /"\s*\+|\+\s*"/.test(expression);
}

// ─── AC-36: no interpolation, no concatenation, dynamic-input free ───────────

describe("SQL statement safety (AC-36)", () => {
  const files = scannedFiles();

  it("scans a non-empty set of SQL adapter artifacts", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);

    const sqlConstants = files.reduce(
      (count, file) => count + (file.source.match(/const\s+\w+_SQL\b/g) ?? []).length,
      0,
    );
    expect(sqlConstants).toBeGreaterThanOrEqual(10);
  });

  it("self-checks its own detection patterns against synthetic fixtures", () => {
    expect("`SELECT ${input}`".match(INTERPOLATED_SQL_TEMPLATE)).not.toBeNull();
    expect('"SELECT " + input'.match(SQL_LITERAL_THEN_PLUS)).not.toBeNull();
    expect('input + "SELECT x"'.match(PLUS_THEN_SQL_LITERAL)).not.toBeNull();
    expect(".query(`SELECT ${input}`)".match(new RegExp(QUERY_FIRST_ARG.source))?.[1]).toContain(
      "${",
    );
    expect("text: `SELECT ${input}`".match(new RegExp(TEXT_FIELD_VALUE.source))?.[1]).toContain(
      "${",
    );

    // Static statement constants must NOT trip the rules.
    expect('"SELECT a FROM t" + " WHERE 1 = 1"'.match(SQL_LITERAL_THEN_PLUS)).toBeNull();
    expect('"SELECT a FROM t" + " WHERE 1 = 1"'.match(PLUS_THEN_SQL_LITERAL)).toBeNull();
    expect(".query(SELECT_BY_ID_SQL)".match(new RegExp(QUERY_FIRST_ARG.source))?.[1]).toBe(
      "SELECT_BY_ID_SQL",
    );
    expect("text: APPLY_SCRIPT_SQL".match(new RegExp(TEXT_FIELD_VALUE.source))?.[1]).toBe(
      "APPLY_SCRIPT_SQL",
    );
  });

  it("never interpolates into a SQL-bearing template literal", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const match of file.source.matchAll(INTERPOLATED_SQL_TEMPLATE)) {
        if (/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|FROM dbo\.|\bWHERE\b/.test(match[0])) {
          violations.push(`${file.name}: ${match[0].slice(0, 160)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("never concatenates a SQL literal with a dynamic expression", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const pattern of [SQL_LITERAL_THEN_PLUS, PLUS_THEN_SQL_LITERAL]) {
        for (const match of file.source.matchAll(pattern)) {
          violations.push(`${file.name}: ${match[0].slice(0, 160)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("never passes a computed first argument to query() or a text: field", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const pattern of [QUERY_FIRST_ARG, TEXT_FIELD_VALUE]) {
        for (const match of file.source.matchAll(pattern)) {
          const expression = (match[1] ?? "").trim();
          if (isDynamicSqlExpression(expression)) {
            violations.push(`${file.name}: ${expression.slice(0, 160)}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
