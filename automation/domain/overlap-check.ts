/**
 * Overlap prevention for scheduled runs.
 *
 * Prevents concurrent execution of runs with the same
 * idempotency key by checking for existing queued or running runs.
 */

import type { IdempotencyKey } from "./idempotency.js";
import type { RunRepository } from "./repository.js";

/**
 * Checks if a run with the given idempotency key is already
 * in progress (queued or running).
 *
 * @param repo - Run repository to query
 * @param idempotencyKey - The idempotency key to check
 * @returns true if an active run exists, false otherwise
 * @never throws - always returns a boolean
 */
export async function checkOverlap(
  repo: RunRepository,
  idempotencyKey: IdempotencyKey,
): Promise<boolean> {
  try {
    const existingRun = await repo.findByIdempotencyKey(idempotencyKey);

    if (!existingRun) {
      return false;
    }

    // Check if the existing run is in an active state
    return existingRun.state === "queued" || existingRun.state === "running";
  } catch {
    // On error, fail closed - assume overlap exists
    return true;
  }
}
