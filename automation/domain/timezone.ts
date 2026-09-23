/**
 * Timezone utilities for IANA timezone support.
 *
 * Provides deterministic timezone-aware date components
 * and DST-safe date construction.
 */

/**
 * Date components in a specific timezone.
 */
export interface TzDateComponents {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
}

/**
 * Cache for Intl.DateTimeFormat formatters.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

/**
 * Gets date components in the specified timezone.
 *
 * @param date - The date to decompose
 * @param timezone - IANA timezone string
 * @returns Date components in the timezone
 * @throws RangeError if timezone is invalid
 */
export function getTzComponents(date: Date, timezone: string): TzDateComponents {
  const formatter = getFormatter(timezone);
  const parts = formatter.formatToParts(date);

  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) {
      throw new Error(`Missing part: ${type}`);
    }
    return parseInt(part.value, 10);
  };

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Builds a Date from timezone components.
 *
 * Handles DST gaps by advancing to the next valid time.
 * Handles DST ambiguities by returning the first occurrence.
 *
 * @param components - Date components in the target timezone
 * @param timezone - IANA timezone string
 * @returns Date object representing the specified time
 * @throws RangeError if timezone is invalid
 */
export function buildEpochFromTzComponents(components: TzDateComponents, timezone: string): Date {
  const { year, month, day, hour, minute, second } = components;

  // Initial guess: assume standard offset
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  // Get components of the guess in the target timezone
  const guessComponents = getTzComponents(guess, timezone);

  // Calculate offset difference
  const guessAsUtc = Date.UTC(
    guessComponents.year,
    guessComponents.month - 1,
    guessComponents.day,
    guessComponents.hour,
    guessComponents.minute,
    guessComponents.second,
  );
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMs = guessAsUtc - targetAsUtc;

  // Apply offset correction
  const corrected = new Date(guess.getTime() - offsetMs);

  // Verify correction (handle DST transitions)
  const correctedComponents = getTzComponents(corrected, timezone);
  const correctedAsUtc = Date.UTC(
    correctedComponents.year,
    correctedComponents.month - 1,
    correctedComponents.day,
    correctedComponents.hour,
    correctedComponents.minute,
    correctedComponents.second,
  );

  // DST gap: time doesn't exist, advance to next valid hour
  if (correctedAsUtc !== targetAsUtc) {
    const diffMs = correctedAsUtc - targetAsUtc;
    if (Math.abs(diffMs) === 3600_000) {
      return new Date(corrected.getTime() + 3600_000);
    }
  }

  // DST ambiguity: check if subtracting 1 hour also maps to the same local time
  // If so, return the earlier occurrence (first/summer time)
  const earlier = new Date(corrected.getTime() - 3600_000);
  const earlierComponents = getTzComponents(earlier, timezone);

  if (
    earlierComponents.year === year &&
    earlierComponents.month === month &&
    earlierComponents.day === day &&
    earlierComponents.hour === hour &&
    earlierComponents.minute === minute
  ) {
    return earlier;
  }

  return corrected;
}

/**
 * Validates an IANA timezone string.
 *
 * @param timezone - Timezone to validate
 * @returns true if valid, false otherwise
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
