/**
 * File-based alert emitter (MVP).
 *
 * Persists alerts as individual JSON files in .data/alerts/.
 * Pattern follows FileAuditRepository:
 * - One file per alert
 * - Filename: {ISO-timestamp}_{alertId}.json
 * - Atomic writes (temp + rename)
 * - Path traversal protection via safeResolve
 */

import {
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import type { AlertEmitter, AlertHandler } from "../domain/alert-emitter.js";
import type { AlertEntry } from "../domain/alert-schema.js";
import { alertEntrySchema } from "../domain/alert-schema.js";
import { redactLog } from "../domain/redaction.js";
import { safeResolve } from "../common/path-security.js";
import type { Clock } from "../domain/clock.js";
import { SYSTEM_CLOCK } from "../domain/clock.js";

// --- File Naming ---

function alertFilename(alert: AlertEntry): string {
  const ts = alert.timestamp.toISOString().replace(/[:.]/g, "-");
  return `${ts}_${alert.alertId}.json`;
}

// --- Constants ---

const FILE_EXTENSION = ".json";
const DEFAULT_STORAGE_DIR = join(process.cwd(), ".data", "alerts");

/**
 * Creates a file-based AlertEmitter.
 *
 * Wraps an existing AlertEmitter and subscribes a file-persistence handler.
 * Each alert is persisted as an individual JSON file with atomic writes.
 */
export function createFileAlertEmitter(
  inner: AlertEmitter,
  baseDir?: string,
  _clock: Clock = SYSTEM_CLOCK,
): AlertEmitter {
  const storageDir = resolve(
    baseDir ?? process.env["FILEALERT_STORAGE_DIR"] ?? DEFAULT_STORAGE_DIR,
  );
  mkdirSync(storageDir, { recursive: true });

  const fileHandler: AlertHandler = (alert: AlertEntry) => {
    // Redact metadata before persistence
    const redactedMetadata = alert.metadata ? redactLog(alert.metadata) : undefined;

    const persistable: AlertEntry = {
      ...alert,
      metadata: redactedMetadata,
    };

    // Validate
    alertEntrySchema.parse(persistable);

    // Atomic write
    const filename = alertFilename(persistable);
    const filePath = safeResolve(storageDir, filename);
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;

    try {
      writeFileSync(tempPath, JSON.stringify(persistable, null, 2), "utf8");
      renameSync(tempPath, filePath);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      // Alert persistence failure must not break the emitter
      process.stderr.write(
        `[file-alert-emitter] Failed to persist alert ${alert.alertId}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };

  inner.subscribe(fileHandler);
  return inner;
}

/**
 * Reads all persisted alerts from the storage directory.
 * Skips corrupted files (defensive).
 */
export function readPersistedAlerts(baseDir: string): AlertEntry[] {
  const storageDir = resolve(baseDir);

  let entries: string[];
  try {
    entries = readdirSync(storageDir);
  } catch {
    return [];
  }

  const files = entries.filter((f) => f.endsWith(FILE_EXTENSION) && !f.endsWith(".tmp"));
  const results: AlertEntry[] = [];

  for (const file of files) {
    try {
      const filePath = join(storageDir, file);
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      parsed["timestamp"] = new Date(parsed["timestamp"] as string);
      const validated = alertEntrySchema.parse(parsed) as AlertEntry;
      results.push(validated);
    } catch {
      // Skip corrupted files
      continue;
    }
  }

  return results.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}
