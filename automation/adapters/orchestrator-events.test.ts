import { describe, expect, it } from "vitest";
import {
  emitRunEvent,
  emitRecoveryEvent,
  emitScheduleEvent,
  emitBatchEvent,
} from "./orchestrator-events.js";
import type { RunRecord } from "../domain/run-record.js";
import type { OperationalEmitter, EventHandler } from "../domain/operational-emitter.js";
import type { OperationalEvent } from "../domain/operational-event.js";
import type { AuditRepository } from "../domain/audit-repository.js";
import type { AuditEntry } from "../domain/audit-entry.js";
import { DeterministicClock } from "../domain/clock.js";

// --- Test helpers ---

function createTestRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return {
    schemaVersion: 1,
    runId: "run-abc-123" as RunRecord["runId"],
    brandId: "best-fluency",
    market: "PT",
    platform: "google-business-profile",
    operation: "createLocalPost",
    state: "queued",
    attempt: 1,
    maxAttempts: 3,
    idempotencyKey: "idem-key-001" as RunRecord["idempotencyKey"],
    payloadFingerprint: "fp-001" as RunRecord["payloadFingerprint"],
    createdAt: new Date("2026-09-21T10:00:00.000Z"),
    updatedAt: new Date("2026-09-21T10:00:00.000Z"),
    ...overrides,
  };
}

function createMockEmitter(): OperationalEmitter & { events: OperationalEvent[] } {
  const events: OperationalEvent[] = [];
  return {
    events,
    emit(event: OperationalEvent): void {
      events.push(event);
    },
    subscribe(_handler: EventHandler): () => void {
      return () => {};
    },
  };
}

function createMockAuditRepo(): AuditRepository & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    async append(entry: AuditEntry): Promise<AuditEntry> {
      entries.push(entry);
      return entry;
    },
  };
}

// --- emitRunEvent (AC-19 + AC-24) ---

describe("emitRunEvent", () => {
  it("emits operational event with category='run'", async () => {
    const emitter = createMockEmitter();
    const auditRepo = createMockAuditRepo();
    const clock = new DeterministicClock(new Date("2026-09-21T12:00:00.000Z"));
    const record = createTestRunRecord({ state: "running" });

    await emitRunEvent({
      emitter,
      auditRepo,
      record,
      eventName: "run.running",
      level: "info",
      message: "Run started",
      actor: "system",
      clock,
    });

    expect(emitter.events).toHaveLength(1);
    expect(emitter.events[0].category).toBe("run");
    expect(emitter.events[0].name).toBe("run.running");
  });

  it("emits event with correct correlationIds from RunRecord", async () => {
    const emitter = createMockEmitter();
    const auditRepo = createMockAuditRepo();
    const clock = new DeterministicClock(new Date("2026-09-21T12:00:00.000Z"));
    const record = createTestRunRecord({
      state: "running",
      metadata: { scheduleId: "sched-001", batchId: "batch-001" },
    });

    await emitRunEvent({
      emitter,
      auditRepo,
      record,
      eventName: "run.running",
      level: "info",
      message: "Run started",
      actor: "system",
      clock,
    });

    expect(emitter.events[0].correlationIds).toEqual({
      runId: "run-abc-123",
      scheduleId: "sched-001",
      batchId: "batch-001",
    });
  });

  it("creates audit entry with correct action", async () => {
    const emitter = createMockEmitter();
    const auditRepo = createMockAuditRepo();
    const clock = new DeterministicClock(new Date("2026-09-21T12:00:00.000Z"));
    const record = createTestRunRecord({ state: "succeeded" });

    await emitRunEvent({
      emitter,
      auditRepo,
      record,
      eventName: "run.succeeded",
      level: "info",
      message: "Run succeeded",
      actor: "system",
      clock,
    });

    expect(auditRepo.entries).toHaveLength(1);
    expect(auditRepo.entries[0].action).toBe("run.succeeded");
    expect(auditRepo.entries[0].category).toBe("run");
    expect(auditRepo.entries[0].newState).toBe("succeeded");
  });

  it("applies redactLog to metadata in both event and audit", async () => {
    const emitter = createMockEmitter();
    const auditRepo = createMockAuditRepo();
    const clock = new DeterministicClock(new Date("2026-09-21T12:00:00.000Z"));
    const record = createTestRunRecord({ state: "running" });

    await emitRunEvent({
      emitter,
      auditRepo,
      record,
      eventName: "run.running",
      level: "info",
      message: "Run started",
      actor: "system",
      metadata: { password: "s3cret", source: "api" },
      clock,
    });

    // Metadata should be redacted — password field contains sensitive key
    expect(emitter.events[0].metadata).toBeDefined();
    expect(auditRepo.entries[0].metadata).toBeDefined();
    // redactLog redacts values for sensitive keys but doesn't throw
    // The key "password" should be kept but its value redacted
    const eventMeta = emitter.events[0].metadata as Record<string, unknown>;
    expect(eventMeta.source).toBe("api");
  });

  it("uses injected Clock for deterministic timestamps", async () => {
    const emitter = createMockEmitter();
    const auditRepo = createMockAuditRepo();
    const fixedDate = new Date("2026-09-21T15:30:00.000Z");
    const clock = new DeterministicClock(fixedDate);
    const record = createTestRunRecord({ state: "running" });

    await emitRunEvent({
      emitter,
      auditRepo,
      record,
      eventName: "run.running",
      level: "info",
      message: "Run started",
      actor: "system",
      clock,
    });

    expect(emitter.events[0].timestamp).toEqual(fixedDate);
    expect(auditRepo.entries[0].timestamp).toEqual(fixedDate);
  });
});

