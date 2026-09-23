/**
 * Cron expression parser with timezone support.
 *
 * Supports:
 * - Standard 5-field format: minute hour dom month dow
 * - Convenience aliases: @daily, @hourly, @weekly, @monthly, @yearly
 * - Tokens: *, ranges (1-5), steps (/2, 1-5/2), lists (1,3,5)
 */

import type { Clock } from "./clock.js";
import { getTzComponents, isValidTimezone } from "./timezone.js";

/**
 * Parsed cron expression with expanded fields.
 */
export interface ParsedCron {
  /** Minutes (0-59) */
  minutes: Set<number>;
  /** Hours (0-23) */
  hours: Set<number>;
  /** Day of month (1-31) */
  daysOfMonth: Set<number>;
  /** Months (1-12) */
  months: Set<number>;
  /** Day of week (0-6, 0=Sunday) */
  daysOfWeek: Set<number>;
  /** Original expression */
  raw: string;
}

/**
 * Cron alias mapping.
 */
const CRON_ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
};

/**
 * Parses a single cron field into a set of valid values.
 *
 * Supports:
 * - Wildcard: *
 * - Ranges: 1-5
 * - Steps: /2, 1-5/2
 * - Lists: 1,3,5
 *
 * @param field - The cron field to parse
 * @param min - Minimum valid value
 * @param max - Maximum valid value
 * @param fieldName - Name of the field for error messages
 * @returns Set of valid values
 */
function parseCronField(field: string, min: number, max: number, fieldName: string): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    // Handle step: */2 or 1-5/2
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? parseInt(stepPart, 10) : 1;

    if (isNaN(step) || step < 1) {
      throw new Error(`Invalid step value in ${fieldName}: ${stepPart}`);
    }

    if (rangePart === "*") {
      // Wildcard with optional step
      for (let i = min; i <= max; i += step) {
        values.add(i);
      }
    } else if (rangePart.includes("-")) {
      // Range: 1-5
      const [startStr, endStr] = rangePart.split("-");
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      if (isNaN(start) || isNaN(end)) {
        throw new Error(`Invalid range in ${fieldName}: ${rangePart}`);
      }

      if (start < min || end > max || start > end) {
        throw new Error(`Range ${start}-${end} out of bounds for ${fieldName} (${min}-${max})`);
      }

      for (let i = start; i <= end; i += step) {
        values.add(i);
      }
    } else {
      // Single value
      const value = parseInt(rangePart, 10);

      if (isNaN(value)) {
        throw new Error(`Invalid value in ${fieldName}: ${rangePart}`);
      }

      if (value < min || value > max) {
        throw new Error(`Value ${value} out of bounds for ${fieldName} (${min}-${max})`);
      }

      // For single value with step, repeat from value to max
      if (stepPart) {
        for (let i = value; i <= max; i += step) {
          values.add(i);
        }
      } else {
        values.add(value);
      }
    }
  }

  return values;
}

/**
 * Normalizes day of week: 7 (Sunday) → 0.
 */
function normalizeDayOfWeek(dow: number): number {
  return dow === 7 ? 0 : dow;
}

/**
 * Parses a cron expression into a ParsedCron object.
 *
 * @param expression - Cron expression (5-field or alias)
 * @returns ParsedCron with expanded fields
 * @throws Error if expression is invalid
 */
export function parseCronExpression(expression: string): ParsedCron {
  // Handle aliases
  const normalized = CRON_ALIASES[expression.toLowerCase()] ?? expression;

  // Split into fields
  const fields = normalized.trim().split(/\s+/);

  if (fields.length !== 5) {
    throw new Error(`Cron expression must have exactly 5 fields, got ${fields.length}`);
  }

  // Parse each field
  const minutes = parseCronField(fields[0], 0, 59, "minute");
  const hours = parseCronField(fields[1], 0, 23, "hour");
  const daysOfMonth = parseCronField(fields[2], 1, 31, "day of month");
  const months = parseCronField(fields[3], 1, 12, "month");
  const daysOfWeekRaw = parseCronField(fields[4], 0, 7, "day of week");

  // Normalize day of week: 7 → 0
  const daysOfWeek = new Set<number>();
  for (const dow of daysOfWeekRaw) {
    daysOfWeek.add(normalizeDayOfWeek(dow));
  }

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    raw: expression,
  };
}

/**
 * Checks if a date matches a parsed cron expression.
 *
 * @param cron - Parsed cron expression
 * @param date - Date to check
 * @param timezone - IANA timezone
 * @returns true if date matches cron
 */
