/**
 * Orphan lock detector (read-only).
 *
 * AC-36: Scans for .lock files and returns diagnostic information.
 * AC-37: RESERVED — no automatic cleanup. Remediation is manual.
 *
 * This module is purely informational. It does NOT authorize,
 * trigger, or perform any automatic deletion, renaming, or
 * modification of lock files.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { safeResolve } from "../common/path-security.js";
import type { Clock } from "../domain/clock.js";
import { SYSTEM_CLOCK } from "../domain/clock.js";

// --- Types ---

export interface OrphanLockInfo {
  /** The filename of the lock file */
  readonly filename: string;
  /** Full path to the lock file */
  readonly fullPath: string;
  /** Apparent age in milliseconds (now - mtime) */
  readonly apparentAgeMs: number;
  /** File contents (typically PID recorded at lock time) */
  readonly contents: string;
  /** Whether the lock appears stale (age > threshold) */
  readonly appearsStale: boolean;
}

export interface OrphanLockScanResult {
  /** Timestamp of the scan */
  readonly scannedAt: Date;
  /** Storage directory scanned */
  readonly storageDir: string;
  /** Lock files found */
  readonly locks: readonly OrphanLockInfo[];
  /** Total count */
  readonly count: number;
}

// --- Constants ---

const LOCK_EXTENSION = ".lock";
const DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// --- Detector ---

/**
 * Scans a directory for orphan .lock files and returns diagnostic information.
 *
 * AC-36: This is purely informational — detection does NOT authorize,
 * trigger, or perform any automatic deletion, renaming, or modification
 * of lock files.
 *
 * AC-37: Orphan lock remediation is explicitly manual. No automatic
 * cleanup code path exists.
 *
 * @param storageDir - Directory to scan for .lock files
 * @param staleThresholdMs - Age threshold to mark as "appears stale" (default: 5 min)
 * @param clock - Clock injection for deterministic testing
 * @returns Scan result with diagnostic information for each lock file
 */
export function detectPotentialOrphanLocks(
  storageDir: string,
  staleThresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
  clock: Clock = SYSTEM_CLOCK,
): OrphanLockScanResult {
  const resolvedDir = resolve(storageDir);
  const now = clock.now();

  let entries: string[];
  try {
    entries = readdirSync(resolvedDir);
  } catch {
    // Directory doesn't exist — no locks
    return {
      scannedAt: now,
      storageDir: resolvedDir,
      locks: [],
      count: 0,
    };
  }

  const lockFiles = entries.filter((f) => f.endsWith(LOCK_EXTENSION));
  const locks: OrphanLockInfo[] = [];

  for (const filename of lockFiles) {
    try {
      const fullPath = safeResolve(resolvedDir, filename);
      const stats = statSync(fullPath);
      const apparentAgeMs = now.getTime() - stats.mtime.getTime();

      let contents = "";
      try {
        contents = readFileSync(fullPath, "utf8").trim();
      } catch {
        contents = "<unreadable>";
      }

      locks.push({
        filename,
        fullPath,
        apparentAgeMs,
        contents,
        appearsStale: apparentAgeMs > staleThresholdMs,
      });
    } catch {
      // Skip files we can't stat (defensive)
      continue;
    }
  }

  return {
    scannedAt: now,
    storageDir: resolvedDir,
    locks,
    count: locks.length,
  };
}
