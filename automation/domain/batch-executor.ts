/**
 * Batch executor with bounded concurrency.
 *
 * Executes batch items with configurable concurrency control.
 * Default: sequential (concurrency=1)
 * Hard maximum: 5 (MVP)
 *
 * Features:
 * - Per-item isolation (AC-12)
 * - Idempotency preservation (AC-13)
 * - Partial failure semantics (AC-14)
 * - Batch-run correlation (AC-15)
 */

import type { Clock } from "./clock.js";
import type { BatchItem, BatchJob, BatchId } from "./batch-schema.js";
import type { BatchRepository } from "./batch-repository.js";
import type { RunRepository } from "./repository.js";
import type { PlatformAdapter } from "../adapters/platform-adapter.js";
import { buildAdapterContext } from "../adapters/adapter-context.js";
import type { RunIdentity, IdempotencyKey } from "./idempotency.js";
import { createRunId, fingerprintPayload, computeIdempotencyKey } from "./idempotency.js";
import { transitionRunState } from "./transition.js";
import { redactError, redactErrorString } from "./redaction.js";
import type { RunRecord } from "./run-record.js";

// --- Constants ---

export const BATCH_HARD_MAX_CONCURRENCY = 5;
export const BATCH_DEFAULT_CONCURRENCY = 1;

// --- Types ---

export interface BatchExecutionOptions {
  readonly concurrency?: number; // default: 1, hard max: 5
  readonly maxAttempts?: number; // default: 1
}

export interface BatchExecutionResult {
  readonly batchId: BatchId;
  readonly totalItems: number;
  readonly completedItems: number;
  readonly failedItems: number;
  readonly status: "succeeded" | "partial_failure" | "failed";
  readonly errors: Array<{ itemId: string; error: string }>;
}

// --- Idempotency Key ---

function computeBatchItemIdempotencyKey(
  batchId: BatchId,
  itemId: string,
  identity: RunIdentity,
  payload: unknown,
): IdempotencyKey {
  const batchPayload = { batchId, itemId, ...identity, payload };
  return computeIdempotencyKey(identity, batchPayload);
}

// --- Concurrency Validation ---