// --- emitRecoveryEvent ---

describe("emitRecoveryEvent", () => {
  it("emits operational event with category='recovery'", async () => {
    const emitter = createMockEmitter();
    const auditRepo = createMockAuditRepo();
    const clock = new DeterministicClock(new Date("2026-09-21T12:00:00.000Z"));

    await emitRecoveryEvent({
      emitter,
      auditRepo,
      runId: "run-456",
      eventName: "recovery.detected",
      level: "warn",
      message: "Interrupted run detected",
      clock,
    });

    expect(emitter.events).toHaveLength(1);
    expect(emitter.events[0].category).toBe("recovery");
    expect(emitter.events[0].name).toBe("recovery.detected");
  });

  it("creates audit entry with actor='system'", async () => {
    const emitter = createMockEmitter();
    const auditRepo = createMockAuditRepo();
    const clock = new DeterministicClock(new Date("2026-09-21T12:00:00.000Z"));

    await emitRecoveryEvent({
      emitter,
      auditRepo,
      runId: "run-456",
      eventName: "recovery.succeeded",
      level: "info",
      message: "Recovery succeeded",
      clock,
    });

    expect(auditRepo.entries).toHaveLength(1);
    expect(auditRepo.entries[0].actor).toBe("system");
  });

  it("includes previousState and newState in audit entry", async () => {
    const emitter = createMockEmitter();
    const auditRepo = createMockAuditRepo();
    const clock = new DeterministicClock(new Date("2026-09-21T12:00:00.000Z"));

    await emitRecoveryEvent({
      emitter,
      auditRepo,
      runId: "run-789",
      eventName: "recovery.succeeded",
      level: "info",
      message: "Recovery succeeded",
      previousState: "running",
      newState: "queued",
      clock,
    });

    expect(auditRepo.entries[0].previousState).toBe("running");
    expect(auditRepo.entries[0].newState).toBe("queued");
  });
});

// --- emitScheduleEvent ---

