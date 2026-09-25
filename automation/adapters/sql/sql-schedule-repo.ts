/**
 * SQL Server implementation of ScheduleRepository (Sprint 5 — I-3b, AC-27..AC-29, D-11).
 *
 * Rows map to `dbo.Schedules` (database/migrations/001_initial_schema.sql):
 * - Round-trip (AC-27): every `ScheduleRecord` field is persisted and
 *   deserialized; each row is validated with `scheduleRecordSchema` and an
 *   invalid row raises `CorruptedRecordError` (FR-07 parity with
 *   FileScheduleRepository).
 * - Enabled invariant (AC-27 → decision D-12, REV-30): `dbo.Schedules`
 *   carries ONE frozen `Enabled` BIT column, while `ScheduleRecord` carries
 *   two booleans (`enabled` and `config.enabled`). FileScheduleRepository
 *   stores the whole JSON record and therefore preserves a divergent pair,
 *   but a single column can only store one value — so instead of silently
 *   collapsing the pair (losing `config.enabled` on write and fabricating
 *   it on read) the adapter FAILS FAST via `assertEnabledInvariant`.
 * - Optimistic concurrency (AC-28): `update` takes no `expectedRevision`
 *   parameter — the expected revision is `record.revision`. The guarded
 *   statement increments `Revision` and only matches the expected value;
 *   zero matched rows are probed to distinguish "record not found" from
 *   `ConcurrencyConflictError`, mirroring FileScheduleRepository.
 * - List filters (AC-29): string filters treat empty/absent as "no filter"
 *   with `(@x = N'' OR col = @x)` predicates (no sentinel value);
 *   `enabled` is a real BIT filter driven by `@enabledFilter` in
 *   {"", "1", "0"}.
 * - Decision D-11: `IdempotencyKey` is intentionally NOT unique (the DDL
 *   has no `UQ_Schedules_IdempotencyKey`); `findByIdempotencyKey` is
 *   deterministic for duplicates via `TOP (1) ... ORDER BY ScheduleId ASC`.
 * - Statements are static exported constants — never built from
 *   interpolated or concatenated input (AC-36); SQL is 100% parameterized
 *   and `Date` values are bound as `DateTime2(3)` by `sql-pool.ts`
 *   (`applyParams`).
 * - Executor failures propagate unchanged as `SqlExecutorError`
 *   (error-mapping.ts) so sanitized messages and actions are preserved.
 */

import type { ScheduleListFilters, ScheduleRepository } from "../../domain/schedule-repository.js";
import {
  scheduleRecordSchema,
  type ScheduleId,
  type ScheduleRecord,
} from "../../domain/schedule-schema.js";
import { ConcurrencyConflictError, CorruptedRecordError } from "../persistence-errors.js";
import type { SqlExecutor, SqlQueryResult } from "./sql-pool.js";
import { parseJsonColumn, rowToObject, toDate, toOptionalDate } from "./sql-row-helpers.js";

// ─── Static statements (AC-36: no interpolation, no concatenation) ───────────

export const INSERT_SCHEDULE_SQL =
  "INSERT INTO dbo.Schedules (ScheduleId, SchemaVersion, IdempotencyKey, Cron, Timezone, BrandId, Market, Platform, Operation, Mode, Enabled, CreatedAt, UpdatedAt, LastRunAt, NextRunAt, Revision, MetadataJson) VALUES (@scheduleId, @schemaVersion, @idempotencyKey, @cron, @timezone, @brandId, @market, @platform, @operation, @mode, @enabled, @createdAt, @updatedAt, @lastRunAt, @nextRunAt, @revision, @metadataJson)";

export const SELECT_SCHEDULE_BY_ID_SQL =
  "SELECT ScheduleId, SchemaVersion, IdempotencyKey, Cron, Timezone, BrandId, Market, Platform, Operation, Mode, Enabled, CreatedAt, UpdatedAt, LastRunAt, NextRunAt, Revision, MetadataJson FROM dbo.Schedules WHERE ScheduleId = @scheduleId";

