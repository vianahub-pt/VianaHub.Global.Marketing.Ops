/**
 * Shared row-mapping helpers for the SQL Server repository adapters
 * (REV-46 — Sprint 5, Ciclo 3).
 *
 * `sql-run-repo`, `sql-checkpoint-repo`, `sql-schedule-repo` and
 * `sql-batch-repo` each carried a private copy of `rowToObject`,
 * `toDate`/`toOptionalDate`, `parseJsonColumn` and `toOptionalString`.
 * The copies are structurally identical; only the literal text of their
 * `CorruptedRecordError` messages differs. Every helper below is therefore
 * parameterized by a context that reproduces those texts byte-for-byte —
 * a mechanical extraction with ZERO behaviour change:
 *
 * - {@link DatetimeContext} table form → `Invalid datetime column in
 *   <table>: expected Date, received …` (run, schedule).
 * - {@link DatetimeContext} field form → `Invalid <column> for <noun>
 *   <recordId>: expected Date, received …` (batch, checkpoint).
 * - {@link JsonColumnContext} → `Invalid <column> for <noun> <recordId>:
 *   expected text, received …` and `Invalid JSON in <column> for <noun>
 *   <recordId>: …` (all adapters).
 *
 * No SQL statement, repository signature or error message changes with
 * this module — the adapters simply import the helpers instead of
 * copying them.
 */

import { CorruptedRecordError } from "../persistence-errors.js";

/**
 * Which values {@link parseJsonColumn} and {@link toOptionalString} treat
 * as an absent column (returning `undefined`) instead of raising an error:
 *
 * - `"null"` — only SQL `NULL` (run, schedule);
 * - `"nullOrUndefined"` — `NULL` or a missing value (batch);
 * - `"none"` — nothing; even `NULL` is a corruption error (checkpoint).
 */
export type JsonEmptyPolicy = "null" | "nullOrUndefined" | "none";

/**
 * Context for {@link toDate} and {@link toOptionalDate}: selects between
 * the two literal message shapes the adapters use today.
 *
 * - Table form (`{ table }`) → `Invalid datetime column in <table>: …`.
 * - Field form (`{ column, noun, recordId }`) →
 *   `Invalid <column> for <noun> <recordId>: …`.
 */
export type DatetimeContext =
  | { readonly table: string }
  | { readonly column: string; readonly noun: string; readonly recordId: unknown };

/**
 * Context for {@link parseJsonColumn} and {@link toOptionalString}: `noun`
 * is the record subject after `for ` (`run <id>`, `schedule <id>`,
 * `record <id>`, `checkpoint of run <id>`) and `empty` selects which
 * values are treated as an absent column.
 */
export interface JsonColumnContext {
  readonly noun: string;
  readonly empty: JsonEmptyPolicy;
}

/**
 * Maps a positional result row onto its column names.
 *
 * Columns beyond the row's length map to `undefined`; extra row values are
 * ignored. Identical in all four SQL adapters.
 */
export function rowToObject(
  columns: readonly string[],
  row: readonly unknown[],
): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (let index = 0; index < columns.length; index += 1) {
    raw[columns[index]] = row[index];
  }
  return raw;
}

/** Builds the text between `Invalid ` and `: expected Date, received …`. */
function datetimeLabel(context: DatetimeContext): string {
  if ("table" in context) {
    return `datetime column in ${context.table}`;
  }
  return `${context.column} for ${context.noun} ${String(context.recordId)}`;
}

/**
 * Narrows a column value to `Date`.
 *
 * @throws {CorruptedRecordError} `Invalid <label>: expected Date,
 *   received <null|type>` when the value is not a `Date`.
 */
export function toDate(value: unknown, context: DatetimeContext): Date {
  if (value instanceof Date) {
    return value;
  }
  throw new CorruptedRecordError(
    `Invalid ${datetimeLabel(context)}: expected Date, received ${value === null ? "null" : typeof value}`,
  );
}

/**
 * Narrows an optional column value to `Date | undefined`.
 *
 * SQL `NULL` maps to `undefined`; any other non-`Date` value raises the
 * same error as {@link toDate}.
 */
export function toOptionalDate(value: unknown, context: DatetimeContext): Date | undefined {
  if (value === null) {
    return undefined;
  }
  return toDate(value, context);
}

/** Whether a JSON/text column value counts as absent under `empty`. */
function isAbsent(value: unknown, empty: JsonEmptyPolicy): boolean {
  if (value === null) {
    return empty !== "none";
  }
  if (empty === "nullOrUndefined") {
    return value === undefined;
  }
  return false;
}

/** Builds the `<noun> <recordId>` subject of text/JSON messages. */
function jsonSubject(context: JsonColumnContext, recordId: unknown): string {
  return `${context.noun} ${String(recordId)}`;
}

/**
 * Parses a JSON text column.
 *
 * Absent values (`empty` policy) map to `undefined`; a non-text value or
 * unparseable JSON raises `CorruptedRecordError` with the adapter's
 * literal message.
 *
 * @throws {CorruptedRecordError} when the value is not text or is not
 *   valid JSON (the original parse error is attached as `cause`).
 */
export function parseJsonColumn(
  value: unknown,
  column: string,
  recordId: unknown,
  context: JsonColumnContext,
): unknown {
  if (isAbsent(value, context.empty)) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new CorruptedRecordError(
      `Invalid ${column} for ${jsonSubject(context, recordId)}: expected text, received ${value === null ? "null" : typeof value}`,
    );
  }
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new CorruptedRecordError(
      `Invalid JSON in ${column} for ${jsonSubject(context, recordId)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/**
 * Narrows an optional text column to `string | undefined`.
 *
 * Absent values (`empty` policy) map to `undefined`; any other non-text
 * value raises `CorruptedRecordError` with the adapter's literal message.
 */
export function toOptionalString(
  value: unknown,
  column: string,
  recordId: unknown,
  context: JsonColumnContext,
): string | undefined {
  if (isAbsent(value, context.empty)) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  throw new CorruptedRecordError(
    `Invalid ${column} for ${jsonSubject(context, recordId)}: expected text, received ${typeof value}`,
  );
}
