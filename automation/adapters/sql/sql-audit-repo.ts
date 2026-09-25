/**
 * SQL Server implementation of AuditRepository (Sprint 5 — I-3d, AC-33..AC-35).
 *
 * Rows map to `dbo.AuditEntries` (database/migrations/001_initial_schema.sql):
 *
 * - **Append-only (AC-33):** this adapter never issues UPDATE or DELETE
 *   against `dbo.AuditEntries`. Audit entries are immutable once written;
 *   only INSERT and SELECT statements are used.
 * - **Filters (AC-34):** parity with {@link FileAuditRepository} — category,
 *   action, RunId, ScheduleId, BatchId and time-range filters use
 *   sentinel-free `(@x = N'' OR col = @x)` predicates for optional string
 *   columns. Ordering is deterministic: `ORDER BY [Timestamp] ASC,
 *   EntryId ASC`.
 * - **JSON validation (AC-35):** `dbo.AuditEntries` enforces `CHECK
 *   (ISJSON(MetadataJson) = 1)` at the DDL level. On read, `parseJsonColumn`
 *   raises `CorruptedRecordError` for unparseable JSON, providing
 *   application-level validation parity.
 * - SQL 100% parameterized (AC-36): statements are static exported
 *   constants; `Date` values are bound as `DateTime2(3)` by `sql-pool.ts`.
 * - Executor failures propagate as `SqlExecutorError` (error-mapping.ts).
 */

import type {
  AuditCategory,
  AuditCorrelationIds,
  AuditEntry,
  AuditEntryId,
} from "../../domain/audit-entry.js";
import { auditEntrySchema, redactAuditEntry } from "../../domain/audit-entry.js";
import type {
  AuditListFilters,
  AuditRepository,
  AuditTimeRange,
} from "../../domain/audit-repository.js";
import { CorruptedRecordError } from "../persistence-errors.js";
import type { SqlExecutor, SqlQueryResult } from "./sql-pool.js";
import { parseJsonColumn, rowToObject, toDate, toOptionalString } from "./sql-row-helpers.js";

// ─── Static statements (AC-36: no interpolation, no concatenation) ───────────

export const INSERT_AUDIT_ENTRY_SQL =
  "INSERT INTO dbo.AuditEntries (EntryId, [Timestamp], Category, Action, Actor, RunId, ScheduleId, BatchId, PreviousState, NewState, MetadataJson) VALUES (@entryId, @timestamp, @category, @action, @actor, @runId, @scheduleId, @batchId, @previousState, @newState, @metadataJson)";

export const SELECT_AUDIT_ENTRIES_SQL =
  "SELECT EntryId, [Timestamp], Category, Action, Actor, RunId, ScheduleId, BatchId, PreviousState, NewState, MetadataJson FROM dbo.AuditEntries WHERE (@category = N'' OR Category = @category) AND (@action = N'' OR Action = @action) AND (@runId = N'' OR RunId = @runId) AND (@scheduleId = N'' OR ScheduleId = @scheduleId) AND (@batchId = N'' OR BatchId = @batchId) AND (@since IS NULL OR [Timestamp] >= @since) AND (@until IS NULL OR [Timestamp] <= @until) ORDER BY [Timestamp] ASC, EntryId ASC";

export const SELECT_AUDIT_ENTRIES_BY_CORRELATION_SQL =
  "SELECT EntryId, [Timestamp], Category, Action, Actor, RunId, ScheduleId, BatchId, PreviousState, NewState, MetadataJson FROM dbo.AuditEntries WHERE (@runId IS NOT NULL AND RunId = @runId) OR (@scheduleId IS NOT NULL AND ScheduleId = @scheduleId) OR (@batchId IS NOT NULL AND BatchId = @batchId) ORDER BY [Timestamp] ASC, EntryId ASC";

export const SELECT_AUDIT_ENTRIES_BY_TIME_RANGE_SQL =
  "SELECT EntryId, [Timestamp], Category, Action, Actor, RunId, ScheduleId, BatchId, PreviousState, NewState, MetadataJson FROM dbo.AuditEntries WHERE [Timestamp] >= @from AND [Timestamp] <= @to ORDER BY [Timestamp] ASC, EntryId ASC";