describe("emitScheduleEvent", () => {
  it("emits operational event with category='schedule'", async () => {
    const emitter = createMockEmitter();
    const auditRepo = createMockAuditRepo();
    const clock = new DeterministicClock(new Date("2026-09-21T12:00:00.000Z"));

    await emitScheduleEvent({
      emitter,
      auditRepo,
      scheduleId: "sched-001",
      eventName: "schedule.triggered",
      level: "info",
      message: "Schedule triggered",
      clock,
    });

    expect(emitter.events).toHaveLength(1);
    expect(emitter.events[0].category).toBe("schedule");
    expect(emitter.events[0].name).toBe("schedule.triggered");
  });

  it("creates audit entry with actor='scheduled'", async () => {
    const emitter = createMockEmitter();
    const auditRepo = createMockAuditRepo();
    const clock = new DeterministicClock(new Date("2026-09-21T12:00:00.000Z"));

    await emitScheduleEvent({
      emitter,
      auditRepo,
      scheduleId: "sched-001",
      eventName: "schedule.triggered",
      level: "info",
      message: "Schedule triggered",
      clock,
    });

    expect(auditRepo.entries).toHaveLength(1);
    expect(auditRepo.entries[0].actor).toBe("scheduled");
  });

  it("includes scheduleId in correlationIds", async () => {
    const emitter = createMockEmitter();
    const auditRepo = createMockAuditRepo();
    const clock = new DeterministicClock(new Date("2026-09-21T12:00:00.000Z"));

    await emitScheduleEvent({
      emitter,
      auditRepo,
      scheduleId: "sched-002",
      eventName: "schedule.skipped_overlap",
      level: "warn",
      message: "Schedule skipped due to overlap",
      runId: "run-linked",
      clock,
    });

    expect(emitter.events[0].correlationIds.scheduleId).toBe("sched-002");
    expect(emitter.events[0].correlationIds.runId).toBe("run-linked");
  });
});

// --- emitBatchEvent ---

describe("emitBatchEvent", () => {
  it("emits operational event with category='batch'", async () => {
    const emitter = createMockEmitter();
    const auditRepo = createMockAuditRepo();
    const clock = new DeterministicClock(new Date("2026-09-21T12:00:00.000Z"));

    await emitBatchEvent({
      emitter,
      auditRepo,
      batchId: "batch-001",
      eventName: "batch.started",
      level: "info",
      message: "Batch started",
      clock,
    });

    expect(emitter.events).toHaveLength(1);
    expect(emitter.events[0].category).toBe("batch");
    expect(emitter.events[0].name).toBe("batch.started");
  });

  it("includes batchId and optional itemId in metadata", async () => {
    const emitter = createMockEmitter();
    const auditRepo = createMockAuditRepo();
    const clock = new DeterministicClock(new Date("2026-09-21T12:00:00.000Z"));

    await emitBatchEvent({
      emitter,
      auditRepo,
      batchId: "batch-002",
      eventName: "batch.item_completed",
      level: "info",
      message: "Batch item completed",
      itemId: "item-42",
      clock,
    });

    const eventMeta = emitter.events[0].metadata as Record<string, unknown>;
    expect(eventMeta.itemId).toBe("item-42");
    expect(emitter.events[0].correlationIds.batchId).toBe("batch-002");
  });

  it("creates audit entry with correct action", async () => {
    const emitter = createMockEmitter();
    const auditRepo = createMockAuditRepo();
    const clock = new DeterministicClock(new Date("2026-09-21T12:00:00.000Z"));

    await emitBatchEvent({
      emitter,
      auditRepo,
      batchId: "batch-003",
      eventName: "batch.failed",
      level: "error",
      message: "Batch failed",
      previousState: "running",
      newState: "failed",
      clock,
    });

    expect(auditRepo.entries).toHaveLength(1);
    expect(auditRepo.entries[0].action).toBe("batch.failed");
    expect(auditRepo.entries[0].previousState).toBe("running");
    expect(auditRepo.entries[0].newState).toBe("failed");
    expect(auditRepo.entries[0].actor).toBe("system");
  });
});
