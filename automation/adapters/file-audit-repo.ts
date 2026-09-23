/**
 * File-based audit repository implementation.
 *
 * Persists audit entries as individual JSON files with:
 * - One file per entry (AC-23)
 * - Filename: {ISO-timestamp}_{entryId}.json
 * - Atomic writes (temp + rename)
 * - Path traversal protection via safeResolve
 * - Redaction of sensitive metadata before persistence (AC-26)
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";

import type { AuditCategory, AuditEntry, AuditCorrelationIds } from "../domain/audit-entry.js";
import { auditEntrySchema, redactAuditEntry } from "../domain/audit-entry.js";
import type { AuditRepository, AuditTimeRange } from "../domain/audit-repository.js";
import type { Clock } from "../domain/clock.js";
import { SYSTEM_CLOCK } from "../domain/clock.js";
import { safeResolve } from "../common/path-security.js";

// --- File Naming ---

/**
 * Generates a filename for an audit entry.
 * Format: {ISO-timestamp}_{entryId}.json
 */
function auditFilename(entry: AuditEntry): string {
  const ts = entry.timestamp.toISOString().replace(/[:.]/g, "-");
  return `${ts}_${entry.entryId}.json`;
}

// --- Helpers ---

function _isNodeError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as Record<string, unknown>).code === "string"
  );
}

// --- FileAuditRepository ---

const FILE_EXTENSION = ".json";
const DEFAULT_STORAGE_DIR = join(process.cwd(), ".data", "audit");

/**
 * File-based implementation of {@link AuditRepository}.
 *
 * Each {@link AuditEntry} is persisted as an individual JSON file
 * named `<ISO-timestamp>_<entryId>.json`. Writes are atomic: data is
 * first written to a temporary file, then renamed to the final path.
 *
 * Storage directory is configurable via constructor parameter or the
 * `FILEAUDIT_STORAGE_DIR` environment variable.
 */
export class FileAuditRepository implements AuditRepository {
  private readonly baseDir: string;
  private readonly clock: Clock;

  constructor(baseDir?: string, clock: Clock = SYSTEM_CLOCK) {
    this.baseDir = resolve(baseDir ?? process.env["FILEAUDIT_STORAGE_DIR"] ?? DEFAULT_STORAGE_DIR);
    this.clock = clock;

    mkdirSync(this.baseDir, { recursive: true });
  }

  // --- append (AC-23, AC-26) ---

  async append(entry: AuditEntry): Promise<AuditEntry> {
    // AC-26: Redact before persistence
    const redacted = redactAuditEntry(entry);

    // Validate the redacted entry
    auditEntrySchema.parse(redacted);

    // Ensure directory exists
    this.ensureDirectory();

    // Atomic write: temp + rename
    const filename = auditFilename(redacted);
    const filePath = safeResolve(this.baseDir, filename);

    this.writeAtomic(filePath, redacted);

    return redacted;
  }

  // --- listByCorrelation ---

  async listByCorrelation(correlationIds: AuditCorrelationIds): Promise<readonly AuditEntry[]> {
    const all = this.readAll();
    return all
      .filter((entry) => {
        const ids = entry.correlationIds;
        return (
          (correlationIds.runId !== undefined && ids.runId === correlationIds.runId) ||
          (correlationIds.scheduleId !== undefined &&
            ids.scheduleId === correlationIds.scheduleId) ||
          (correlationIds.batchId !== undefined && ids.batchId === correlationIds.batchId)
        );
      })
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  // --- listByTimeRange ---

  async listByTimeRange(range: AuditTimeRange): Promise<readonly AuditEntry[]> {
    const all = this.readAll();
    const fromMs = range.from.getTime();
    const toMs = range.to.getTime();
    return all
      .filter((e) => {
        const t = e.timestamp.getTime();
        return t >= fromMs && t <= toMs;
      })
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  // --- listByCategory ---

  async listByCategory(category: AuditCategory): Promise<readonly AuditEntry[]> {
    const all = this.readAll();
    return all
      .filter((e) => e.category === category)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  // --- Internal ---

  private readAll(): AuditEntry[] {
    if (!this.directoryExists()) {
      return [];
    }

    const entries = readdirSync(this.baseDir);
    const files = entries.filter((f) => f.endsWith(FILE_EXTENSION) && !f.endsWith(".tmp"));

    const results: AuditEntry[] = [];
    for (const file of files) {
      try {
        const filePath = safeResolve(this.baseDir, file);
        const raw = readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // Reconstitute Date objects
        parsed["timestamp"] = new Date(parsed["timestamp"] as string);
        const validated = auditEntrySchema.parse(parsed) as AuditEntry;
        results.push(validated);
      } catch {
        // Skip corrupted files (defensive)
        continue;
      }
    }

    return results;
  }

  private directoryExists(): boolean {
    try {
      readdirSync(this.baseDir);
      return true;
    } catch {
      return false;
    }
  }

  private ensureDirectory(): void {
    mkdirSync(this.baseDir, { recursive: true });
  }

  /**
   * Writes data atomically: first to a temporary file, then renames
   * to the final path. The temporary file is removed on failure.
   */
  private writeAtomic(filePath: string, data: AuditEntry): void {
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;

    try {
      writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
      renameSync(tempPath, filePath);
    } catch (error) {
      // Clean up temp file on failure
      try {
        unlinkSync(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }
}
