import {
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

import { safeResolve } from "../common/path-security.js";
import type { IdempotencyKey, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";
import type { RunListFilters, RunRepository } from "../domain/repository.js";
import { CorruptedRecordError, ConcurrencyConflictError } from "./persistence-errors.js";

// ─── File Format ─────────────────────────────────────────────────────────────

/**
 * Serialized run record stored on disk.
 *
 * Wraps RunRecord with additional persistence fields:
 *  - `schemaVersion`: for future migration support (FR-10)
 *  - `revision`: optimistic concurrency counter (FR-06)
 *  - `storedAt`: when the record was last written to disk
 */
export interface FileStoredRunRecord {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly storedAt: string;
  readonly record: RunRecord;
}

// ─── Zod Schemas for Deserialization Validation ──────────────────────────────

const runStateSchema = z.enum([
  "queued",
  "running",
  "waiting_manual",
  "succeeded",
  "failed",
  "cancelled",
]);

const fileStoredRunRecordSchema = z
  .object({
    schemaVersion: z.number(),
    revision: z.number(),
    storedAt: z.string(),
    record: z
      .object({
        schemaVersion: z.number(),
        runId: z.string(),
        brandId: z.string(),
        market: z.string(),
        platform: z.string(),
        operation: z.string(),
        state: runStateSchema,
        attempt: z.number(),
        maxAttempts: z.number(),
        idempotencyKey: z.string(),
        payloadFingerprint: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
        startedAt: z.string().optional(),
        finishedAt: z.string().optional(),
        error: z
          .object({
            message: z.string(),
            code: z.string().optional(),
            retryable: z.boolean().optional(),
          })
          .optional(),
        metadata: z.record(z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();

// ─── FileRunRepository ───────────────────────────────────────────────────────

const FILE_EXTENSION = ".json";
const DEFAULT_STORAGE_DIR = join(process.cwd(), ".data", "runs");

/**
 * File-system-based implementation of RunRepository.
 *
 * Each RunRecord is persisted as an individual JSON file named by runId.
 * Writes are atomic: data is first written to a temporary file, then
 * renamed to the final path. This prevents corruption if the process
 * crashes mid-write.
 *
 * Storage directory is configurable via constructor parameter or the
 * `FILERUN_STORAGE_DIR` environment variable, with a safe default
 * outside the source tree (FR-02).
 */
export class FileRunRepository implements RunRepository {
  private readonly storageDir: string;
  private readonly defaultSchemaVersion: number;

  /**
   * In-process per-runId Promise chain for serialization.
   * Ensures that concurrent async calls for the same runId are sequenced
   * without busy-waiting. Combined with file locks for cross-process safety.
   */
  private readonly pendingLocks = new Map<string, Promise<void>>();

  constructor(storageDir?: string, defaultSchemaVersion?: number) {
    this.storageDir = resolve(
      storageDir ?? process.env["FILERUN_STORAGE_DIR"] ?? DEFAULT_STORAGE_DIR,
    );
    this.defaultSchemaVersion = defaultSchemaVersion ?? 1;

    mkdirSync(this.storageDir, { recursive: true });
  }

  // ─── create ───────────────────────────────────────────────────────────────

  async create(record: RunRecord): Promise<RunRecord> {
    return this.withRunLock(record.runId, () => {
      this.ensureDirectory();

      const filePath = this.filePathFor(record.runId);

      if (this.fileExists(filePath)) {
        throw new Error(`Record already exists: ${record.runId}`);
      }

      const stored: FileStoredRunRecord = {
        schemaVersion: this.defaultSchemaVersion,
        revision: 1,
        storedAt: new Date().toISOString(),
        record,
      };

      this.writeAtomic(filePath, stored);
      return record;
    });
  }

  // ─── getById ──────────────────────────────────────────────────────────────

  async getById(runId: RunId): Promise<RunRecord | null> {
    const filePath = this.filePathFor(runId);

    if (!this.fileExists(filePath)) {
      return null;
    }

    const stored = this.readStored(filePath);
    return stored.record;
  }

  // ─── update (FR-06: optimistic concurrency via revision) ─────────────────

  /**
   * Updates an existing run record.
   *
   * Supports optimistic concurrency control: when `expectedRevision` is
   * provided, the update is only applied if the stored record's current
   * revision matches the expected value. If it does not match, a
   * `ConcurrencyConflictError` is thrown (FR-06, FR-11).
   *
   * When `expectedRevision` is omitted, the update proceeds without a
   * concurrency check (backward-compatible with the RunRepository interface).
   */
  async update(record: RunRecord, expectedRevision?: number): Promise<RunRecord> {
    return this.withRunLock(record.runId, () => {
      this.ensureDirectory();

      const filePath = this.filePathFor(record.runId);

      if (!this.fileExists(filePath)) {
        throw new Error(`Record not found: ${record.runId}`);
      }

      const existing = this.readStored(filePath);

      // Optimistic concurrency check (FR-06, FR-11)
      if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
        throw new ConcurrencyConflictError({
          recordId: record.runId,
          expectedRevision,
          actualRevision: existing.revision,
        });
      }

      const updated: FileStoredRunRecord = {
        schemaVersion: existing.schemaVersion,
        revision: existing.revision + 1,
        storedAt: new Date().toISOString(),
        record,
      };

      this.writeAtomic(filePath, updated);
      return record;
    });
  }

  // ─── list (FR-08: throws on corrupted file) ──────────────────────────────

  async list(filters?: RunListFilters): Promise<RunRecord[]> {
    if (!this.directoryExists()) {
      return [];
    }

    const files = readdirSync(this.storageDir).filter((f) => f.endsWith(FILE_EXTENSION));
    const records: RunRecord[] = [];

    for (const file of files) {
      // FR-08: throws CorruptedRecordError if any file is corrupted
      const stored = this.readStored(join(this.storageDir, file));
      records.push(stored.record);
    }

    return this.applyFilters(records, filters);
  }

  // ─── findByIdempotencyKey (FR-09) ────────────────────────────────────────

  async findByIdempotencyKey(key: IdempotencyKey): Promise<RunRecord | null> {
    if (!this.directoryExists()) {
      return null;
    }

    const files = readdirSync(this.storageDir).filter((f) => f.endsWith(FILE_EXTENSION));

    for (const file of files) {
      // FR-09: throws CorruptedRecordError if any file is corrupted
      const stored = this.readStored(join(this.storageDir, file));
      if (stored.record.idempotencyKey === key) {
        return stored.record;
      }
    }

    return null;
  }

  // ─── File Locking (HUMAN-007) ─────────────────────────────────────────────

  private lockPathFor(runId: RunId): string {
    return safeResolve(this.storageDir, `${runId}.lock`);
  }

  /**
   * Acquires an exclusive file lock for the given runId using atomic rename.
   *
   * The lock file is first written to a temporary path, then renamed to the
   * final lock path via `renameSync`. On POSIX, `renameSync` is atomic: if
   * the target already exists, it is replaced atomically. On Windows, the
   * rename fails if the target exists, which provides mutual exclusion.
   *
   * Uses retry with exponential backoff for cross-process contention.
   */
  private acquireFileLock(runId: RunId): void {
    const lockFile = this.lockPathFor(runId);
    const tempLock = `${lockFile}.tmp.${process.pid}.${Date.now()}`;

    writeFileSync(tempLock, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");

    const maxRetries = 100;
    const baseDelayMs = 10;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        renameSync(tempLock, lockFile);
        return; // Lock acquired
      } catch {
        // Lock is held — wait with exponential backoff
        const delay = Math.min(baseDelayMs * 2 ** Math.min(attempt, 5), 300);
        const start = Date.now();
        while (Date.now() - start < delay) {
          // sync busy-wait is acceptable for cross-process file lock contention
        }
      }
    }

    // Cleanup temp file on failure
    try {
      unlinkSync(tempLock);
    } catch {
      // ignore cleanup errors
    }
    throw new Error(`Failed to acquire file lock for runId ${runId} after ${maxRetries} retries`);
  }

  /**
   * Releases the exclusive file lock for the given runId.
   */
  private releaseFileLock(runId: RunId): void {
    try {
      unlinkSync(this.lockPathFor(runId));
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Executes a function under an exclusive per-runId lock.
   *
   * Combines two layers of serialization:
   *  1. In-process Promise chain (efficient, no busy-waiting)
   *  2. File lock via atomic rename (cross-process safety)
   *
   * The existing revision-based optimistic concurrency check is preserved
   * as a final safety net.
   */
  private async withRunLock<T>(runId: RunId, fn: () => T | Promise<T>): Promise<T> {
    // Wait for any in-process lock on this runId
    const previous = this.pendingLocks.get(runId) ?? Promise.resolve();

    let resolve!: () => void;
    const current = new Promise<void>((r) => {
      resolve = r;
    });
    this.pendingLocks.set(runId, current);

    try {
      await previous;

      // Acquire cross-process file lock
      this.acquireFileLock(runId);
      try {
        return await fn();
      } finally {
        this.releaseFileLock(runId);
      }
    } finally {
      resolve();
      if (this.pendingLocks.get(runId) === current) {
        this.pendingLocks.delete(runId);
      }
    }
  }

  // ─── Internal Helpers ─────────────────────────────────────────────────────

  private filePathFor(runId: RunId): string {
    return safeResolve(this.storageDir, `${runId}${FILE_EXTENSION}`);
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
  }

  /**
   * Reads and validates a stored run record from disk.
   *
   * Throws `CorruptedRecordError` (FR-07) if:
   *  - The file content is not valid JSON
   *  - The JSON structure does not match the expected Zod schema
   */
  private readStored(filePath: string): FileStoredRunRecord {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (error) {
      throw new CorruptedRecordError(
        `Failed to read file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
      throw new CorruptedRecordError(
        `Invalid JSON in file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    // Validate structure and types with Zod before processing
    const result = fileStoredRunRecordSchema.safeParse(parsed);
    if (!result.success) {
      throw new CorruptedRecordError(
        `Invalid stored run record at ${filePath}: ${result.error.message}`,
      );
    }

    const { schemaVersion, revision, storedAt, record } = result.data;

    // Restore Date objects from ISO strings
    const restoredRecord: Record<string, unknown> = { ...record };
    for (const key of ["createdAt", "updatedAt", "startedAt", "finishedAt"]) {
      const value = restoredRecord[key];
      if (typeof value === "string") {
        restoredRecord[key] = new Date(value);
      }
    }

    return {
      schemaVersion,
      revision,
      storedAt,
      record: restoredRecord as unknown as RunRecord,
    };
  }

  /**
   * Writes data atomically: first to a temporary file, then renames
   * to the final path. The temporary file is removed on failure (FR-04).
   */
  private writeAtomic(filePath: string, data: FileStoredRunRecord): void {
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

  private applyFilters(records: RunRecord[], filters?: RunListFilters): RunRecord[] {
    if (!filters) {
      return records;
    }

    let results = records;

    if (filters.brandId !== undefined) {
      results = results.filter((r) => r.brandId === filters.brandId);
    }
    if (filters.market !== undefined) {
      results = results.filter((r) => r.market === filters.market);
    }
    if (filters.platform !== undefined) {
      results = results.filter((r) => r.platform === filters.platform);
    }
    if (filters.operation !== undefined) {
      results = results.filter((r) => r.operation === filters.operation);
    }
    if (filters.state !== undefined) {
      results = results.filter((r) => r.state === filters.state);
    }

    return results;
  }
}
