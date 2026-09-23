/**
 * Schedule repository interface.
 *
 * Defines the contract for persisting and querying
 * schedule configurations.
 */

import type { ScheduleId, ScheduleRecord } from "./schedule-schema.js";

/**
 * Filters for listing schedules.
 */
export interface ScheduleListFilters {
  brandId?: string;
  market?: string;
  platform?: string;
  enabled?: boolean;
}

/**
 * Repository interface for schedule persistence.
 */
export interface ScheduleRepository {
  /**
   * Creates a new schedule record.
   * @returns The created schedule record
   * @throws {RecordAlreadyExistsError} if scheduleId already exists
   */
  create(record: ScheduleRecord): Promise<ScheduleRecord>;

  /**
   * Retrieves a schedule by its ID.
   * @returns The schedule record or null if not found
   */
  getById(scheduleId: ScheduleId): Promise<ScheduleRecord | null>;

  /**
   * Updates an existing schedule record.
   * @returns The updated schedule record
   * @throws {RecordNotFoundError} if scheduleId does not exist
   * @throws {ConcurrencyConflictError} if revision mismatch
   */
  update(record: ScheduleRecord): Promise<ScheduleRecord>;

  /**
   * Lists schedules matching the given filters.
   * If no filters are provided, returns all schedules.
   */
  list(filters?: ScheduleListFilters): Promise<ScheduleRecord[]>;

  /**
   * Finds a schedule by its idempotency key.
   * @returns The schedule record or null if not found
   */
  findByIdempotencyKey(idempotencyKey: string): Promise<ScheduleRecord | null>;
}
