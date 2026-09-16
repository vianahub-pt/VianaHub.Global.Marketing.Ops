import type { IdempotencyKey, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";
import type { RunListFilters, RunRepository } from "../domain/repository.js";

// ─── InMemoryRunRepository ───────────────────────────────────────────────────

/**
 * In-memory implementation of RunRepository for testing.
 *
 * Provides all RunRepository methods with simple Map-based storage.
 * No persistence across process boundaries — use only in tests.
 */
export class InMemoryRunRepository implements RunRepository {
  private readonly runs = new Map<string, RunRecord>();

  // ─── create ───────────────────────────────────────────────────────────────

  async create(record: RunRecord): Promise<RunRecord> {
    if (this.runs.has(record.runId)) {
      throw new Error(`Record already exists: ${record.runId}`);
    }
    this.runs.set(record.runId, record);
    return record;
  }

  // ─── getById ──────────────────────────────────────────────────────────────

  async getById(runId: RunId): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  // ─── update ───────────────────────────────────────────────────────────────

  async update(record: RunRecord): Promise<RunRecord> {
    if (!this.runs.has(record.runId)) {
      throw new Error(`Record not found: ${record.runId}`);
    }
    this.runs.set(record.runId, record);
    return record;
  }

  // ─── list ─────────────────────────────────────────────────────────────────

  async list(filters?: RunListFilters): Promise<RunRecord[]> {
    let results = Array.from(this.runs.values());

    if (filters) {
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
    }

    return results;
  }

  // ─── findByIdempotencyKey ─────────────────────────────────────────────────

  async findByIdempotencyKey(key: IdempotencyKey): Promise<RunRecord | null> {
    for (const record of this.runs.values()) {
      if (record.idempotencyKey === key) {
        return record;
      }
    }
    return null;
  }
}