export const SELECT_AUDIT_ENTRIES_BY_CATEGORY_SQL =
  "SELECT EntryId, [Timestamp], Category, Action, Actor, RunId, ScheduleId, BatchId, PreviousState, NewState, MetadataJson FROM dbo.AuditEntries WHERE Category = @category ORDER BY [Timestamp] ASC, EntryId ASC";

export const SELECT_AUDIT_ENTRY_EXISTS_SQL =
  "SELECT EntryId FROM dbo.AuditEntries WHERE EntryId = @entryId";

// ─── Row mapping ─────────────────────────────────────────────────────────────

/**
 * Maps a `dbo.AuditEntries` row (positional) to a validated domain
 * `AuditEntry`.
 *
 * AC-35: `MetadataJson` is parsed via `parseJsonColumn`, which raises
 * `CorruptedRecordError` when the column contains unparseable JSON.
 * The DDL enforces `CHECK (ISJSON(MetadataJson) = 1)`, so corrupted
 * JSON should never reach the adapter — but application-level validation
 * provides defense-in-depth.
 *
 * @throws {CorruptedRecordError} when a column cannot be interpreted
 *   or the assembled entry fails `auditEntrySchema`.
 */
function mapAuditRow(result: SqlQueryResult, row: readonly unknown[]): AuditEntry {
  const raw = rowToObject(result.columns, row);
  const entryId = raw.EntryId as string;
  const candidate = {
    entryId,
    timestamp: toDate(raw.Timestamp, {
      column: "Timestamp",
      noun: "audit entry",
      recordId: entryId,
    }),
    category: raw.Category as string,
    action: raw.Action as string,
    actor: raw.Actor as string,
    correlationIds: {
      runId: toOptionalString(raw.RunId, "RunId", entryId, {
        noun: "audit entry",
        empty: "null",
      }),
      scheduleId: toOptionalString(raw.ScheduleId, "ScheduleId", entryId, {
        noun: "audit entry",
        empty: "null",
      }),
      batchId: toOptionalString(raw.BatchId, "BatchId", entryId, {
        noun: "audit entry",
        empty: "null",
      }),
    },
    previousState: toOptionalString(raw.PreviousState, "PreviousState", entryId, {
      noun: "audit entry",
      empty: "null",
    }),
    newState: toOptionalString(raw.NewState, "NewState", entryId, {
      noun: "audit entry",
      empty: "null",
    }),
    metadata: parseJsonColumn(raw.MetadataJson, "MetadataJson", entryId, {
      noun: "audit entry",
      empty: "null",
    }) as Record<string, unknown> | undefined,
  };

  const parsed = auditEntrySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CorruptedRecordError(
      `Invalid audit entry in dbo.AuditEntries for entry ${entryId}: ${parsed.error.message}`,
    );
  }
  return { ...parsed.data, entryId: parsed.data.entryId as AuditEntryId };
}

/**
 * Builds the parameter set for INSERT from an `AuditEntry`.
 *
 * Optional columns are always bound (as `null` when absent) so the
 * driver never infers a type from an omitted parameter. `Date` values
 * are bound as `DateTime2(3)` by `sql-pool.ts` (`applyParams`).
 */
function entryParams(entry: AuditEntry): Record<string, unknown> {
  return {
    entryId: entry.entryId,
    timestamp: entry.timestamp,
    category: entry.category,
    action: entry.action,
    actor: entry.actor,
    runId: entry.correlationIds.runId ?? null,
    scheduleId: entry.correlationIds.scheduleId ?? null,
    batchId: entry.correlationIds.batchId ?? null,
    previousState: entry.previousState ?? null,
    newState: entry.newState ?? null,
    metadataJson: entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
  };
}

// ─── SqlAuditRepository ──────────────────────────────────────────────────────

/**
 * `AuditRepository` backed by a `SqlExecutor` over `dbo.AuditEntries`.
 *
 * **Append-only (AC-33):** this adapter never issues UPDATE or DELETE
 * against `dbo.AuditEntries`. Audit entries are immutable once written;
 * only INSERT and SELECT statements are used.
 *
 * The executor is injected, so unit tests exercise this adapter against
 * the deterministic fake without a live SQL Server (AC-36, AC-49).
 */
