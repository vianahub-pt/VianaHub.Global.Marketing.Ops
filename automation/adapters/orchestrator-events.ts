/**
 * Orchestrator event helpers.
 *
 * Provides helper functions for emitting operational events
 * and creating audit entries at key points in the orchestrator.
 */

import type { RunRecord } from "../domain/run-record.js";
import type { RunState } from "../domain/run-state.js";
import type { OperationalEmitter } from "../domain/operational-emitter.js";
import type {
  CorrelationIds,
  OperationalEventName,
  EventLevel,
} from "../domain/operational-event.js";
import { createOperationalEvent } from "../domain/operational-event.js";
import type { AuditRepository } from "../domain/audit-repository.js";
import type { AuditAction, AuditActor, AuditCorrelationIds } from "../domain/audit-entry.js";
import { createAuditEntry } from "../domain/audit-entry.js";
import type { Clock } from "../domain/clock.js";
import { redactLog } from "../domain/redaction.js";

// --- Helpers ---

function correlationFromRecord(record: RunRecord): CorrelationIds {
  return {
    runId: record.runId,
    scheduleId: record.metadata?.scheduleId as string | undefined,
    batchId: record.metadata?.batchId as string | undefined,
  };
}

function auditCorrelationFromRecord(record: RunRecord): AuditCorrelationIds {
  return {
    runId: record.runId,
    scheduleId: record.metadata?.scheduleId as string | undefined,
    batchId: record.metadata?.batchId as string | undefined,
  };
}

// --- Run Event Emission (AC-19) ---

/**
 * Emits a run lifecycle event and creates a corresponding audit entry.
 *
 * Called at key points in executeRun, resumeRun, and recoveryLoop.
 */
export async function emitRunEvent(params: {
  emitter: OperationalEmitter;
  auditRepo: AuditRepository;
  record: RunRecord;
  eventName: Extract<OperationalEventName, `run.${string}`>;
  level: EventLevel;
  message: string;
  actor: AuditActor;
  previousState?: RunState;
  metadata?: Record<string, unknown>;
  clock: Clock;
}): Promise<void> {
  const {
    emitter,
    auditRepo,
    record,
    eventName,
    level,
    message,
    actor,
    previousState,
    metadata,
    clock,
  } = params;

  const correlationIds = correlationFromRecord(record);
  const auditCorrelationIds = auditCorrelationFromRecord(record);

  // Emit operational event (AC-19)
  const event = createOperationalEvent({
    level,
    category: "run",
    name: eventName,
    message,
    correlationIds,
    metadata: metadata ? redactLog(metadata) : undefined,
    clock,
  });
  emitter.emit(event);

  // Create audit entry (AC-24)
  const auditAction = eventName as AuditAction;
  const entry = createAuditEntry({
    category: "run",
    action: auditAction,
    actor,
    correlationIds: auditCorrelationIds,
    previousState,
    newState: record.state,
    metadata: metadata ? redactLog(metadata) : undefined,
    clock,
  });
  await auditRepo.append(entry);
}

// --- Recovery Event Emission ---

export async function emitRecoveryEvent(params: {
  emitter: OperationalEmitter;
  auditRepo: AuditRepository;
  runId: string;
  scheduleId?: string;
  batchId?: string;
  eventName: Extract<OperationalEventName, `recovery.${string}`>;
  level: EventLevel;
  message: string;
  previousState?: string;
  newState?: string;
  metadata?: Record<string, unknown>;
  clock: Clock;
}): Promise<void> {
  const {
    emitter,
    auditRepo,
    runId,
    scheduleId,
    batchId,
    eventName,
    level,
    message,
    previousState,
    newState,
    metadata,
    clock,
  } = params;

  const correlationIds: CorrelationIds = { runId, scheduleId, batchId };
  const auditCorrelationIds: AuditCorrelationIds = { runId, scheduleId, batchId };

  // Emit operational event
  const event = createOperationalEvent({
    level,
    category: "recovery",
    name: eventName,
    message,
    correlationIds,
    metadata: metadata ? redactLog(metadata) : undefined,
    clock,
  });
  emitter.emit(event);

  // Create audit entry
  const auditAction = eventName as AuditAction;
  const entry = createAuditEntry({
    category: "recovery",
    action: auditAction,
    actor: "system",
    correlationIds: auditCorrelationIds,
    previousState,
    newState,
    metadata: metadata ? redactLog(metadata) : undefined,
    clock,
  });
  await auditRepo.append(entry);
}

// --- Schedule Event Emission ---

export async function emitScheduleEvent(params: {
  emitter: OperationalEmitter;
  auditRepo: AuditRepository;
  scheduleId: string;
  eventName: Extract<OperationalEventName, `schedule.${string}`>;
  level: EventLevel;
  message: string;
  runId?: string;
  batchId?: string;
  metadata?: Record<string, unknown>;
  clock: Clock;
}): Promise<void> {
  const {
    emitter,
    auditRepo,
    scheduleId,
    eventName,
    level,
    message,
    runId,
    batchId,
    metadata,
    clock,
  } = params;

  const correlationIds: CorrelationIds = { scheduleId, runId, batchId };
  const auditCorrelationIds: AuditCorrelationIds = { scheduleId, runId, batchId };

  const event = createOperationalEvent({
    level,
    category: "schedule",
    name: eventName,
    message,
    correlationIds,
    metadata: metadata ? redactLog(metadata) : undefined,
    clock,
  });
  emitter.emit(event);

  const auditAction = eventName as AuditAction;
  const entry = createAuditEntry({
    category: "schedule",
    action: auditAction,
    actor: "scheduled",
    correlationIds: auditCorrelationIds,
    metadata: metadata ? redactLog(metadata) : undefined,
    clock,
  });
  await auditRepo.append(entry);
}

// --- Batch Event Emission ---

export async function emitBatchEvent(params: {
  emitter: OperationalEmitter;
  auditRepo: AuditRepository;
  batchId: string;
  eventName: Extract<OperationalEventName, `batch.${string}`>;
  level: EventLevel;
  message: string;
  scheduleId?: string;
  runId?: string;
  itemId?: string;
  previousState?: string;
  newState?: string;
  metadata?: Record<string, unknown>;
  clock: Clock;
}): Promise<void> {
  const {
    emitter,
    auditRepo,
    batchId,
    eventName,
    level,
    message,
    scheduleId,
    runId,
    itemId,
    previousState,
    newState,
    metadata,
    clock,
  } = params;

  const correlationIds: CorrelationIds = { batchId, scheduleId, runId };
  const auditCorrelationIds: AuditCorrelationIds = { batchId, scheduleId, runId };

  const eventMetadata = {
    ...metadata,
    ...(itemId ? { itemId } : {}),
  };

  const event = createOperationalEvent({
    level,
    category: "batch",
    name: eventName,
    message,
    correlationIds,
    metadata: eventMetadata ? redactLog(eventMetadata) : undefined,
    clock,
  });
  emitter.emit(event);

  const auditAction = eventName as AuditAction;
  const entry = createAuditEntry({
    category: "batch",
    action: auditAction,
    actor: "system",
    correlationIds: auditCorrelationIds,
    previousState,
    newState,
    metadata: eventMetadata ? redactLog(eventMetadata) : undefined,
    clock,
  });
  await auditRepo.append(entry);
}
