/**
 * Base error for persistence layer issues.
 */
export class PersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersistenceError";
  }
}

/**
 * Thrown when a stored file exists but its content is corrupted
 * (invalid JSON, schema mismatch, etc.) — FR-07, FR-08, CK-04.
 */
export class CorruptedRecordError extends PersistenceError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CorruptedRecordError";
  }
}

/**
 * Thrown when an optimistic concurrency check fails during update.
 * The record on disk has been modified since the caller last read it — FR-06.
 */
export class ConcurrencyConflictError extends PersistenceError {
  readonly expectedRevision: number;
  readonly actualRevision: number;
  readonly recordId: string;

  constructor(
    params: {
      readonly recordId: string;
      readonly expectedRevision: number;
      readonly actualRevision: number;
    },
    options?: ErrorOptions,
  ) {
    super(
      `Concurrency conflict on ${params.recordId}: expected revision ${params.expectedRevision}, found ${params.actualRevision}`,
      options,
    );
    this.name = "ConcurrencyConflictError";
    this.recordId = params.recordId;
    this.expectedRevision = params.expectedRevision;
    this.actualRevision = params.actualRevision;
  }
}
