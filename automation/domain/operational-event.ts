/**
 * Operational event schema and types.
 *
 * Defines structured events for observability with
 * secret rejection and correlation IDs.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";

// --- Branded Types ---

export type EventId = string & { readonly __brand: "EventId" };

// --- Enums ---

export const EVENT_LEVELS = ["info", "warn", "error"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

export const EVENT_CATEGORIES = ["run", "schedule", "batch", "recovery", "system"] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

// --- Run Event Names ---

export const RUN_EVENT_NAMES = [
  "run.queued",
  "run.running",
  "run.succeeded",
  "run.failed",
  "run.waiting_manual",
] as const;
export type RunEventName = (typeof RUN_EVENT_NAMES)[number];

// --- Schedule Event Names ---

export const SCHEDULE_EVENT_NAMES = [
  "schedule.triggered",
  "schedule.skipped_overlap",
  "schedule.skipped_concurrency",
  "schedule.error",
] as const;
export type ScheduleEventName = (typeof SCHEDULE_EVENT_NAMES)[number];

// --- Batch Event Names ---

export const BATCH_EVENT_NAMES = [
  "batch.started",
  "batch.item_completed",
  "batch.item_failed",
  "batch.succeeded",
  "batch.partial_failure",
  "batch.failed",
] as const;
export type BatchEventName = (typeof BATCH_EVENT_NAMES)[number];

// --- Recovery Event Names ---

export const RECOVERY_EVENT_NAMES = [
  "recovery.detected",
  "recovery.succeeded",
  "recovery.failed",
  "recovery.skipped",
] as const;
export type RecoveryEventName = (typeof RECOVERY_EVENT_NAMES)[number];

// --- System Event Names ---

export const SYSTEM_EVENT_NAMES = ["system.startup", "system.shutdown", "system.error"] as const;
export type SystemEventName = (typeof SYSTEM_EVENT_NAMES)[number];

// --- Union of all event names ---

export type OperationalEventName =
  RunEventName | ScheduleEventName | BatchEventName | RecoveryEventName | SystemEventName;

// --- Correlation IDs ---

export interface CorrelationIds {
  readonly runId?: string;
  readonly scheduleId?: string;
  readonly batchId?: string;
}

// --- OperationalEvent ---

export interface OperationalEvent {
  readonly eventId: EventId;
  readonly timestamp: Date;
  readonly level: EventLevel;
  readonly category: EventCategory;
  readonly name: OperationalEventName;
  readonly message: string;
  readonly correlationIds: CorrelationIds;
  readonly metadata?: Record<string, unknown>;
}

// --- Sensitive field detection ---

const SENSITIVE_FIELD_PATTERN =
  /(?:token|secret|password|passwd|passphrase|cookie|session(?:id)?|authorization|credential|api[-_]?key|private[-_]?key|client[-_]?secret|access[-_]?key)/i;

const sensitiveValuePatterns = [
  /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/, // JWT
  /^bearer\s+\S+$/i, // Bearer
  /(?:^|;\s*)(?:session|token|auth|sid)[^=]*=/i, // Cookie
  /^-----BEGIN [A-Z0-9 ]+-----/, // PEM
];

function rejectSensitiveMetadata(metadata: Record<string, unknown>, path: string): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_FIELD_PATTERN.test(key)) {
      throw new Error(`Sensitive field "${key}" not allowed in event metadata at ${path}`);
    }
    if (typeof value === "string") {
      for (const pattern of sensitiveValuePatterns) {
        if (pattern.test(value)) {
          throw new Error(`Sensitive value detected in event metadata at ${path}.${key}`);
        }
      }
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      rejectSensitiveMetadata(value as Record<string, unknown>, `${path}.${key}`);
    }
  }
}

// --- Zod Schemas ---

export const correlationIdsSchema = z
  .object({
    runId: z.string().optional(),
    scheduleId: z.string().optional(),
    batchId: z.string().optional(),
  })
  .strict();

export const operationalEventSchema = z
  .object({
    eventId: z.string(),
    timestamp: z.date(),
    level: z.enum(EVENT_LEVELS),
    category: z.enum(EVENT_CATEGORIES),
    name: z.string(),
    message: z.string(),
    correlationIds: correlationIdsSchema,
    metadata: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.metadata) {
      try {
        rejectSensitiveMetadata(event.metadata, "$.metadata");
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: err instanceof Error ? err.message : "Sensitive data rejected",
          path: ["metadata"],
        });
      }
    }
  });

// --- Factory ---

export function createEventId(): EventId {
  return randomUUID() as EventId;
}

export function createOperationalEvent(params: {
  level: EventLevel;
  category: EventCategory;
  name: OperationalEventName;
  message: string;
  correlationIds: CorrelationIds;
  metadata?: Record<string, unknown>;
  clock?: { now(): Date };
}): OperationalEvent {
  return {
    eventId: createEventId(),
    timestamp: params.clock?.now() ?? new Date(),
    level: params.level,
    category: params.category,
    name: params.name,
    message: params.message,
    correlationIds: params.correlationIds,
    metadata: params.metadata,
  };
}
