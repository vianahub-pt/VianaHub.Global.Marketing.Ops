/**
 * File-based schedule repository implementation.
 *
 * Persists schedule records as JSON files with:
 * - Atomic writes (temp + rename)
 * - Locks per scheduleId
 * - Optimistic concurrency via revision field
 * - Path traversal protection via safeResolve
 * - Zod-based deserialization validation (corruption detection)
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
  writeSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

import { safeResolve } from "../common/path-security.js";
import type { ScheduleId, ScheduleRecord } from "../domain/schedule-schema.js";
import type { ScheduleRepository, ScheduleListFilters } from "../domain/schedule-repository.js";
import { CorruptedRecordError, ConcurrencyConflictError } from "./persistence-errors.js";
import { OperationalError, ERROR_CODES } from "../domain/errors.js";

// ─── Zod Schema for Deserialization Validation ──────────────────────────────

const scheduleConfigSchema = z
  .object({
    cron: z.string(),
    timezone: z.string(),
    brandId: z.string(),
    market: z.string(),
    platform: z.string(),
    operation: z.string(),
    enabled: z.boolean(),
    mode: z.enum(["single", "batch"]),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const scheduleRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    scheduleId: z.string(),
    idempotencyKey: z.string(),
    config: scheduleConfigSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    lastRunAt: z.string().optional(),
    nextRunAt: z.string().optional(),
    enabled: z.boolean(),
    revision: z.number().int().min(0),
  })
  .strict();

// ─── Helpers ────────────────────────────────────────────────────────────────

function isNodeError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as Record<string, unknown>).code === "string"
  );
}

// ─── FileScheduleRepository ─────────────────────────────────────────────────

const FILE_EXTENSION = ".json";
const DEFAULT_STORAGE_DIR = join(process.cwd(), ".data", "schedules");

/**
 * File-based implementation of {@link ScheduleRepository}.
 *
 * Each {@link ScheduleRecord} is persisted as an individual JSON file
 * named `<scheduleId>.json`. Writes are atomic: data is first written
 * to a temporary file, then renamed to the final path.
 *
 * Cross-process safety is provided by exclusive lock files using
 * `openSync` with `"wx"` (O_EXCL) in a `.locks` subdirectory.
 *
 * Storage directory is configurable via constructor parameter or the
 * `FILESCHEDULE_STORAGE_DIR` environment variable.
 */
export class FileScheduleRepository implements ScheduleRepository {
  private readonly storageDir: string;
  private readonly locksDir: string;

  /**
   * In-process per-scheduleId Promise chain for serialization.
   * Ensures that concurrent async calls for the same scheduleId are
   * sequenced without busy-waiting. Combined with file locks for
   * cross-process safety.
   */
  private readonly pendingLocks = new Map<string, Promise<void>>();

  constructor(storageDir?: string) {
    this.storageDir = resolve(
      storageDir ?? process.env["FILESCHEDULE_STORAGE_DIR"] ?? DEFAULT_STORAGE_DIR,
    );
    this.locksDir = join(this.storageDir, ".locks");

    mkdirSync(this.storageDir, { recursive: true });
    mkdirSync(this.locksDir, { recursive: true });
  }

  // ─── create ───────────────────────────────────────────────────────────────

  async create(record: ScheduleRecord): Promise<ScheduleRecord> {
    return this.withScheduleLock(record.scheduleId as ScheduleId, () => {
      this.ensureDirectory();

      const filePath = this.filePathFor(record.scheduleId as ScheduleId);

      if (this.fileExists(filePath)) {
        throw new Error(`Record already exists: ${record.scheduleId}`);
      }

      this.writeAtomic(filePath, record);
      return record;
    });
  }

  // ─── getById ──────────────────────────────────────────────────────────────

  async getById(scheduleId: ScheduleId): Promise<ScheduleRecord | null> {
    const filePath = this.filePathFor(scheduleId);

    if (!this.fileExists(filePath)) {
      return null;
    }

    return this.readStored(filePath);
  }

  // ─── update (optimistic concurrency via revision) ─────────────────────────

  async update(record: ScheduleRecord): Promise<ScheduleRecord> {
    return this.withScheduleLock(record.scheduleId as ScheduleId, () => {
      this.ensureDirectory();

      const filePath = this.filePathFor(record.scheduleId as ScheduleId);

      if (!this.fileExists(filePath)) {
        throw new Error(`Record not found: ${record.scheduleId}`);
      }

      const existing = this.readStored(filePath);

      // Optimistic concurrency check
      if (existing.revision !== record.revision) {
        throw new ConcurrencyConflictError({
          recordId: record.scheduleId,
          expectedRevision: record.revision,
          actualRevision: existing.revision,
        });
      }

      // Increment revision and persist
      const updated: ScheduleRecord = { ...record, revision: record.revision + 1 };
      this.writeAtomic(filePath, updated);
      return updated;
    });
  }

  // ─── list ─────────────────────────────────────────────────────────────────

  async list(filters?: ScheduleListFilters): Promise<ScheduleRecord[]> {
    if (!this.directoryExists()) {
      return [];
    }

    const files = readdirSync(this.storageDir).filter((f) => f.endsWith(FILE_EXTENSION));
    const records: ScheduleRecord[] = [];

    for (const file of files) {
      const filePath = join(this.storageDir, file);
      const record = this.readStored(filePath);

      // Apply filters
      if (filters?.brandId && record.config.brandId !== filters.brandId) {
        continue;
      }
      if (filters?.market && record.config.market !== filters.market) {
        continue;
      }
      if (filters?.platform && record.config.platform !== filters.platform) {
        continue;
      }
      if (filters?.enabled !== undefined && record.enabled !== filters.enabled) {
        continue;
      }

      records.push(record);
    }

    return records;
  }

