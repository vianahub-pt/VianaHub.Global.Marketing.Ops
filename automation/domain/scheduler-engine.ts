/**
 * Scheduler engine for evaluating and executing scheduled runs.
 *
 * Identifies due schedules and creates RunRecords with
 * idempotencyKey derived from schedule config + timestamp.
 */

import { createHash } from "node:crypto";

import type { Clock } from "./clock.js";
import type { IdempotencyKey, PayloadFingerprint, RunIdentity } from "./idempotency.js";
import type { BatchRepository } from "./batch-repository.js";
import { createBatchJob, createBatchItem } from "./batch-schema.js";
import { executeBatch } from "./batch-executor.js";
import type { PlatformAdapter } from "../adapters/platform-adapter.js";
import type { RunRepository } from "./repository.js";
import type { RunRecord } from "./run-record.js";
import type { ScheduleRecord } from "./schedule-schema.js";
import type { ScheduleRepository } from "./schedule-repository.js";
import { createRunId, fingerprintPayload } from "./idempotency.js";
import { nextExecutionTime } from "./cron-parser.js";
import { checkOverlap } from "./overlap-check.js";
import { redactErrorString } from "./redaction.js";
import { computeScheduleIdempotencyKey } from "./schedule-schema.js";

/**
 * Maximum number of schedules to evaluate concurrently.
 */
export const MAX_CONCURRENT_BATCH = 5;

/**
 * Result of evaluating schedules.
 */
export interface SchedulerResult {
  /** Number of schedules evaluated */
  evaluated: number;
  /** Number of schedules that were due */
  due: number;
  /** Number of runs executed */
  executed: number;
  /** Number of runs skipped due to overlap */
  skippedOverlap: number;
  /** Number of runs skipped due to concurrency limit */
  skippedConcurrency: number;
  /** Errors encountered */
  errors: Array<{ scheduleId: string; error: string }>;
}

/**
 * Optional dependencies for batch mode execution.
 */
export interface SchedulerBatchDependencies {
  /** Repository for persisting batch jobs and items */
  batchRepo: BatchRepository;
  /** Platform adapter for executing batch items */
  adapter: PlatformAdapter;
}

/**
 * Computes a run-level idempotency key from the schedule config key
 * and the execution timestamp (minute granularity).
 *
 * Same schedule at the same minute always produces the same key,
 * preventing duplicate runs for the same execution window.
 */
function computeRunIdempotencyKey(
  scheduleIdempotencyKey: string,
  executionTime: Date,
): IdempotencyKey {
  const tsMinute = executionTime.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  return createHash("sha256")
    .update(`${scheduleIdempotencyKey}:${tsMinute}`, "utf8")
    .digest("hex") as IdempotencyKey;
}

/**
 * Determines the next execution time for a schedule.
 *
 * Uses `lastRunAt` as the reference if available (to find the next
 * occurrence after the last run), otherwise falls back to `createdAt`.
 */
function computeNextDueTime(schedule: ScheduleRecord): Date | null {
  const referenceTime = schedule.lastRunAt ?? schedule.createdAt;
  return nextExecutionTime(schedule.config.cron, referenceTime, schedule.config.timezone);
}

/**
 * Evaluates all enabled schedules and creates runs for due ones.
 *
 * A schedule is considered "due" when its next execution time
 * (computed from `lastRunAt` or `createdAt`) is at or before `now`.
 *
 * @param schedules - Schedule records to evaluate
 * @param repo - Run repository for creating runs
 * @param clock - Clock for deterministic time
 * @param scheduleRepo - Optional schedule repository for updating `lastRunAt`
 * @returns Result summary
 */
