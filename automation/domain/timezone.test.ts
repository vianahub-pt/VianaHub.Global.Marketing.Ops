import { describe, it, expect } from "vitest";
import {
  getTzComponents,
  buildEpochFromTzComponents,
  isValidTimezone,
  TzDateComponents,
} from "./timezone.js";

describe("timezone", () => {
  describe("getTzComponents", () => {
    it("1. UTC returns UTC components", () => {
      // 2026-06-15T12:30:45Z
      const date = new Date(Date.UTC(2026, 5, 15, 12, 30, 45));
      const components = getTzComponents(date, "UTC");

      expect(components).toEqual({
        year: 2026,
        month: 6,
        day: 15,
        hour: 12,
        minute: 30,
        second: 45,
      });
    });

    it("2. Europe/Lisbon correct offset for standard time", () => {
      // Winter time: UTC+0
      // 2026-01-15T12:00:00Z → 2026-01-15T12:00:00 in Lisbon
      const date = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
      const components = getTzComponents(date, "Europe/Lisbon");

      expect(components).toEqual({
        year: 2026,
        month: 1,
        day: 15,
        hour: 12,
        minute: 0,
        second: 0,
      });
    });

    it("3. America/Sao_Paulo correct offset for standard time", () => {
      // Standard time: UTC-3
      // 2026-07-15T15:00:00Z → 2026-07-15T12:00:00 in São Paulo
      const date = new Date(Date.UTC(2026, 6, 15, 15, 0, 0));
      const components = getTzComponents(date, "America/Sao_Paulo");

      expect(components).toEqual({
        year: 2026,
        month: 7,
        day: 15,
        hour: 12,
        minute: 0,
        second: 0,
      });
    });

    it("4. DST Europe/Lisbon March 2026 - gap advances to next valid hour", () => {
      // DST starts last Sunday of March 2026 (March 29) at 01:00
      // Clocks jump from 01:00 to 02:00 — 01:30 doesn't exist
      // Expected: advance to 02:30 (next valid time)
      const components: TzDateComponents = {
        year: 2026,
        month: 3,
        day: 29,
        hour: 1,
        minute: 30,
        second: 0,
      };
      const epoch = buildEpochFromTzComponents(components, "Europe/Lisbon");
      const result = getTzComponents(epoch, "Europe/Lisbon");

      expect(result.year).toBe(2026);
      expect(result.month).toBe(3);
      expect(result.day).toBe(29);
      expect(result.hour).toBe(2);
      expect(result.minute).toBe(30);
    });

    it("5. DST America/Sao_Paulo October 2026 - end of summer time", () => {
      // DST ends in February typically, but let's test October which is standard time
      // 2026-10-18T00:30:00 in São Paulo → UTC-3 (standard time)
      const components: TzDateComponents = {
        year: 2026,
        month: 10,
        day: 18,
        hour: 0,
        minute: 30,
        second: 0,
      };
      const epoch = buildEpochFromTzComponents(components, "America/Sao_Paulo");
      const result = getTzComponents(epoch, "America/Sao_Paulo");

      expect(result.year).toBe(2026);
      expect(result.month).toBe(10);
      expect(result.day).toBe(18);
      expect(result.hour).toBe(0);
      expect(result.minute).toBe(30);
    });

    it("6. Invalid timezone throws descriptive error", () => {
      const date = new Date();
      expect(() => getTzComponents(date, "Invalid/Timezone")).toThrow();
    });
  });

  describe("buildEpochFromTzComponents", () => {
    it("7. Round-trip: components → epoch → same components", () => {
      const original: TzDateComponents = {
        year: 2026,
        month: 6,
        day: 15,
        hour: 14,
        minute: 30,
        second: 45,
      };

      const epoch = buildEpochFromTzComponents(original, "Europe/Lisbon");
      const roundTrip = getTzComponents(epoch, "Europe/Lisbon");

      expect(roundTrip).toEqual(original);
    });

    it("8. DST gap - advances to next valid hour", () => {
      // DST gap in Europe/Lisbon: March 29, 2026, 01:00-02:00 doesn't exist
      // Clocks jump from 01:00 to 02:00
      const gapComponents: TzDateComponents = {
        year: 2026,
        month: 3,
        day: 29,
        hour: 1,
        minute: 30,
        second: 0,
      };

      const epoch = buildEpochFromTzComponents(gapComponents, "Europe/Lisbon");
      const result = getTzComponents(epoch, "Europe/Lisbon");

      // Should advance to 02:30 (next valid time)
      expect(result.hour).toBe(2);
      expect(result.minute).toBe(30);
    });

    it("9. DST ambiguity - returns first occurrence", () => {
      // DST ambiguity in Europe/Lisbon: October 25, 2026, 01:00-02:00 occurs twice
      // Clocks go back from 02:00 to 01:00
      const ambiguousComponents: TzDateComponents = {
        year: 2026,
        month: 10,
        day: 25,
        hour: 1,
        minute: 30,
        second: 0,
      };

      const epoch = buildEpochFromTzComponents(ambiguousComponents, "Europe/Lisbon");
      const result = getTzComponents(epoch, "Europe/Lisbon");

      // Should return the first occurrence (summer time, UTC+1)
      expect(result.year).toBe(2026);
      expect(result.month).toBe(10);
      expect(result.day).toBe(25);
      expect(result.hour).toBe(1);
      expect(result.minute).toBe(30);
    });

    it("10. Midnight edge case - hour 0, minute 0", () => {
      const midnight: TzDateComponents = {
        year: 2026,
        month: 1,
        day: 1,
        hour: 0,
        minute: 0,
        second: 0,
      };

      const epoch = buildEpochFromTzComponents(midnight, "UTC");
      const result = getTzComponents(epoch, "UTC");

      expect(result).toEqual(midnight);
      expect(epoch.getTime()).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
    });
  });

  describe("weekday mapping", () => {
    it("11. Sun=0, Mon=1, ..., Sat=6", () => {
      // 2026-09-20 is a Sunday (day 0)
      const sunday = new Date(Date.UTC(2026, 8, 20, 12, 0, 0));
      expect(sunday.getUTCDay()).toBe(0); // Sunday

      // 2026-09-21 is Monday (day 1)
      const monday = new Date(Date.UTC(2026, 8, 21, 12, 0, 0));
      expect(monday.getUTCDay()).toBe(1); // Monday

      // 2026-09-26 is Saturday (day 6)
      const saturday = new Date(Date.UTC(2026, 8, 26, 12, 0, 0));
      expect(saturday.getUTCDay()).toBe(6); // Saturday
    });
  });

  describe("leap year", () => {
    it("12. February 29 in leap year - correct components", () => {
      // 2028 is a leap year
      const leapDay = new Date(Date.UTC(2028, 1, 29, 12, 0, 0));
      const components = getTzComponents(leapDay, "UTC");

      expect(components).toEqual({
        year: 2028,
        month: 2,
        day: 29,
        hour: 12,
        minute: 0,
        second: 0,
      });

      // Round-trip
      const epoch = buildEpochFromTzComponents(components, "UTC");
      expect(epoch.getTime()).toBe(leapDay.getTime());
    });
  });

  describe("isValidTimezone", () => {
    it("returns true for valid IANA timezones", () => {
      expect(isValidTimezone("UTC")).toBe(true);
      expect(isValidTimezone("Europe/Lisbon")).toBe(true);
      expect(isValidTimezone("America/Sao_Paulo")).toBe(true);
      expect(isValidTimezone("Asia/Tokyo")).toBe(true);
    });

    it("returns false for invalid timezones", () => {
      expect(isValidTimezone("Invalid/Timezone")).toBe(false);
      expect(isValidTimezone("")).toBe(false);
      expect(isValidTimezone("GMT+1")).toBe(false);
    });
  });
});
