/**
 * Batch processing domain types.
 *
 * Defines the schema and types for batch job execution
 * with per-item isolation and partial failure semantics.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";

// --- Branded Types ---

export type BatchId = string & { readonly __brand: "BatchId" };
export type BatchItemId = string & { readonly __brand: "BatchItemId" };

// --- Enums ---

export const BATCH_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "partial_failure",
  "failed",
  "cancelled",
] as const;

export type BatchStatus = (typeof BATCH_STATUSES)[number];

// --- BatchJob ---

export interface BatchJob {
  readonly schemaVersion: 1;
  readonly batchId: BatchId;
  readonly status: BatchStatus;
  readonly totalItems: number;
  readonly completedItems: number;
  readonly failedItems: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly metadata?: Record<string, unknown>;
}

export const batchJobSchema = z
  .object({
    schemaVersion: z.literal(1),
    batchId: z.string(),
    status: z.enum(BATCH_STATUSES),
    totalItems: z.number().int().min(0),
    completedItems: z.number().int().min(0),
    failedItems: z.number().int().min(0),
    createdAt: z.date(),
    updatedAt: z.date(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

// --- BatchItem ---

export type BatchItemStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface BatchItem {
  readonly schemaVersion: 1;
  readonly itemId: BatchItemId;
  readonly batchId: BatchId;
  readonly runId: string | null; // null until run is created
  readonly status: BatchItemStatus;
  readonly error?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly metadata?: Record<string, unknown>;
}

export const batchItemSchema = z
  .object({
    schemaVersion: z.literal(1),
    itemId: z.string(),
    batchId: z.string(),
    runId: z.string().nullable(),
    status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
    error: z.string().optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

// --- Factories ---

export function createBatchId(): BatchId {
  return randomUUID() as BatchId;
}

export function createBatchItemId(): BatchItemId {
  return randomUUID() as BatchItemId;
}

export function createBatchJob(metadata?: Record<string, unknown>): BatchJob {
  const now = new Date();
  return {
    schemaVersion: 1,
    batchId: createBatchId(),
    status: "pending",
    totalItems: 0,
    completedItems: 0,
    failedItems: 0,
    createdAt: now,
    updatedAt: now,
    metadata,
  };
}

export function createBatchItem(batchId: BatchId, metadata?: Record<string, unknown>): BatchItem {
  const now = new Date();
  return {
    schemaVersion: 1,
    itemId: createBatchItemId(),
    batchId,
    runId: null,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    metadata,
  };
}
