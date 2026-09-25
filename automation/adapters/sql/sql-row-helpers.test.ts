import { describe, expect, it } from "vitest";

import { CorruptedRecordError } from "../persistence-errors.js";
import {
  parseJsonColumn,
  rowToObject,
  toDate,
  toOptionalDate,
  toOptionalString,
  type DatetimeContext,
  type JsonColumnContext,
} from "./sql-row-helpers.js";

// ─── Contexts: one per SQL adapter — literal messages preserved ─────────────

const runDatetime: DatetimeContext = { table: "dbo.Runs" };
const scheduleDatetime: DatetimeContext = { table: "dbo.Schedules" };
const batchDatetime: DatetimeContext = {
  column: "CreatedAt",
  noun: "record",
  recordId: "b-7",
};
const checkpointDatetime: DatetimeContext = {
  column: "CreatedAt",
  noun: "checkpoint of run",
  recordId: "r-9",
};

const runJson: JsonColumnContext = { noun: "run", empty: "null" };
const scheduleJson: JsonColumnContext = { noun: "schedule", empty: "null" };
const batchJson: JsonColumnContext = { noun: "record", empty: "nullOrUndefined" };
const checkpointJson: JsonColumnContext = { noun: "checkpoint of run", empty: "none" };

/** Returns the thrown error so its class and exact message can be asserted. */
function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the call to throw, but it returned normally");
}

// ─── rowToObject ────────────────────────────────────────────────────────────

describe("rowToObject", () => {
  it("maps each positional value onto its column name", () => {
    expect(rowToObject(["A", "B"], [1, "x"])).toEqual({ A: 1, B: "x" });
  });

  it("keeps a missing row slot as an undefined value", () => {
    const raw = rowToObject(["A", "B"], [1]);
    expect(raw).toHaveProperty("A", 1);
    expect(Object.keys(raw)).toContain("B");
    expect(raw.B).toBeUndefined();
  });

  it("ignores extra row values and handles an empty column list", () => {
    expect(rowToObject(["A"], [1, 2])).toEqual({ A: 1 });
    expect(rowToObject([], [])).toEqual({});
  });
});

// ─── toDate ─────────────────────────────────────────────────────────────────

describe("toDate", () => {
  it("round-trips a Date instance unchanged in table contexts", () => {
    const value = new Date("2026-04-01T10:00:00.000Z");
    expect(toDate(value, runDatetime)).toBe(value);
    expect(toDate(value, scheduleDatetime)).toBe(value);
  });

  it("round-trips a Date instance unchanged in field contexts", () => {
    const value = new Date("2026-04-01T10:00:00.000Z");
    expect(toDate(value, batchDatetime)).toBe(value);
    expect(toDate(value, checkpointDatetime)).toBe(value);
  });

  it("rejects null with the run table message", () => {
    const error = captureError(() => toDate(null, runDatetime));
    expect(error).toBeInstanceOf(CorruptedRecordError);
    expect(error.message).toBe("Invalid datetime column in dbo.Runs: expected Date, received null");
  });

  it("rejects a non-Date value with the schedule table message", () => {
    const error = captureError(() => toDate("2026-04-01", scheduleDatetime));
    expect(error.message).toBe(
      "Invalid datetime column in dbo.Schedules: expected Date, received string",
    );
  });

  it("rejects a non-Date value with the batch field message", () => {
    const error = captureError(() => toDate(42, batchDatetime));
    expect(error).toBeInstanceOf(CorruptedRecordError);
    expect(error.message).toBe("Invalid CreatedAt for record b-7: expected Date, received number");
  });

  it("rejects a missing value with the checkpoint field message", () => {
    const error = captureError(() => toDate(undefined, checkpointDatetime));
    expect(error).toBeInstanceOf(CorruptedRecordError);
    expect(error.message).toBe(
      "Invalid CreatedAt for checkpoint of run r-9: expected Date, received undefined",
    );
  });
});

// ─── toOptionalDate ─────────────────────────────────────────────────────────

describe("toOptionalDate", () => {
  it("maps SQL NULL to undefined", () => {
    expect(toOptionalDate(null, runDatetime)).toBeUndefined();
    expect(toOptionalDate(null, scheduleDatetime)).toBeUndefined();
  });

  it("round-trips a Date instance unchanged", () => {
    const value = new Date("2026-04-01T10:00:00.000Z");
    expect(toOptionalDate(value, runDatetime)).toBe(value);
  });

  it("propagates the toDate error for a non-Date, non-null value", () => {
    const error = captureError(() => toOptionalDate("nope", scheduleDatetime));
    expect(error).toBeInstanceOf(CorruptedRecordError);
    expect(error.message).toBe(
      "Invalid datetime column in dbo.Schedules: expected Date, received string",
    );
  });
});