export class SqlAuditRepository implements AuditRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  /**
   * Appends an audit entry to the repository (AC-33).
   *
   * The entry is redacted before persistence (parity with
   * FileAuditRepository / AC-26), then validated with `auditEntrySchema`.
   * Returns the redacted, persisted entry.
   */
  async append(entry: AuditEntry): Promise<AuditEntry> {
    const redacted = redactAuditEntry(entry);
    auditEntrySchema.parse(redacted);
    try {
      await this.executor.query(INSERT_AUDIT_ENTRY_SQL, entryParams(redacted));
      return redacted;
    } catch (cause) {
      await this.verifyAppendFailure(redacted);
      throw cause;
    }
  }

  /**
   * Lists audit entries matching the given filters (AC-34).
   *
   * String filters use sentinel-free predicates: empty/absent means
   * "no filter" (`(@x = N'' OR col = @x)`). Date filters use
   * `@since IS NULL` / `@until IS NULL` for absent bounds. `limit` is
   * applied client-side after deterministic ordering.
   */
  async list(filters?: AuditListFilters): Promise<AuditEntry[]> {
    const result = await this.executor.query(SELECT_AUDIT_ENTRIES_SQL, {
      category: filters?.category ?? "",
      action: filters?.action ?? "",
      runId: filters?.runId ?? "",
      scheduleId: filters?.scheduleId ?? "",
      batchId: filters?.batchId ?? "",
      since: filters?.since ?? null,
      until: filters?.until ?? null,
    });
    const entries = result.rows.map((row) => mapAuditRow(result, row));
    if (filters?.limit !== undefined && filters.limit >= 0) {
      return entries.slice(0, filters.limit);
    }
    return entries;
  }

  /**
   * Lists audit entries matching any of the given correlation IDs (AC-34).
   *
   * Parity with `FileAuditRepository.listByCorrelation`: entries where
   * any specified (non-undefined) correlation ID matches are returned.
   * If no IDs are specified, an empty array is returned.
   */
  async listByCorrelation(correlationIds: AuditCorrelationIds): Promise<readonly AuditEntry[]> {
    const result = await this.executor.query(SELECT_AUDIT_ENTRIES_BY_CORRELATION_SQL, {
      runId: correlationIds.runId ?? null,
      scheduleId: correlationIds.scheduleId ?? null,
      batchId: correlationIds.batchId ?? null,
    });
    return result.rows.map((row) => mapAuditRow(result, row));
  }

  /**
   * Lists audit entries within the specified time range (AC-34).
   *
   * Parity with `FileAuditRepository.listByTimeRange`.
   */
  async listByTimeRange(range: AuditTimeRange): Promise<readonly AuditEntry[]> {
    const result = await this.executor.query(SELECT_AUDIT_ENTRIES_BY_TIME_RANGE_SQL, {
      from: range.from,
      to: range.to,
    });
    return result.rows.map((row) => mapAuditRow(result, row));
  }

  /**
   * Lists audit entries matching the given category (AC-34).
   *
   * Parity with `FileAuditRepository.listByCategory`.
   */
  async listByCategory(category: AuditCategory): Promise<readonly AuditEntry[]> {
    const result = await this.executor.query(SELECT_AUDIT_ENTRIES_BY_CATEGORY_SQL, {
      category,
    });
    return result.rows.map((row) => mapAuditRow(result, row));
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Recovery for a failed insert: probe by EntryId — an existing row
   * means "already exists". A failing probe returns silently so
   * `append` rethrows the original executor error.
   */
  private async verifyAppendFailure(entry: AuditEntry): Promise<void> {
    try {
      const result = await this.executor.query(SELECT_AUDIT_ENTRY_EXISTS_SQL, {
        entryId: entry.entryId,
      });
      if (result.rows.length > 0) {
        throw new Error(`Audit entry already exists: ${entry.entryId}`);
      }
    } catch (probeError) {
      if (
        probeError instanceof Error &&
        probeError.message.startsWith("Audit entry already exists")
      ) {
        throw probeError;
      }
      // Probe failure — rethrow original error silently
    }
  }
}
