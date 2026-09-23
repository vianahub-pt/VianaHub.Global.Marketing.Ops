/**
 * Audit repository interface.
 *
 * Defines the contract for persisting audit entries.
 * Implementations can be file-based, in-memory, or database-backed.
 */

import type { AuditCategory, AuditCorrelationIds, AuditEntry } from "./audit-entry.js";

/**
 * Time range for filtering audit entries.
 */
export interface AuditTimeRange {
  readonly from: Date;
  readonly to: Date;
}

/**
 * Repository for persisting audit trail entries.
 */
export interface AuditRepository {
  /**
   * Appends an audit entry to the repository.
   * Entries are immutable once written.
   * Returns the (possibly redacted) persisted entry.
   */
  append(entry: AuditEntry): Promise<AuditEntry>;

  /**
   * Lists audit entries, optionally filtered.
   * Returns entries in chronological order (oldest first).
   */
  list?(filters?: AuditListFilters): Promise<AuditEntry[]>;

  /**
   * Lists audit entries matching any of the given correlation IDs.
   * Returns entries in chronological order (oldest first).
   */
  listByCorrelation?(correlationIds: AuditCorrelationIds): Promise<readonly AuditEntry[]>;

  /**
   * Lists audit entries within the specified time range.
   * Returns entries in chronological order (oldest first).
   */
  listByTimeRange?(range: AuditTimeRange): Promise<readonly AuditEntry[]>;

  /**
   * Lists audit entries matching the given category.
   * Returns entries in chronological order (oldest first).
   */
  listByCategory?(category: AuditCategory): Promise<readonly AuditEntry[]>;
}

/**
 * Optional filters for listing audit entries.
 */
export interface AuditListFilters {
  readonly category?: string;
  readonly action?: string;
  readonly runId?: string;
  readonly scheduleId?: string;
  readonly batchId?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly limit?: number;
}