function validateConcurrency(concurrency: number): number {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Invalid concurrency: ${concurrency}. Must be >= 1.`);
  }
  if (concurrency > BATCH_HARD_MAX_CONCURRENCY) {
    throw new Error(
      `Concurrency ${concurrency} exceeds hard maximum of ${BATCH_HARD_MAX_CONCURRENCY} for MVP.`,
    );
  }
  return concurrency;
}

// --- Sequential Executor ---

async function executeSequentially(
  items: readonly BatchItem[],
  executeItem: (item: BatchItem) => Promise<void>,
): Promise<void> {
  for (const item of items) {
    await executeItem(item);
  }
}

// --- Bounded Concurrent Executor ---

async function executeBounded(
  items: readonly BatchItem[],
  concurrency: number,
  executeItem: (item: BatchItem) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const active: Set<Promise<void>> = new Set();

  while (queue.length > 0 || active.size > 0) {
    while (active.size < concurrency && queue.length > 0) {
      const item = queue.shift()!;
      const promise = executeItem(item).finally(() => active.delete(promise));
      active.add(promise);
    }
    if (active.size > 0) {
      await Promise.race(active);
    }
  }
}

// --- Main Executor ---

export async function executeBatch(
  batchJob: BatchJob,
  items: readonly BatchItem[],
  identity: RunIdentity,
  adapter: PlatformAdapter,
  batchRepo: BatchRepository,
  runRepo: RunRepository,
  clock: Clock,
  options: BatchExecutionOptions = {},
): Promise<BatchExecutionResult> {
  const concurrency = validateConcurrency(options.concurrency ?? BATCH_DEFAULT_CONCURRENCY);
  const maxAttempts = options.maxAttempts ?? 1;
  const now = clock.now();

  // Update batch job to running
  const runningJob: BatchJob = {
    ...batchJob,
    status: "running",
    totalItems: items.length,
    updatedAt: now,
  };
  await batchRepo.updateJob(runningJob);

  let completedItems = 0;
  let failedItems = 0;
  const errors: Array<{ itemId: string; error: string }> = [];

  const executeItem = async (item: BatchItem): Promise<void> => {
    const itemNow = clock.now();

    // Update item to running
    const runningItem: BatchItem = {
      ...item,
      status: "running",
      updatedAt: itemNow,
    };
    await batchRepo.updateItem(runningItem);

    try {
      // Compute deterministic idempotency key (AC-13)
      const itemPayload = item.metadata?.payload ?? {};
      const idempotencyKey = computeBatchItemIdempotencyKey(
        batchJob.batchId,
        item.itemId,
        identity,
        itemPayload,
      );

      // Check for existing run (idempotency)
      const existingRun = await runRepo.findByIdempotencyKey(idempotencyKey);
      if (existingRun) {
        const succeededItem: BatchItem = {
          ...item,
          runId: existingRun.runId,
          status: existingRun.state === "succeeded" ? "succeeded" : "failed",
          updatedAt: clock.now(),
        };
        await batchRepo.updateItem(succeededItem);
        if (succeededItem.status === "succeeded") {
          completedItems++;
        } else {
          failedItems++;
        }
        return;
      }

      // Create RunRecord (AC-12, AC-15)
      const runId = createRunId();
      const runRecord: RunRecord = {
        schemaVersion: 1,
        runId,
        brandId: identity.brandId,
        market: identity.market,
        platform: identity.platform,
        operation: identity.operation,
        state: "queued",
        attempt: 0,
        maxAttempts,
        idempotencyKey,
        payloadFingerprint: fingerprintPayload(itemPayload),
        createdAt: clock.now(),
        updatedAt: clock.now(),
        metadata: {
          batchId: batchJob.batchId,
          itemId: item.itemId,
          ...item.metadata,
        },
      };

      await runRepo.create(runRecord);

      // Transition queued → running
      const runningRun = transitionRunState({
        current: runRecord,
        targetState: "running",
      });
      await runRepo.update(runningRun);

      // Execute via adapter
      const context = buildAdapterContext(runningRun, itemPayload);
      const result = await adapter.execute(context);

      // Transition run state
      if (result.success) {
        const succeeded = transitionRunState({
          current: runningRun,
          targetState: "succeeded",
        });
        await runRepo.update(succeeded);
        completedItems++;
      } else {
        const failed = transitionRunState({
          current: runningRun,
          targetState: "failed",
          error: result.error,
        });
        await runRepo.update(failed);
        failedItems++;
        errors.push({
          itemId: item.itemId,
          error: result.error ? redactError(result.error).message : "Unknown error",
        });
      }

      // Update item (AC-12 — failure doesn't interrupt batch)
      const finalItem: BatchItem = {
        ...item,
        runId,
        status: result.success ? "succeeded" : "failed",
        error: result.error ? redactError(result.error).message : undefined,
        updatedAt: clock.now(),
      };
      await batchRepo.updateItem(finalItem);
    } catch (err: unknown) {
      // AC-12: Failure of one item does NOT interrupt the batch
      failedItems++;
      const errorMessage = err instanceof Error ? err.message : String(err);
      const redacted = redactErrorString(errorMessage);
      errors.push({ itemId: item.itemId, error: redacted });

      const failedItem: BatchItem = {
        ...item,
        status: "failed",
        error: redacted,
        updatedAt: clock.now(),
      };
      await batchRepo.updateItem(failedItem);
    }
  };

  // Execute with concurrency control (AC-11)
  if (concurrency === 1) {
    await executeSequentially(items, executeItem);
  } else {
    await executeBounded(items, concurrency, executeItem);
  }

  // Determine final status (AC-14)
  const finalStatus: BatchJob["status"] =
    failedItems === 0 ? "succeeded" : completedItems === 0 ? "failed" : "partial_failure";

  const finalJob: BatchJob = {
    ...runningJob,
    status: finalStatus,
    completedItems,
    failedItems,
    updatedAt: clock.now(),
  };
  await batchRepo.updateJob(finalJob);

  return {
    batchId: batchJob.batchId,
    totalItems: items.length,
    completedItems,
    failedItems,
    status: finalStatus,
    errors,
  };
}