/**
 * D-11: `IdempotencyKey` has no unique constraint, so duplicates are legal.
 * `TOP (1) ... ORDER BY ScheduleId ASC` makes the winner deterministic
 * (lowest ScheduleId) — FileScheduleRepository is non-deterministic here.
 */
export const SELECT_SCHEDULE_BY_IDEMPOTENCY_SQL =
  "SELECT TOP (1) ScheduleId, SchemaVersion, IdempotencyKey, Cron, Timezone, BrandId, Market, Platform, Operation, Mode, Enabled, CreatedAt, UpdatedAt, LastRunAt, NextRunAt, Revision, MetadataJson FROM dbo.Schedules WHERE IdempotencyKey = @idempotencyKey ORDER BY ScheduleId ASC";

export const SELECT_SCHEDULES_SQL =
  "SELECT ScheduleId, SchemaVersion, IdempotencyKey, Cron, Timezone, BrandId, Market, Platform, Operation, Mode, Enabled, CreatedAt, UpdatedAt, LastRunAt, NextRunAt, Revision, MetadataJson FROM dbo.Schedules WHERE (@brandId = N'' OR BrandId = @brandId) AND (@market = N'' OR Market = @market) AND (@platform = N'' OR Platform = @platform) AND (@enabledFilter = N'' OR Enabled = @enabled) ORDER BY ScheduleId ASC";

export const UPDATE_SCHEDULE_GUARDED_SQL =
  "UPDATE dbo.Schedules SET SchemaVersion = @schemaVersion, IdempotencyKey = @idempotencyKey, Cron = @cron, Timezone = @timezone, BrandId = @brandId, Market = @market, Platform = @platform, Operation = @operation, Mode = @mode, Enabled = @enabled, CreatedAt = @createdAt, UpdatedAt = @updatedAt, LastRunAt = @lastRunAt, NextRunAt = @nextRunAt, MetadataJson = @metadataJson, Revision = Revision + 1 OUTPUT inserted.Revision WHERE ScheduleId = @scheduleId AND Revision = @expectedRevision";

export const SELECT_SCHEDULE_REVISION_SQL =
  "SELECT Revision FROM dbo.Schedules WHERE ScheduleId = @scheduleId";

/**
 * Maps a `dbo.Schedules` row (positional) to a validated domain `ScheduleRecord`.
 *
 * All fields round-trip (AC-27): the flat config columns are reassembled
 * into `config` and the single `Enabled` BIT column feeds both
 * `config.enabled` and the record-level `enabled`. Only records satisfying
 * the D-12 invariant (`config.enabled === enabled`) are ever written
 * (`assertEnabledInvariant`), so the shared column reconstructs both flags
 * exactly as stored.
 *
 * @throws {CorruptedRecordError} when a column cannot be interpreted or
 *   the assembled record fails `scheduleRecordSchema` (FR-07 parity).
 */
