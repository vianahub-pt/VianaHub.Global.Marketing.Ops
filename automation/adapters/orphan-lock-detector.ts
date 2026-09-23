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

import { readdirSync, openSync, fstatSync, readFileSync, closeSync, statSync } from "node:fs";
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
    let fullPath: string;
    try {
      fullPath = safeResolve(resolvedDir, filename);
    } catch {
      // Path rejected by path-security (e.g. URL-encoded name) — skip, as before
      continue;
    }

    let contents = "";
    let mtimeMs: number | undefined;
    let fd: number | undefined;
    try {
      // Single-open: stats and contents both come from the same handle,
      // removing the stat(path)-then-read(path) TOCTOU window.
      fd = openSync(fullPath, "r");
      const stats = fstatSync(fd);
      mtimeMs = stats.mtime.getTime();
      contents = readFileSync(fd, "utf8").trim();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        // File disappeared between listing and open — skip
        continue;
      }
      // Unreadable (EACCES/EPERM/...) or other read failure:
      // stat after the failed open for the age diagnostic only, with no
      // subsequent read of the path, so the path is never used after check.
      try {
        const stats = statSync(fullPath);
        mtimeMs = stats.mtime.getTime();
      } catch {
        // Not even stat-able — skip defensively
        continue;
      }
      contents = "<unreadable>";
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }

    if (mtimeMs === undefined) {
      continue;
    }

    const apparentAgeMs = now.getTime() - mtimeMs;
    locks.push({
      filename,
      fullPath,
      apparentAgeMs,
      contents,
      appearsStale: apparentAgeMs > staleThresholdMs,
    });
  }

  return {
    scannedAt: now,
    storageDir: resolvedDir,
    locks,
    count: locks.length,
  };
}
