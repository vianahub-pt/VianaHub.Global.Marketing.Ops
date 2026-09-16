import { z } from "zod";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "./idempotency.js";
import type { RunError, RunState } from "./run-state.js";

export interface RunRecord {
  schemaVersion: number;
  runId: RunId;
  brandId: string;
  market: string;
  platform: string;
  operation: string;
  state: RunState;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: IdempotencyKey;
  payloadFingerprint: PayloadFingerprint;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  error?: RunError;
  metadata?: Record<string, unknown>;
}

const runStateSchema = z.enum([
  "queued",
  "running",
  "waiting_manual",
  "succeeded",
  "failed",
  "cancelled",
]);

const runErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
});

export const runRecordSchema = z
  .object({
    schemaVersion: z.number(),
    runId: z.string().pipe(z.unknown() as z.ZodType<RunId>),
    brandId: z.string(),
    market: z.string(),
    platform: z.string(),
    operation: z.string(),
    state: runStateSchema,
    attempt: z.number(),
    maxAttempts: z.number(),
    idempotencyKey: z.string().pipe(z.unknown() as z.ZodType<IdempotencyKey>),
    payloadFingerprint: z.string().pipe(z.unknown() as z.ZodType<PayloadFingerprint>),
    createdAt: z.date(),
    updatedAt: z.date(),
    startedAt: z.date().optional(),
    finishedAt: z.date().optional(),
    error: runErrorSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();