  // ─── findByIdempotencyKey ─────────────────────────────────────────────────

  async findByIdempotencyKey(idempotencyKey: string): Promise<ScheduleRecord | null> {
    if (!this.directoryExists()) {
      return null;
    }

    const files = readdirSync(this.storageDir).filter((f) => f.endsWith(FILE_EXTENSION));

    for (const file of files) {
      const record = this.readStored(join(this.storageDir, file));
      if (record.idempotencyKey === idempotencyKey) {
        return record;
      }
    }

    return null;
  }

  // ─── File Locking (fail-closed, O_EXCL) ──────────────────────────────────

  private lockPathFor(scheduleId: ScheduleId): string {
    return safeResolve(this.locksDir, `${scheduleId}.lock`);
  }

  /**
   * Acquires an exclusive file lock for the given scheduleId using O_EXCL.
   *
   * Lock acquisition is **fail-closed**:
   *  - Uses `openSync` with `"wx"` flag (O_EXCL) which atomically creates
   *    the file only if it does not already exist.
   *  - Never deletes, renames, or replaces an existing lock file.
   *  - On EEXIST (lock contention), throws immediately with actionable error —
   *    no PID checks, no age heuristics, no stale cleanup, no busy-wait retries.
   */
  private acquireFileLock(scheduleId: ScheduleId): void {
    const lockFile = this.lockPathFor(scheduleId);

    let fd: number | undefined;
    try {
      fd = openSync(lockFile, "wx");
      writeSync(fd, String(process.pid), null, "utf8");
      closeSync(fd);
      fd = undefined;
      return;
    } catch (error: unknown) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* close may fail if fd was already closed — ignore */
        }
        fd = undefined;
      }

      if (isNodeError(error) && error.code === "EEXIST") {
        throw new OperationalError({
          code: ERROR_CODES.LOCK_CONTENTION,
          message: `Lock contention for scheduleId: ${scheduleId}`,
          action: "Runbook: docs/runbook.md#lock-contention",
          context: { scheduleId },
        });
      }

      throw error;
    }
  }

  /**
   * Releases the exclusive file lock for the given scheduleId.
   * Only ENOENT (lock already released) is silently ignored.
   */
  private releaseFileLock(scheduleId: ScheduleId): void {
    try {
      unlinkSync(this.lockPathFor(scheduleId));
    } catch (error: unknown) {
      if (isNodeError(error) && error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  /**
   * Executes a function under an exclusive per-scheduleId lock.
   *
   * Combines two layers of serialization:
   *  1. In-process Promise chain (efficient, no busy-waiting)
   *  2. File lock via O_EXCL atomic creation (cross-process safety)
   */
  private async withScheduleLock<T>(scheduleId: ScheduleId, fn: () => T | Promise<T>): Promise<T> {
    const previous = this.pendingLocks.get(scheduleId) ?? Promise.resolve();

    let resolve!: () => void;
    const current = new Promise<void>((r) => {
      resolve = r;
    });
    this.pendingLocks.set(scheduleId, current);

    try {
      await previous;

      this.acquireFileLock(scheduleId);
      try {
        return await fn();
      } finally {
        this.releaseFileLock(scheduleId);
      }
    } finally {
      resolve();
      if (this.pendingLocks.get(scheduleId) === current) {
        this.pendingLocks.delete(scheduleId);
      }
    }
  }

  // ─── Internal Helpers ─────────────────────────────────────────────────────

  private filePathFor(scheduleId: ScheduleId): string {
    return safeResolve(this.storageDir, `${scheduleId}${FILE_EXTENSION}`);
  }

  private fileExists(filePath: string): boolean {
    try {
      statSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private directoryExists(): boolean {
    try {
      readdirSync(this.storageDir);
      return true;
    } catch {
      return false;
    }
  }

  private ensureDirectory(): void {
    mkdirSync(this.storageDir, { recursive: true });
    mkdirSync(this.locksDir, { recursive: true });
  }

  /**
   * Reads and validates a stored schedule record from disk.
   *
   * Throws `CorruptedRecordError` if:
   *  - The file content is not valid JSON
   *  - The JSON structure does not match the expected Zod schema
   */
  private readStored(filePath: string): ScheduleRecord {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (error) {
      throw new CorruptedRecordError(
        `Failed to read schedule file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
      throw new CorruptedRecordError(
        `Invalid JSON in schedule file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    // Validate structure and types with Zod before processing
    const result = scheduleRecordSchema.safeParse(parsed);
    if (!result.success) {
      throw new CorruptedRecordError(
        `Invalid stored schedule record at ${filePath}: ${result.error.message}`,
      );
    }

    // Restore Date objects from ISO strings
    const data = result.data;
    return {
      schemaVersion: data.schemaVersion,
      scheduleId: data.scheduleId as ScheduleId,
      idempotencyKey: data.idempotencyKey,
      config: data.config,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
      lastRunAt: data.lastRunAt ? new Date(data.lastRunAt) : undefined,
      nextRunAt: data.nextRunAt ? new Date(data.nextRunAt) : undefined,
      enabled: data.enabled,
      revision: data.revision,
    } as ScheduleRecord;
  }

  /**
   * Writes data atomically: first to a temporary file, then renames
   * to the final path. The temporary file is removed on failure.
   */
  private writeAtomic(filePath: string, data: ScheduleRecord): void {
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;

    try {
      writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
      renameSync(tempPath, filePath);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }
}