function mapScheduleRow(result: SqlQueryResult, row: readonly unknown[]): ScheduleRecord {
  const raw = rowToObject(result.columns, row);
  const candidate = {
    schemaVersion: raw.SchemaVersion,
    scheduleId: raw.ScheduleId,
    idempotencyKey: raw.IdempotencyKey,
    config: {
      cron: raw.Cron,
      timezone: raw.Timezone,
      brandId: raw.BrandId,
      market: raw.Market,
      platform: raw.Platform,
      operation: raw.Operation,
      enabled: raw.Enabled,
      mode: raw.Mode,
      metadata: parseJsonColumn(raw.MetadataJson, "MetadataJson", raw.ScheduleId, {
        noun: "schedule",
        empty: "null",
      }),
    },
    createdAt: toDate(raw.CreatedAt, { table: "dbo.Schedules" }),
    updatedAt: toDate(raw.UpdatedAt, { table: "dbo.Schedules" }),
    lastRunAt: toOptionalDate(raw.LastRunAt, { table: "dbo.Schedules" }),
    nextRunAt: toOptionalDate(raw.NextRunAt, { table: "dbo.Schedules" }),
    enabled: raw.Enabled,
    revision: raw.Revision,
  };

  const parsed = scheduleRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CorruptedRecordError(
      `Invalid schedule record in dbo.Schedules for schedule ${String(raw.ScheduleId)}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Enforces the D-12 enabled invariant before any write (REV-30).
 *
 * `ScheduleRecord` exposes the flag twice — `record.enabled` and
 * `record.config.enabled` — but `dbo.Schedules` (frozen DDL
 * `database/migrations/001_initial_schema.sql`) has a single `Enabled` BIT
 * column. FileScheduleRepository is authoritative for divergence: it writes
 * the whole JSON record, so a divergent pair survives a FS round-trip
 * untouched. The SQL column cannot represent that state, so persisting it
 * would silently collapse both flags to `record.enabled`.
 *
 * Decision (D-12): reject the divergent record with a clear error instead
 * of collapsing it. The domain keeps the pair in sync
 * (`createScheduleRecord` sets `enabled: config.enabled`), so every
 * domain-produced record satisfies the invariant; this check only guards
 * adapter-level inputs assembled elsewhere.
 *
 * @throws {Error} when `record.enabled !== record.config.enabled`.
 */
function assertEnabledInvariant(record: ScheduleRecord): void {
  if (record.enabled !== record.config.enabled) {
    throw new Error(
      `Enabled invariant violated for schedule ${record.scheduleId}: ` +
        `record.enabled (${record.enabled}) !== record.config.enabled (${record.config.enabled}) — ` +
        "dbo.Schedules stores a single Enabled column, so the pair cannot be persisted (D-12)",
    );
  }
}

/**
 * Builds the fully-bound parameter set shared by INSERT/UPDATE statements.
 *
 * Optional columns are always bound (as `null` when absent) so the driver
 * never infers a type from an omitted parameter. `metadataJson` is
 * `JSON.stringify`ed only when `config.metadata` is present. `Date` values
 * are bound as `DateTime2(3)` by `sql-pool.ts` (`applyParams`).
 *
 * `Enabled` stores the record-level `enabled` flag (the value AC-29 filters
 * on); on read both `config.enabled` and `enabled` derive from that column.
 * `assertEnabledInvariant` runs before this function on every write, so the
 * two flags always hold the same value when they reach the statement (D-12).
 */
function recordParams(record: ScheduleRecord): Record<string, unknown> {
  return {
    scheduleId: record.scheduleId,
    schemaVersion: record.schemaVersion,
    idempotencyKey: record.idempotencyKey,
    cron: record.config.cron,
    timezone: record.config.timezone,
    brandId: record.config.brandId,
    market: record.config.market,
    platform: record.config.platform,
    operation: record.config.operation,
    mode: record.config.mode,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastRunAt: record.lastRunAt ?? null,
    nextRunAt: record.nextRunAt ?? null,
    revision: record.revision,
    metadataJson:
      record.config.metadata === undefined ? null : JSON.stringify(record.config.metadata),
  };
}

// ─── SqlScheduleRepository ───────────────────────────────────────────────────

/**
 * `ScheduleRepository` backed by a `SqlExecutor` over `dbo.Schedules`.
 *
 * The executor is injected, so unit tests exercise this adapter against
 * the deterministic fake without a live SQL Server (AC-36, AC-49).
 */
export class SqlScheduleRepository implements ScheduleRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  /**
   * Persists a new schedule (AC-27).
   *
   * @throws {Error} when the D-12 enabled invariant is violated — checked
   *   before any statement is issued, so the failure never reaches the
   *   executor and never touches the store.
   */
  async create(record: ScheduleRecord): Promise<ScheduleRecord> {
    assertEnabledInvariant(record);
    try {
      await this.executor.query(INSERT_SCHEDULE_SQL, recordParams(record));
      return record;
    } catch (cause) {
      await this.verifyCreateFailure(record);
      throw cause;
    }
  }

  async getById(scheduleId: ScheduleId): Promise<ScheduleRecord | null> {
    const result = await this.executor.query(SELECT_SCHEDULE_BY_ID_SQL, { scheduleId });
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return mapScheduleRow(result, row);
  }

  /**
   * Updates an existing schedule record with optimistic concurrency (AC-28).
   *
   * The expected revision is `record.revision` (the contract has no
   * `expectedRevision` parameter); on zero matched rows a probe
   * distinguishes "not found" from "concurrency conflict" — parity with
   * FileScheduleRepository, including the returned `revision + 1`.
   *
   * @throws {Error} when the D-12 enabled invariant is violated — checked
   *   before the guarded statement, so a divergent pair never overwrites
   *   the stored `Enabled` column.
   */
  async update(record: ScheduleRecord): Promise<ScheduleRecord> {
    assertEnabledInvariant(record);
    const expectedRevision = record.revision;
    const guarded = await this.executor.query(UPDATE_SCHEDULE_GUARDED_SQL, {
      ...recordParams(record),
      expectedRevision,
    });
    if (guarded.rows.length === 0) {
      await this.throwUpdateFailure(record.scheduleId, expectedRevision);
    }
    return { ...record, revision: expectedRevision + 1 };
  }

  /**
   * Lists schedules matching the given filters (AC-29).
   *
   * Empty-string and absent string filters mean "no filter"
   * (`(@x = N'' OR col = @x)`, no sentinel). `enabled` is a real BIT
   * filter: `@enabledFilter` carries "", "1" or "0" and `@enabled` carries
   * the bit value, mirroring FileScheduleRepository's semantics where an
   * absent `enabled` filter matches everything.
   */
  async list(filters?: ScheduleListFilters): Promise<ScheduleRecord[]> {
    const result = await this.executor.query(SELECT_SCHEDULES_SQL, {
      brandId: filters?.brandId ?? "",
      market: filters?.market ?? "",
      platform: filters?.platform ?? "",
      enabledFilter: filters?.enabled === undefined ? "" : filters.enabled ? "1" : "0",
      enabled: filters?.enabled ?? false,
    });
    return result.rows.map((row) => mapScheduleRow(result, row));
  }

  /**
   * Finds a schedule by its idempotency key (D-11).
   *
   * `dbo.Schedules.IdempotencyKey` is intentionally NOT unique (no
   * `UQ_Schedules_IdempotencyKey`): the domain does not impose schedule
   * idempotency at the storage layer. When duplicates exist, the SQL is
   * deterministic — `TOP (1) ... ORDER BY ScheduleId ASC` always returns
   * the schedule with the lowest ScheduleId — whereas
   * FileScheduleRepository is non-deterministic for duplicates (it returns
   * the first match in directory order).
   */
  async findByIdempotencyKey(idempotencyKey: string): Promise<ScheduleRecord | null> {
    const result = await this.executor.query(SELECT_SCHEDULE_BY_IDEMPOTENCY_SQL, {
      idempotencyKey,
    });
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return mapScheduleRow(result, row);
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Distinguishes a failed guarded update from a missing record by probing
   * the current stored revision (AC-28).
   */
  private async throwUpdateFailure(scheduleId: string, expectedRevision: number): Promise<never> {
    const probe = await this.executor.query(SELECT_SCHEDULE_REVISION_SQL, { scheduleId });
    const row = probe.rows[0];
    if (row === undefined) {
      throw new Error(`Record not found: ${scheduleId}`);
    }
    throw new ConcurrencyConflictError({
      recordId: scheduleId,
      expectedRevision,
      actualRevision: Number(row[0]),
    });
  }

  /**
   * Recovery for a failed insert: probe by ScheduleId — an existing row
   * means "already exists". Per D-11 there is NO recovery by idempotency
   * key (uniqueness is not enforced there). A failing probe returns
   * silently so `create` rethrows the original executor error.
   */
  private async verifyCreateFailure(record: ScheduleRecord): Promise<void> {
    let existing: ScheduleRecord | null;
    try {
      existing = await this.getById(record.scheduleId as ScheduleId);
    } catch {
      return;
    }
    if (existing !== null) {
      throw new Error(`Record already exists: ${record.scheduleId}`);
    }
  }
}
