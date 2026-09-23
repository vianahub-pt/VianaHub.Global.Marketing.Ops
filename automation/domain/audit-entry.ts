/**
 * Audit entry schema and types.
 *
 * Defines structured audit trail entries that are persisted
 * alongside operational events for compliance and debugging.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { redactLog } from "./redaction.js";

// --- Branded Types ---

export type AuditEntryId = string & { readonly __brand: "AuditEntryId" };

// --- Types ---

export type AuditAction = string;

export type AuditActor = "system" | "scheduled" | "manual" | string;

export type AuditCategory = string;

export interface AuditCorrelationIds {
  readonly runId?: string;
  readonly scheduleId?: string;
  readonly batchId?: string;
}

export interface AuditEntry {
  readonly entryId: AuditEntryId;
  readonly timestamp: Date;
  readonly category: string;
  readonly action: AuditAction;
  readonly actor: AuditActor;
  readonly correlationIds: AuditCorrelationIds;
  readonly previousState?: string;
  readonly newState?: string;
  readonly metadata?: Record<string, unknown>;
}

// --- Zod Schemas ---

export const auditCorrelationIdsSchema = z
  .object({
    runId: z.string().optional(),
    scheduleId: z.string().optional(),
    batchId: z.string().optional(),
  })
  .strict();

export const auditEntrySchema = z
  .object({
    entryId: z.string(),
    timestamp: z.date(),
    category: z.string(),
    action: z.string(),
    actor: z.string(),
    correlationIds: auditCorrelationIdsSchema,
    previousState: z.string().optional(),
    newState: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

// --- Redaction ---

/**
 * Returns a new AuditEntry with sensitive values in metadata sanitized.
 * Delegates to redactLog() for consistent redaction coverage (JWT, PEM,
 * Bearer, session IDs, passwords, API keys).
 * The original entry is never mutated.
 */
export function redactAuditEntry(entry: AuditEntry): AuditEntry {
  if (!entry.metadata) {
    return entry;
  }

  return { ...entry, metadata: redactLog(entry.metadata) };
}

// --- Factory ---

export function createAuditEntryId(): AuditEntryId {
  return randomUUID() as AuditEntryId;
}

export function createAuditEntry(params: {
  category: string;
  action: AuditAction;
  actor: AuditActor;
  correlationIds: AuditCorrelationIds;
  previousState?: string;
  newState?: string;
  metadata?: Record<string, unknown>;
  clock?: { now(): Date };
}): AuditEntry {
  return {
    entryId: createAuditEntryId(),
    timestamp: params.clock?.now() ?? new Date(),
    category: params.category,
    action: params.action,
    actor: params.actor,
    correlationIds: params.correlationIds,
    previousState: params.previousState,
    newState: params.newState,
    metadata: params.metadata,
  };
}
