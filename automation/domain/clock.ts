/**
 * Clock abstraction for deterministic testing.
 *
 * All temporal components should accept a Clock instance
 * instead of calling Date.now() directly.
 */

/**
 * Clock interface for dependency injection.
 */
export interface Clock {
  /** Returns the current date/time. */
  now(): Date;
}

/**
 * System clock using real Date.now().
 * Use in production code.
 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * Deterministic clock for testing.
 * Allows manual control of time progression.
 */
export class DeterministicClock implements Clock {
  private currentTime: number;

  constructor(initial: Date) {
    this.currentTime = initial.getTime();
  }

  now(): Date {
    return new Date(this.currentTime);
  }

  /**
   * Advance the clock by the specified milliseconds.
   * @param ms - Milliseconds to advance (must be >= 0)
   * @throws Error if ms is negative
   */
  advance(ms: number): void {
    if (ms < 0) {
      throw new Error("Cannot advance clock by negative duration");
    }
    this.currentTime += ms;
  }

  /**
   * Set the clock to a specific time.
   * @param time - The time to set
   * @throws Error if time is in the past
   */
  set(time: Date): void {
    if (time.getTime() < this.currentTime) {
      throw new Error("Cannot set clock to a past time");
    }
    this.currentTime = time.getTime();
  }
}

/**
 * Singleton system clock for production use.
 */
export const SYSTEM_CLOCK: Clock = new SystemClock();
