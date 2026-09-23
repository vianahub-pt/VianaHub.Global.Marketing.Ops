import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectPotentialOrphanLocks } from "./orphan-lock-detector.js";
import { DeterministicClock } from "../domain/clock.js";

describe("detectPotentialOrphanLocks", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `orphan-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // AC-36 Test 1: Returns empty when directory does not exist
  it("should return empty result when directory does not exist", () => {
    const nonExistentDir = join(testDir, "nonexistent");
    const clock = new DeterministicClock(new Date("2026-01-01T00:00:00Z"));

    const result = detectPotentialOrphanLocks(nonExistentDir, 5 * 60 * 1000, clock);

    expect(result.locks).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.storageDir).toBe(nonExistentDir);
    expect(result.scannedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
  });

  // AC-36 Test 2: Returns empty when no .lock files exist
  it("should return empty result when no .lock files exist", () => {
    writeFileSync(join(testDir, "regular-file.txt"), "content");
    writeFileSync(join(testDir, "another.json"), "{}");
    const clock = new DeterministicClock(new Date("2026-01-01T00:00:00Z"));

    const result = detectPotentialOrphanLocks(testDir, 5 * 60 * 1000, clock);

    expect(result.locks).toEqual([]);
    expect(result.count).toBe(0);
  });

  // AC-36 Test 3: Detects .lock file and returns diagnostic information
  it("should detect .lock file and return diagnostic information", () => {
    const lockFile = join(testDir, "process.lock");
    writeFileSync(lockFile, "12345");
    const clock = new DeterministicClock(new Date("2026-01-01T00:05:00Z"));

    const result = detectPotentialOrphanLocks(testDir, 5 * 60 * 1000, clock);

    expect(result.count).toBe(1);
    expect(result.locks).toHaveLength(1);
    expect(result.locks[0].filename).toBe("process.lock");
    expect(result.locks[0].contents).toBe("12345");
  });

  // AC-36 Test 4: filename, fullPath, contents are correct
  it("should return correct filename, fullPath, and contents", () => {
    const lockFile = join(testDir, "my-lock.lock");
    writeFileSync(lockFile, "pid-9876");
    const clock = new DeterministicClock(new Date("2026-01-01T00:00:00Z"));

    const result = detectPotentialOrphanLocks(testDir, 5 * 60 * 1000, clock);

    expect(result.locks[0].filename).toBe("my-lock.lock");
    expect(result.locks[0].fullPath).toBe(lockFile);
    expect(result.locks[0].contents).toBe("pid-9876");
  });

  // AC-36 Test 5: apparentAgeMs calculated correctly with Clock
  it("should calculate apparentAgeMs correctly using Clock", () => {
    const lockFile = join(testDir, "age-test.lock");
    writeFileSync(lockFile, "content");

    // Set file mtime to a known past time
    const fileMtime = new Date("2026-01-01T00:00:00Z");
    utimesSync(lockFile, fileMtime, fileMtime);

    // Set clock to 2 minutes after file mtime
    const clock = new DeterministicClock(new Date("2026-01-01T00:02:00Z"));

    const result = detectPotentialOrphanLocks(testDir, 5 * 60 * 1000, clock);

    // apparentAgeMs = now - mtime = 2 minutes = 120000ms
    expect(result.locks[0].apparentAgeMs).toBe(120_000);
    expect(result.locks[0].apparentAgeMs).toBeGreaterThanOrEqual(0);
  });

  // AC-36 Test 6: appearsStale = true when age > threshold
  it("should set appearsStale = true when age exceeds threshold", () => {
    const lockFile = join(testDir, "stale.lock");
    writeFileSync(lockFile, "old-process");

    // File mtime will be "now" (when written)
    // Set clock to 10 minutes in the future
    const futureTime = new Date(Date.now() + 10 * 60 * 1000);
    const clock = new DeterministicClock(futureTime);

    const result = detectPotentialOrphanLocks(testDir, 5 * 60 * 1000, clock);

    expect(result.locks[0].appearsStale).toBe(true);
    expect(result.locks[0].apparentAgeMs).toBeGreaterThan(5 * 60 * 1000);
  });

  // AC-36 Test 7: appearsStale = false when age < threshold
  it("should set appearsStale = false when age is below threshold", () => {
    const lockFile = join(testDir, "fresh.lock");
    writeFileSync(lockFile, "new-process");

    // File mtime will be "now" (when written)
    // Set clock to 1 minute in the future
    const futureTime = new Date(Date.now() + 1 * 60 * 1000);
    const clock = new DeterministicClock(futureTime);

    const result = detectPotentialOrphanLocks(testDir, 5 * 60 * 1000, clock);

    expect(result.locks[0].appearsStale).toBe(false);
    expect(result.locks[0].apparentAgeMs).toBeLessThan(5 * 60 * 1000);
  });

  // AC-36 Test 8: Configurable threshold
  it("should respect configurable stale threshold", () => {
    const lockFile = join(testDir, "threshold-test.lock");
    writeFileSync(lockFile, "content");

    // Set clock to 3 minutes in the future
    const futureTime = new Date(Date.now() + 3 * 60 * 1000);
    const clock = new DeterministicClock(futureTime);

    // With threshold of 2 minutes, should be stale
    const result1 = detectPotentialOrphanLocks(testDir, 2 * 60 * 1000, clock);
    expect(result1.locks[0].appearsStale).toBe(true);

    // With threshold of 5 minutes, should NOT be stale
    const result2 = detectPotentialOrphanLocks(testDir, 5 * 60 * 1000, clock);
    expect(result2.locks[0].appearsStale).toBe(false);
  });

  // AC-36 Test 9: Does NOT modify any .lock files
  it("should NOT modify any .lock files during scan", () => {
    const lockFile = join(testDir, "immutable.lock");
    const originalContent = "original-pid-123";
    writeFileSync(lockFile, originalContent);
    const clock = new DeterministicClock(new Date("2026-01-01T00:00:00Z"));

    // Run detection multiple times
    detectPotentialOrphanLocks(testDir, 5 * 60 * 1000, clock);
    detectPotentialOrphanLocks(testDir, 5 * 60 * 1000, clock);
    detectPotentialOrphanLocks(testDir, 5 * 60 * 1000, clock);

    // Verify file content unchanged
    const currentContent = readFileSync(lockFile, "utf8");
    expect(currentContent).toBe(originalContent);
  });

  // AC-36 Test 10: Handles unreadable .lock file (contents = "<unreadable>")
  it("should handle unreadable .lock file with contents = '<unreadable>'", () => {
    const lockFile = join(testDir, "unreadable.lock");
    writeFileSync(lockFile, "content");

    // Make file unreadable (skip on Windows where chmod doesn't work the same way)
    if (process.platform !== "win32") {
      chmodSync(lockFile, 0o000);
    }

    const clock = new DeterministicClock(new Date("2026-01-01T00:00:00Z"));

    const result = detectPotentialOrphanLocks(testDir, 5 * 60 * 1000, clock);

    // On Windows, file will be readable, so contents won't be "<unreadable>"
    // On Linux/macOS with chmod 000, it should be "<unreadable>"
    if (process.platform !== "win32") {
      expect(result.locks[0].contents).toBe("<unreadable>");
    } else {
      // On Windows, verify the file was at least detected
      expect(result.count).toBe(1);
      expect(result.locks[0].filename).toBe("unreadable.lock");
    }

    // Restore permissions for cleanup on non-Windows
    if (process.platform !== "win32") {
      chmodSync(lockFile, 0o644);
    }
  });
});
