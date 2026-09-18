import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

import { safeResolve } from "../common/path-security.js";
import type { RunId } from "../domain/idempotency.js";
import type { CheckpointDto, CheckpointRepository } from "./checkpoint-repository.js";
import { CorruptedRecordError } from "./persistence-errors.js";

// ─── File Format ─────────────────────────────────────────────────────────────

interface FileStoredCheckpoint {
  readonly schemaVersion: number;
  readonly data: CheckpointDto;
}

// ─── Zod Schema for Deserialization Validation ───────────────────────────────

const runStateSchema = z.enum([
  "queued",
  "running",
  "waiting_manual",
  "succeeded",
  "failed",
  "cancelled",
]);

const fileStoredCheckpointSchema = z
  .object({
    schemaVersion: z.number(),
    data: z
      .object({
        runId: z.string(),
        state: runStateSchema,
        attempt: z.number(),
        payload: z.record(z.unknown()),
        createdAt: z.string(),
      })
      .strict(),
  })
  .strict();

// ─── FileCheckpointRepository ────────────────────────────────────────────────

const FILE_EXTENSION = ".json";
const DEFAULT_STORAGE_DIR = join(process.cwd(), ".data", "checkpoints");

/**
 * File-system-based implementation of CheckpointRepository.
 *
 * Each checkpoint is persisted as an individual JSON file named by
 * `<runId>-<timestamp>.json`. Writes are atomic: data is first
 * written to a temporary file, then renamed to the final path.
 */
export class FileCheckpointRepository implements CheckpointRepository {
  private readonly storageDir: string;

  constructor(storageDir?: string) {
    this.storageDir = resolve(
      storageDir ?? process.env["FILECHECKPOINT_STORAGE_DIR"] ?? DEFAULT_STORAGE_DIR,
    );
    mkdirSync(this.storageDir, { recursive: true });
  }

  // ─── create ───────────────────────────────────────────────────────────────

  async create(checkpoint: CheckpointDto): Promise<CheckpointDto> {
    this.ensureDirectory();

    const fileName = this.fileNameFor(checkpoint);
    const filePath = safeResolve(this.storageDir, fileName);

    const stored: FileStoredCheckpoint = {
      schemaVersion: 1,
      data: checkpoint,
    };

    this.writeAtomic(filePath, stored);
    return checkpoint;
  }

  // ─── getLatest (CK-05) ───────────────────────────────────────────────────

  /**
   * Returns the most recent checkpoint for a given run.
   *
   * For `waiting_manual` checkpoints, the payload includes the context
   * of the manual action that is required (CK-05).
   */
  async getLatest(runId: RunId): Promise<CheckpointDto | null> {
    const all = await this.listByRunId(runId);
    return all.length > 0 ? all[all.length - 1] : null;
  }

  // ─── listByRunId (CK-04: throws on corrupted file) ───────────────────────

  async listByRunId(runId: RunId): Promise<CheckpointDto[]> {
    if (!this.directoryExists()) {
      return [];
    }

    const prefix = `${runId}-`;
    const files = readdirSync(this.storageDir).filter(
      (f) => f.endsWith(FILE_EXTENSION) && f.startsWith(prefix),
    );

    const checkpoints: CheckpointDto[] = [];

    for (const file of files) {
      // CK-04: throws CorruptedRecordError if any file is corrupted
      const stored = this.readStored(safeResolve(this.storageDir, file));
      checkpoints.push(stored.data);
    }

    // Sort by createdAt ascending; use attempt as tiebreaker to preserve insertion order for same timestamps
    return checkpoints.sort((a, b) => {
      const cmp = a.createdAt.localeCompare(b.createdAt);
      if (cmp !== 0) {
        return cmp;
      }
      return a.attempt - b.attempt;
    });
  }

  // ─── Internal Helpers ─────────────────────────────────────────────────────

  private fileNameFor(checkpoint: CheckpointDto): string {
    const timestamp = checkpoint.createdAt.replace(/[:.]/g, "-");
    const basePrefix = `${checkpoint.runId}-${timestamp}`;

    // Check for existing files with the same prefix to avoid collision
    if (this.directoryExists()) {
      const existing = readdirSync(this.storageDir).filter(
        (f) => f.startsWith(basePrefix) && f.endsWith(FILE_EXTENSION),
      );
      if (existing.length > 0) {
        // Append sequence number to ensure uniqueness
        return `${basePrefix}-${existing.length}${FILE_EXTENSION}`;
      }
    }

    return `${basePrefix}${FILE_EXTENSION}`;
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
   * Reads and validates a stored checkpoint from disk.
   *
   * Throws `CorruptedRecordError` (CK-04) if:
   *  - The file content is not valid JSON
   *  - The JSON structure does not match the expected Zod schema
   */
  private readStored(filePath: string): FileStoredCheckpoint {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (error) {
      throw new CorruptedRecordError(
        `Failed to read checkpoint file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
      throw new CorruptedRecordError(
        `Invalid JSON in checkpoint file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    // Validate structure and types with Zod before returning
    const result = fileStoredCheckpointSchema.safeParse(parsed);
    if (!result.success) {
      throw new CorruptedRecordError(
        `Invalid stored checkpoint at ${filePath}: ${result.error.message}`,
      );
    }

    return result.data as FileStoredCheckpoint;
  }

  /**
   * Writes data atomically: first to a temporary file, then renames
   * to the final path. The temporary file is removed on failure.
   */
  private writeAtomic(filePath: string, data: FileStoredCheckpoint): void {
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