// ─── parseJsonColumn ────────────────────────────────────────────────────────

describe("parseJsonColumn", () => {
  it("maps SQL NULL to undefined under the run/schedule policy", () => {
    expect(parseJsonColumn(null, "MetadataJson", "r-1", runJson)).toBeUndefined();
    expect(parseJsonColumn(null, "MetadataJson", "s-1", scheduleJson)).toBeUndefined();
  });

  it("maps a missing value to undefined under the batch policy", () => {
    expect(parseJsonColumn(undefined, "MetadataJson", "b-1", batchJson)).toBeUndefined();
  });

  it("round-trips a JSON object", () => {
    expect(parseJsonColumn('{"batch":"b-42","items":7}', "MetadataJson", "r-1", runJson)).toEqual({
      batch: "b-42",
      items: 7,
    });
  });

  it("round-trips a JSON array and a JSON scalar", () => {
    expect(parseJsonColumn("[1,2,3]", "MetadataJson", "r-1", runJson)).toEqual([1, 2, 3]);
    expect(parseJsonColumn('"text"', "MetadataJson", "s-1", scheduleJson)).toBe("text");
  });

  it("rejects a non-text value with the run message", () => {
    const error = captureError(() => parseJsonColumn(42, "MetadataJson", "r-1", runJson));
    expect(error).toBeInstanceOf(CorruptedRecordError);
    expect(error.message).toBe("Invalid MetadataJson for run r-1: expected text, received number");
  });

  it("rejects a missing value under the run policy", () => {
    const error = captureError(() => parseJsonColumn(undefined, "MetadataJson", "r-1", runJson));
    expect(error.message).toBe(
      "Invalid MetadataJson for run r-1: expected text, received undefined",
    );
  });

  it("rejects a non-text value with the schedule message", () => {
    const error = captureError(() => parseJsonColumn(true, "MetadataJson", "s-1", scheduleJson));
    expect(error.message).toBe(
      "Invalid MetadataJson for schedule s-1: expected text, received boolean",
    );
  });

  it("rejects a non-text value with the batch message", () => {
    const error = captureError(() => parseJsonColumn({}, "MetadataJson", "b-1", batchJson));
    expect(error.message).toBe(
      "Invalid MetadataJson for record b-1: expected text, received object",
    );
  });

  it("rejects SQL NULL under the checkpoint policy", () => {
    const error = captureError(() => parseJsonColumn(null, "PayloadJson", "r-9", checkpointJson));
    expect(error).toBeInstanceOf(CorruptedRecordError);
    expect(error.message).toBe(
      "Invalid PayloadJson for checkpoint of run r-9: expected text, received null",
    );
  });

  it("rejects invalid JSON with the run message and the parse error as cause", () => {
    const error = captureError(() => parseJsonColumn("{oops", "MetadataJson", "r-1", runJson));
    expect(error).toBeInstanceOf(CorruptedRecordError);
    expect(error.message.startsWith("Invalid JSON in MetadataJson for run r-1: ")).toBe(true);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("rejects invalid JSON with the checkpoint message and cause", () => {
    const error = captureError(() => parseJsonColumn("[1,", "PayloadJson", "r-9", checkpointJson));
    expect(
      error.message.startsWith("Invalid JSON in PayloadJson for checkpoint of run r-9: "),
    ).toBe(true);
    expect(error.cause).toBeInstanceOf(Error);
  });
});

// ─── toOptionalString ───────────────────────────────────────────────────────

describe("toOptionalString", () => {
  it("maps absent values to undefined under the batch policy", () => {
    expect(toOptionalString(null, "Error", "i-3", batchJson)).toBeUndefined();
    expect(toOptionalString(undefined, "Error", "i-3", batchJson)).toBeUndefined();
  });

  it("returns a text value unchanged", () => {
    expect(toOptionalString("boom", "Error", "i-3", batchJson)).toBe("boom");
  });

  it("rejects a non-text value with the batch message", () => {
    const error = captureError(() => toOptionalString(7, "Error", "i-3", batchJson));
    expect(error).toBeInstanceOf(CorruptedRecordError);
    expect(error.message).toBe("Invalid Error for record i-3: expected text, received number");
  });
});