export function matchesCron(cron: ParsedCron, date: Date, timezone: string): boolean {
  const { minute, hour, day, month } = getTzComponents(date, timezone);
  const dow = getDayOfWeek(date, timezone);

  return (
    cron.minutes.has(minute) &&
    cron.hours.has(hour) &&
    cron.daysOfMonth.has(day) &&
    cron.months.has(month) &&
    cron.daysOfWeek.has(dow)
  );
}

/**
 * Gets the number of days in a given month/year.
 */
function daysInMonth(month: number, year: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Gets the timezone offset in milliseconds at a given instant.
 * offset = localTime − utcTime (positive for east of UTC).
 */
function getTimezoneOffsetMs(date: Date, timezone: string): number {
  const utc = getTzComponents(date, "UTC");
  const tz = getTzComponents(date, timezone);
  return (
    Date.UTC(tz.year, tz.month - 1, tz.day, tz.hour, tz.minute, 0) -
    Date.UTC(utc.year, utc.month - 1, utc.day, utc.hour, utc.minute, 0)
  );
}

/**
 * Creates a Date whose timezone-aware components match the given values.
 * Uses two-pass offset calculation to handle DST transitions correctly.
 */
function createDateInTimezone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const desiredUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // First pass: estimate offset at the desired UTC time
  let offset = getTimezoneOffsetMs(new Date(desiredUtcMs), timezone);
  let result = new Date(desiredUtcMs - offset);

  // Second pass: verify and correct (handles DST boundary cases)
  const comp = getTzComponents(result, timezone);
  if (
    comp.year !== year ||
    comp.month !== month ||
    comp.day !== day ||
    comp.hour !== hour ||
    comp.minute !== minute
  ) {
    offset = getTimezoneOffsetMs(result, timezone);
    result = new Date(desiredUtcMs - offset);
  }

  return result;
}

/**
 * Creates a new Date by changing specific timezone-aware components.
 */
function setDateComponents(
  base: Date,
  timezone: string,
  changes: Partial<{
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  }>,
): Date {
  const c = getTzComponents(base, timezone);
  return createDateInTimezone(
    changes.year ?? c.year,
    changes.month ?? c.month,
    changes.day ?? c.day,
    changes.hour ?? c.hour,
    changes.minute ?? c.minute,
    timezone,
  );
}

/**
 * Finds the first value in a sorted array that is strictly greater than current.
 * Returns null if no such value exists.
 */
function findNextInSet(sorted: number[], current: number): number | null {
  for (const v of sorted) {
    if (v > current) {
      return v;
    }
  }
  return null;
}

/**
 * Returns the minimum value in a sorted number array.
 */
function findMinInSet(sorted: number[]): number {
  return sorted[0]!;
}

/**
 * Day-of-week formatter cache and mapping.
 */
const dowFormatterCache = new Map<string, Intl.DateTimeFormat>();
const DOW_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Gets the day of week (0=Sunday) for a Date in a given timezone.
 */
function getDayOfWeek(date: Date, timezone: string): number {
  let formatter = dowFormatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
    });
    dowFormatterCache.set(timezone, formatter);
  }
  return DOW_MAP[formatter.format(date)] ?? 0;
}

/**
 * Checks if a cron expression is impossible (e.g., day 31 in February).
 * Returns true if no valid date can ever match the expression.
 */
function isImpossibleCron(sortedDaysOfMonth: number[], sortedMonths: number[]): boolean {
  // Check if ANY month can accommodate the SMALLEST required day
  // If the smallest required day is > max days in all months, it's impossible

  // For each valid month, check if at least one required day fits
  for (const month of sortedMonths) {
    // February in non-leap years has 28 days, leap years 29
    // Use 29 as conservative max for February
    const maxDay = month === 2 ? 29 : daysInMonth(month, 2024);
    if (sortedDaysOfMonth.some((d) => d <= maxDay)) {
      return false; // At least one day fits in this month
    }
  }

  return true; // No valid day fits in any month
}

/**
 * Advances a candidate date to the next potentially valid time by
 * jumping forward at the finest granularity that yields progress.
 *
 * Priority chain: minute → hour → day → month → year.
 * Each level resets all finer levels to their minimum valid value.
 */
