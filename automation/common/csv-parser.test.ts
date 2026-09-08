import { describe, it, expect } from "vitest";
import { parseCsv, CsvParseError } from "./csv-parser.js";

describe("csv-parser", () => {
  describe("parseCsv", () => {
    it("parses a simple CSV", () => {
      const csv = "platform_id,enabled,priority,status\ngoogle-business-profile,true,high,pending";
      const result = parseCsv(csv);
      expect(result.headers).toEqual(["platform_id", "enabled", "priority", "status"]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].platform_id).toBe("google-business-profile");
    });

    it("parses CSV with quoted fields", () => {
      const csv =
        'platform_id,enabled,priority,status,notes\ngoogle-business-profile,true,high,pending,"This is a note"';
      const result = parseCsv(csv);
      expect(result.rows[0].notes).toBe("This is a note");
    });

    it("handles escaped quotes in CSV", () => {
      const csv =
        'platform_id,enabled,priority,status,notes\ngoogle-business-profile,true,high,pending,"Note with ""escaped"" quotes"';
      const result = parseCsv(csv);
      expect(result.rows[0].notes).toBe('Note with "escaped" quotes');
    });

    it("handles commas inside quoted fields", () => {
      const csv =
        'platform_id,enabled,priority,status,notes\ngoogle-business-profile,true,high,pending,"Note, with, commas"';
      const result = parseCsv(csv);
      expect(result.rows[0].notes).toBe("Note, with, commas");
    });

    it("handles Windows line endings", () => {
      const csv =
        "platform_id,enabled,priority,status\r\ngoogle-business-profile,true,high,pending";
      const result = parseCsv(csv);
      expect(result.rows).toHaveLength(1);
    });

    it("handles mixed line endings", () => {
      const csv =
        "platform_id,enabled,priority,status\r\ngoogle-business-profile,true,high,pending\napple-business-connect,true,critical,pending";
      const result = parseCsv(csv);
      expect(result.rows).toHaveLength(2);
    });

    it("throws for empty CSV", () => {
      expect(() => parseCsv("")).toThrow(CsvParseError);
      expect(() => parseCsv("  ")).toThrow(CsvParseError);
    });

    it("throws for missing required headers", () => {
      const csv = "platform_id,listing_name\ngoogle-business-profile,Test";
      expect(() => parseCsv(csv)).toThrow(CsvParseError);
      expect(() => parseCsv(csv)).toThrow(/Missing required header/);
    });

    it("throws for unknown headers", () => {
      const csv =
        "platform_id,enabled,priority,status,unknown_field\ngoogle-business-profile,true,high,pending,test";
      expect(() => parseCsv(csv)).toThrow(CsvParseError);
      expect(() => parseCsv(csv)).toThrow(/Unknown header/);
    });

    it("throws for duplicate headers", () => {
      const csv = "platform_id,enabled,priority,priority\ngoogle-business-profile,true,high,high";
      expect(() => parseCsv(csv)).toThrow(CsvParseError);
      expect(() => parseCsv(csv)).toThrow(/Duplicate header/);
    });

    it("throws for empty platform_id", () => {
      const csv = "platform_id,enabled,priority,status\n,true,high,pending";
      expect(() => parseCsv(csv)).toThrow(CsvParseError);
      expect(() => parseCsv(csv)).toThrow(/platform_id is empty/);
    });

    it("throws for duplicate platform_id", () => {
      const csv =
        "platform_id,enabled,priority,status\ngoogle-business-profile,true,high,pending\ngoogle-business-profile,true,critical,pending";
      expect(() => parseCsv(csv)).toThrow(CsvParseError);
      expect(() => parseCsv(csv)).toThrow(/duplicate platform_id/);
    });

    it("throws for invalid enabled value", () => {
      const csv = "platform_id,enabled,priority,status\ngoogle-business-profile,yes,high,pending";
      expect(() => parseCsv(csv)).toThrow(CsvParseError);
      expect(() => parseCsv(csv)).toThrow(/enabled must be "true" or "false"/);
    });

    it("throws for column count mismatch", () => {
      const csv = "platform_id,enabled,priority,status\ngoogle-business-profile,true,high";
      expect(() => parseCsv(csv)).toThrow(CsvParseError);
      expect(() => parseCsv(csv)).toThrow(/expected 4 columns, got 3/);
    });

    it("skips empty lines", () => {
      const csv =
        "platform_id,enabled,priority,status\n\ngoogle-business-profile,true,high,pending\n\n";
      const result = parseCsv(csv);
      expect(result.rows).toHaveLength(1);
    });

    it("parses multiple rows", () => {
      const csv =
        "platform_id,enabled,priority,status\ngoogle-business-profile,true,high,pending\nbing-for-business,true,critical,pending\napple-business-connect,true,medium,pending";
      const result = parseCsv(csv);
      expect(result.rows).toHaveLength(3);
      expect(result.rows[0].platform_id).toBe("google-business-profile");
      expect(result.rows[1].platform_id).toBe("bing-for-business");
      expect(result.rows[2].platform_id).toBe("apple-business-connect");
    });

    it("handles all valid headers", () => {
      const csv =
        "platform_id,listing_name,enabled,priority,status,listing_url,last_checked,notes\nplatform-id,My Listing,true,high,pending,https://example.com,2026-01-01,Some notes";
      const result = parseCsv(csv);
      expect(result.headers).toHaveLength(8);
      expect(result.rows[0].listing_name).toBe("My Listing");
      expect(result.rows[0].listing_url).toBe("https://example.com");
      expect(result.rows[0].last_checked).toBe("2026-01-01");
      expect(result.rows[0].notes).toBe("Some notes");
    });

    it("handles multiline quoted fields", () => {
      const csv =
        'platform_id,enabled,priority,status,notes\ngoogle-business-profile,true,high,pending,"Line 1\nLine 2\nLine 3"';
      const result = parseCsv(csv);
      expect(result.rows[0].notes).toBe("Line 1\nLine 2\nLine 3");
    });

    it("handles multiline with commas inside quotes", () => {
      const csv =
        'platform_id,enabled,priority,status,notes\ngoogle-business-profile,true,high,pending,"First line\nSecond, line\nThird line"';
      const result = parseCsv(csv);
      expect(result.rows[0].notes).toBe("First line\nSecond, line\nThird line");
      expect(result.rows).toHaveLength(1);
    });

    it("handles BOM (UTF-8)", () => {
      const csv =
        "\uFEFFplatform_id,enabled,priority,status\ngoogle-business-profile,true,high,pending";
      const result = parseCsv(csv);
      expect(result.headers[0]).toBe("platform_id");
    });

    it("handles Unicode characters", () => {
      const csv =
        'platform_id,enabled,priority,status,listing_name\ngoogle-business-profile,true,high,pending,"Fluência Lingua"';
      const result = parseCsv(csv);
      expect(result.rows[0].listing_name).toBe("Fluência Lingua");
    });
  });
});
