import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// ─── Scope: automation/domain/** and automation/application/** ───────────────
// The boundary test lives under automation/adapters/sql/ (the only writable
// location for I-2), but it still guards the domain/application layers: no
// file there may reference the SQL driver, the SQL adapters, or raw
// `dbo.` statements (AC-03).

const AUTOMATION_DIR = fileURLToPath(new URL("../..", import.meta.url));

function listTsFiles(root: string): readonly string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

const FORBIDDEN_SPECIFIER = /mssql|tedious|\/sql\/|sql-pool|sql-config|adapters\/sql/;
const SPECIFIER_PATTERN = /(?:from\s+|import\(|require\()\s*["']([^"']+)["']/g;
const SQL_TABLE_LITERAL = /FROM dbo\.|INTO dbo\.|UPDATE dbo\.|DELETE FROM dbo\./;

function violationsIn(files: readonly string[]): readonly string[] {
  const violations: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(SPECIFIER_PATTERN)) {
      const specifier = match[1] ?? "";
      if (FORBIDDEN_SPECIFIER.test(specifier)) {
        violations.push(`${file}: import of "${specifier}"`);
      }
    }
    if (SQL_TABLE_LITERAL.test(source)) {
      violations.push(`${file}: raw dbo. statement literal`);
    }
  }
  return violations;
}

const domainFiles = listTsFiles(join(AUTOMATION_DIR, "domain"));
const applicationFiles = listTsFiles(join(AUTOMATION_DIR, "application"));

// ─── AC-03: domain/application stay free of SQL infrastructure ───────────────

describe("import boundary — domain and application (AC-03)", () => {
  it("scans a non-empty domain layer and self-checks its patterns", () => {
    expect(domainFiles.length).toBeGreaterThanOrEqual(5);

    const fixture = "import { SqlRunRepository } from '../adapters/sql/sql-run-repo.js';";
    expect(fixture.match(new RegExp(SPECIFIER_PATTERN.source))?.[1]).toBe(
      "../adapters/sql/sql-run-repo.js",
    );
    expect(FORBIDDEN_SPECIFIER.test("../adapters/sql/sql-run-repo.js")).toBe(true);
    expect(FORBIDDEN_SPECIFIER.test("./run-record.js")).toBe(false);
    expect(FORBIDDEN_SPECIFIER.test("zod")).toBe(false);
    expect(SQL_TABLE_LITERAL.test("SELECT * FROM dbo.Runs")).toBe(true);
    expect(SQL_TABLE_LITERAL.test('const name = "database/migrations/001.sql";')).toBe(false);
  });

  it("keeps every domain file free of the SQL driver and adapters", () => {
    expect(violationsIn(domainFiles)).toEqual([]);
  });

  it("keeps every application file free of the SQL driver and adapters", () => {
    expect(violationsIn(applicationFiles)).toEqual([]);
  });
});