function smartAdvance(
  date: Date,
  cron: ParsedCron,
  timezone: string,
  sortedMinutes: number[],
  sortedHours: number[],
  sortedDaysOfMonth: number[],
  sortedMonths: number[],
): Date {
  const { minute, hour, day, month, year } = getTzComponents(date, timezone);

  // 1. Try to advance minute within current hour
  const nextMin = findNextInSet(sortedMinutes, minute);
  if (nextMin !== null) {
    return setDateComponents(date, timezone, { minute: nextMin });
  }

  // 2. No more valid minutes this hour → advance hour, reset minutes
  const nextHour = findNextInSet(sortedHours, hour);
  if (nextHour !== null) {
    return setDateComponents(date, timezone, {
      hour: nextHour,
      minute: findMinInSet(sortedMinutes),
    });
  }

  // 3. No more valid hours this day → advance day, reset time
  const maxDay = daysInMonth(month, year);
  const nextDay = findNextInSet(sortedDaysOfMonth, day);
  if (nextDay !== null && nextDay <= maxDay) {
    return setDateComponents(date, timezone, {
      day: nextDay,
      hour: findMinInSet(sortedHours),
      minute: findMinInSet(sortedMinutes),
    });
  }

  // 4. No more valid days this month → advance month, reset date+time
  const nextMonth = findNextInSet(sortedMonths, month);
  if (nextMonth !== null) {
    const maxDayNext = daysInMonth(nextMonth, year);
    const firstValidDay = sortedDaysOfMonth.find((d) => d <= maxDayNext);
    if (firstValidDay !== undefined) {
      return createDateInTimezone(
        year,
        nextMonth,
        firstValidDay,
        findMinInSet(sortedHours),
        findMinInSet(sortedMinutes),
        timezone,
      );
    }
  }

  // 5. No valid combination this year → advance to next year
  const nextYear = year + 1;
  const firstMonth = findMinInSet(sortedMonths);
  const maxDayFirst = daysInMonth(firstMonth, nextYear);
  const firstValidDay = sortedDaysOfMonth.find((d) => d <= maxDayFirst) ?? 1;
  return createDateInTimezone(
    nextYear,
    firstMonth,
    firstValidDay,
    findMinInSet(sortedHours),
    findMinInSet(sortedMinutes),
    timezone,
  );
}

/**
 * Validates that a timezone string is a valid IANA timezone.
 * @throws RangeError if timezone is invalid
 */
function validateTimezone(timezone: string): void {
  if (!isValidTimezone(timezone)) {
    throw new RangeError(`Invalid timezone: ${timezone}`);
  }
}

/**
 * Calculates the next execution time for a cron expression.
 *
 * Uses intelligent skipping: instead of iterating minute-by-minute,
 * jumps directly to the next valid value at each granularity level
 * (minute → hour → day → month → year). Typical expressions resolve
 * in O(1) iterations; worst-case (e.g. weekly) is O(days_in_year).
 *
 * @param cronOrExpression - ParsedCron object or cron expression string (5-field or alias)
 * @param from - Starting date/time
 * @param timezone - IANA timezone
 * @param clock - Optional clock for deterministic behavior
 * @returns Next execution time as Date, or null if impossible
 * @throws RangeError if timezone is invalid
 * @throws Error if no execution found within search limit (~1 year)
 */
export function nextExecutionTime(
  cronOrExpression: ParsedCron | string,
  from: Date,
  timezone: string,
  clock?: Clock,
): Date | null {
  validateTimezone(timezone);
  const cron =
    typeof cronOrExpression === "string" ? parseCronExpression(cronOrExpression) : cronOrExpression;
  const now = clock?.now() ?? from;

  // Pre-sort sets once for efficient next-value lookups
  const sortedMinutes = [...cron.minutes].sort((a, b) => a - b);
  const sortedHours = [...cron.hours].sort((a, b) => a - b);
  const sortedDaysOfMonth = [...cron.daysOfMonth].sort((a, b) => a - b);
  const sortedMonths = [...cron.months].sort((a, b) => a - b);

  // Early exit: detect impossible day-month combinations (e.g., day 31 in February)
  if (isImpossibleCron(sortedDaysOfMonth, sortedMonths)) {
    return null;
  }

  // Start from the next full minute (UTC-aligned)
  let candidate = new Date(now.getTime() + 60_000);
  candidate.setUTCSeconds(0, 0);

  // Safety limit: ~1 year of minutes (should rarely be needed)
  const MAX_ITERATIONS = 525_600;
  let iterations = 0;

  while (true) {
    if (++iterations > MAX_ITERATIONS) {
      return null;
    }

    const { minute, hour, day, month } = getTzComponents(candidate, timezone);
    const dow = getDayOfWeek(candidate, timezone);

    // All components match → found next execution time
    if (
      cron.minutes.has(minute) &&
      cron.hours.has(hour) &&
      cron.daysOfMonth.has(day) &&
      cron.months.has(month) &&
      cron.daysOfWeek.has(dow)
    ) {
      return candidate;
    }

    // Smart advance: jump to next potentially valid time
    candidate = smartAdvance(
      candidate,
      cron,
      timezone,
      sortedMinutes,
      sortedHours,
      sortedDaysOfMonth,
      sortedMonths,
    );
  }
}
