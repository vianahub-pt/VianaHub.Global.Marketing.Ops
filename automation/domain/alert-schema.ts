/**
 * Alert schema and types.
 *
 * Defines structured alerts for operational observability
 * with severity levels and deduplication support.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";

// --- Branded Types ---

export type AlertId = string & { readonly __brand: "AlertId" };

// --- Severity Levels (AC-28) ---

export const ALERT_SEVERITIES = ["info", "warn", "error", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

// --- Alert Categories ---

export const ALERT_CATEGORIES = [
  "recovery",
  "lock",
  "schedule",
  "batch",
  "system",
  "pilot",
] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

// --- Correlation IDs ---

export interface AlertCorrelationIds {
  readonly runId?: string;
  readonly scheduleId?: string;
  readonly batchId?: string;
}

// --- AlertEntry (AC-27) ---

export interface AlertEntry {
  readonly alertId: AlertId;
  readonly timestamp: Date;
  readonly severity: AlertSeverity;
  readonly category: AlertCategory;
  readonly message: string;
  readonly correlationIds: AlertCorrelationIds;
  readonly deduplicationKey?: string;
  readonly suppressedCount?: number; // AC-29: populated when deduplicated
  readonly metadata?: Record<string, unknown>;
}

// --- Zod Schemas ---

export const alertCorrelationIdsSchema = z
  .object({
    runId: z.string().optional(),
    scheduleId: z.string().optional(),
    batchId: z.string().optional(),
  })
  .strict();

export const alertEntrySchema = z
  .object({
    alertId: z.string(),
    timestamp: z.date(),
    severity: z.enum(ALERT_SEVERITIES),
    category: z.enum(ALERT_CATEGORIES),
    message: z.string(),
    correlationIds: alertCorrelationIdsSchema,
    deduplicationKey: z.string().optional(),
    suppressedCount: z.number().int().min(0).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

// --- Factory ---

export function createAlertId(): AlertId {
  return randomUUID() as AlertId;
}

export function createAlertEntry(params: {
  severity: AlertSeverity;
  category: AlertCategory;
  message: string;
  correlationIds: AlertCorrelationIds;
  deduplicationKey?: string;
  suppressedCount?: number;
  metadata?: Record<string, unknown>;
  clock?: { now(): Date };
}): AlertEntry {
  return {
    alertId: createAlertId(),
    timestamp: params.clock?.now() ?? new Date(),
    severity: params.severity,
    category: params.category,
    message: params.message,
    correlationIds: params.correlationIds,
    deduplicationKey: params.deduplicationKey,
    suppressedCount: params.suppressedCount,
    metadata: params.metadata,
  };
}
