/* global performance */

import { describe, expect, it } from "vitest";
import { DeterministicClock, SystemClock, SYSTEM_CLOCK } from "./clock.js";

describe("SystemClock", () => {
  it("now() returns a valid Date", () => {
    const clock = new SystemClock();
    const result = clock.now();
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).not.toBeNaN();
  });
});

describe("DeterministicClock", () => {
  it("starts with the given initial time", () => {
    const initial = new Date("2025-06-15T10:00:00.000Z");
    const clock = new DeterministicClock(initial);
    expect(clock.now().getTime()).toBe(initial.getTime());
  });

  it("advance(1000) moves forward by 1 second", () => {
    const initial = new Date("2025-06-15T10:00:00.000Z");
    const clock = new DeterministicClock(initial);
    clock.advance(1000);
    expect(clock.now().getTime()).toBe(initial.getTime() + 1000);
  });

  it("advance(0) keeps the same time", () => {
    const initial = new Date("2025-06-15T10:00:00.000Z");
    const clock = new DeterministicClock(initial);
    clock.advance(0);
    expect(clock.now().getTime()).toBe(initial.getTime());
  });

  it("advance(-1) throws an error", () => {
    const initial = new Date("2025-06-15T10:00:00.000Z");
    const clock = new DeterministicClock(initial);
    expect(() => clock.advance(-1)).toThrow("Cannot advance clock by negative duration");
  });

  it("set() to a future time works", () => {
    const initial = new Date("2025-06-15T10:00:00.000Z");
    const clock = new DeterministicClock(initial);
    const future = new Date("2025-06-15T12:00:00.000Z");
    clock.set(future);
    expect(clock.now().getTime()).toBe(future.getTime());
  });

  it("set() to a past time throws an error", () => {
    const initial = new Date("2025-06-15T10:00:00.000Z");
    const clock = new DeterministicClock(initial);
    const past = new Date("2025-06-15T08:00:00.000Z");
    expect(() => clock.set(past)).toThrow("Cannot set clock to a past time");
  });

  it("now() returns a defensive copy (mutating result does not affect subsequent calls)", () => {
    const initial = new Date("2025-06-15T10:00:00.000Z");
    const clock = new DeterministicClock(initial);
    const first = clock.now();
    first.setFullYear(2000);
    const second = clock.now();
    expect(second.getFullYear()).toBe(2025);
  });

  it("completes without setTimeout in under 50ms", () => {
    const initial = new Date("2025-06-15T10:00:00.000Z");
    const clock = new DeterministicClock(initial);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      clock.advance(1);
      clock.now();
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

describe("SYSTEM_CLOCK", () => {
  it("is a working Clock singleton", () => {
    expect(SYSTEM_CLOCK).toBeDefined();
    const result = SYSTEM_CLOCK.now();
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).not.toBeNaN();
  });
});