export async function evaluateSchedules(
  schedules: ScheduleRecord[],
  repo: RunRepository,
  clock: Clock,
  scheduleRepo?: ScheduleRepository,
  batchDeps?: SchedulerBatchDependencies,
): Promise<SchedulerResult> {
  const result: SchedulerResult = {
    evaluated: 0,
    due: 0,
    executed: 0,
    skippedOverlap: 0,
    skippedConcurrency: 0,
    errors: [],
  };

  const now = clock.now();

  // Filter enabled schedules
  const enabledSchedules = schedules.filter((s) => s.enabled);

  // Evaluate each schedule
  for (const schedule of enabledSchedules) {
    result.evaluated++;

    try {
      // Determine if schedule is due
      const nextRun = computeNextDueTime(schedule);

      if (!nextRun || nextRun > now) {
        continue; // Not due yet
      }

      result.due++;

      // Compute run-level idempotency key (schedule config + execution minute)
      const scheduleKey = computeScheduleIdempotencyKey(schedule.config);
      const runKey = computeRunIdempotencyKey(scheduleKey, nextRun);

      // Check for overlap with existing active runs
      const hasOverlap = await checkOverlap(repo, runKey);

      if (hasOverlap) {
        result.skippedOverlap++;
        continue;
      }

      // Check concurrency limit
      if (result.executed >= MAX_CONCURRENT_BATCH) {
        result.skippedConcurrency++;
        continue;
      }

      if (schedule.config.mode === "batch") {
        // Batch mode: create BatchJob and BatchItems
        if (!batchDeps) {
          result.errors.push({
            scheduleId: schedule.scheduleId,
            error: "Batch mode requires batchRepo and adapter dependencies",
          });
          continue;
        }

        // Check overlap for batch mode: prevent duplicate batch jobs for same schedule
        // AC-16 TOCTOU fix: check both running AND pending batches
        const runningBatches = await batchDeps.batchRepo.listJobsByStatus("running");
        const pendingBatches = await batchDeps.batchRepo.listJobsByStatus("pending");
        const hasActiveBatch = [...runningBatches, ...pendingBatches].some(
          (b) => b.metadata?.scheduleId === schedule.scheduleId,
        );

        if (hasActiveBatch) {
          result.skippedOverlap++;
          continue;
        }

        const batchJob = createBatchJob({
          scheduleId: schedule.scheduleId,
          scheduledAt: nextRun.toISOString(),
        });

        // AC-16: Validate items is an array (no unsafe `as unknown[]`)
        const rawItems = schedule.config.metadata?.items;
        const items = Array.isArray(rawItems) ? rawItems : [];

        // AC-16: Early validation — batch with zero items creates noise
        if (items.length === 0) {
          result.errors.push({
            scheduleId: schedule.scheduleId,
            error: "Batch mode requires at least one item",
          });
          continue;
        }

        const batchItems = items.map((item, index) =>
          createBatchItem(batchJob.batchId, { payload: item, index }),
        );

        await batchDeps.batchRepo.createJob(batchJob);
        for (const item of batchItems) {
          await batchDeps.batchRepo.createItem(item);
        }

        const identity: RunIdentity = {
          brandId: schedule.config.brandId,
          market: schedule.config.market,
          platform: schedule.config.platform,
          operation: schedule.config.operation,
        };

        // AC-16: Validate concurrency is a number (no unsafe `as number | undefined`)
        const rawConcurrency = schedule.config.metadata?.concurrency;
        const concurrency = typeof rawConcurrency === "number" ? rawConcurrency : undefined;

        // AC-16: Capture and propagate executeBatch result
        const batchResult = await executeBatch(
          batchJob,
          batchItems,
          identity,
          batchDeps.adapter,
          batchDeps.batchRepo,
          repo,
          clock,
          { concurrency },
        );

        if (batchResult.status !== "succeeded") {
          result.errors.push({
            scheduleId: schedule.scheduleId,
            error: `Batch ${batchResult.status}: ${batchResult.failedItems}/${batchResult.totalItems} failed`,
          });
        }

        result.executed++;
      } else {
        // Single mode: create RunRecord
        const runId = createRunId();
        const payload = {
          scheduleId: schedule.scheduleId,
          config: schedule.config,
          scheduledAt: nextRun.toISOString(),
        };
        const run: RunRecord = {
          schemaVersion: 1,
          runId,
          brandId: schedule.config.brandId,
          market: schedule.config.market,
          platform: schedule.config.platform,
          operation: schedule.config.operation,
          state: "queued",
          attempt: 1,
          maxAttempts: 3,
          idempotencyKey: runKey,
          payloadFingerprint: fingerprintPayload(payload) as PayloadFingerprint,
          createdAt: now,
          updatedAt: now,
          metadata: {
            scheduleId: schedule.scheduleId,
            scheduledAt: nextRun.toISOString(),
          },
        };

        await repo.create(run);
        result.executed++;
      }

      // Update schedule's lastRunAt if scheduleRepo is provided
      if (scheduleRepo) {
        const updatedSchedule: ScheduleRecord = {
          ...schedule,
          lastRunAt: now,
          nextRunAt: nextRun,
          updatedAt: now,
          revision: schedule.revision + 1,
        };
        await scheduleRepo.update(updatedSchedule);
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      // Apply redaction to error messages to prevent sensitive data leaks
      result.errors.push({
        scheduleId: schedule.scheduleId,
        error: redactErrorString(error),
      });
    }
  }

  return result;
}
