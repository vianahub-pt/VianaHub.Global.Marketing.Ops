import { describe, expect, it } from "vitest";

import { InMemoryRunRepository } from "../adapters/in-memory-repo.js";
import { DeterministicClock } from "./clock.js";
import type { ScheduleRecord } from "./schedule-schema.js";
import { evaluateSchedules, MAX_CONCURRENT_BATCH } from "./scheduler-engine.js";
import type { SchedulerBatchDependencies } from "./scheduler-engine.js";
import type { BatchRepository, BatchWithItems } from "./batch-repository.js";
import type { BatchJob, BatchItem, BatchId, BatchItemId, BatchStatus } from "./batch-schema.js";
import type { PlatformAdapter } from "../adapters/platform-adapter.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a DeterministicClock at a fixed instant (10:30 UTC).
 */
function fixedClock(): DeterministicClock {
  return new DeterministicClock(new Date("2026-06-15T10:30:00Z"));
}

/**
 * Creates a schedule record with sensible defaults.
 * Cron defaults to "@hourly" (every hour at :00).
 * Timezone defaults to "UTC" for deterministic testing.
 */
function createSchedule(overrides?: Partial<ScheduleRecord>): ScheduleRecord {
  return {
    schemaVersion: 1,
    scheduleId: "sched-001",
    idempotencyKey: "schedule:abc123",
    config: {
      cron: "@hourly",
      timezone: "UTC",
      brandId: "best-fluency",
      market: "PT",
      platform: "google-ads",
      operation: "campaign-sync",
      enabled: true,
      mode: "single",
    },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    enabled: true,
    revision: 0,
    ...overrides,
  };
}

/**
 * Creates a schedule with a distinct platform to avoid idempotency key collisions.
 */
function createDistinctSchedule(index: number): ScheduleRecord {
  return createSchedule({
    scheduleId: `sched-${String(index).padStart(3, "0")}`,
    lastRunAt: new Date("2026-06-15T10:00:00Z"),
    config: {
      cron: "@hourly",
      timezone: "UTC",
      brandId: "best-fluency",
      market: "PT",
      platform: `platform-${index}`,
      operation: "campaign-sync",
      enabled: true,
      mode: "single",
    },
  });
}

// ─── In-memory BatchRepository for testing ────────────────────────────────────

class InMemoryBatchRepository implements BatchRepository {
  private readonly jobs = new Map<string, BatchJob>();
  private readonly items = new Map<string, BatchItem>();

  async createJob(job: BatchJob): Promise<BatchJob> {
    this.jobs.set(job.batchId, job);
    return job;
  }

  async getJobById(batchId: BatchId): Promise<BatchJob | null> {
    return this.jobs.get(batchId) ?? null;
  }

  async updateJob(job: BatchJob): Promise<BatchJob> {
    if (!this.jobs.has(job.batchId)) {
      throw new Error(`Batch job not found: ${job.batchId}`);
    }
    this.jobs.set(job.batchId, job);
    return job;
  }

  async createItem(item: BatchItem): Promise<BatchItem> {
    this.items.set(item.itemId, item);
    return item;
  }

  async getItemById(itemId: BatchItemId): Promise<BatchItem | null> {
    return this.items.get(itemId) ?? null;
  }

  async updateItem(item: BatchItem): Promise<BatchItem> {
    this.items.set(item.itemId, item);
    return item;
  }

  async listItemsByBatchId(batchId: BatchId): Promise<readonly BatchItem[]> {
    return Array.from(this.items.values()).filter((i) => i.batchId === batchId);
  }

  async listJobsByStatus(status: BatchStatus): Promise<readonly BatchJob[]> {
    return Array.from(this.jobs.values()).filter((j) => j.status === status);
  }

  async getBatchWithItems(batchId: BatchId): Promise<BatchWithItems | null> {
    const job = this.jobs.get(batchId);
    if (!job) {
      return null;
    }
    const items = Array.from(this.items.values()).filter((i) => i.batchId === batchId);
    return { job, items };
  }
}

// ─── Mock PlatformAdapter ─────────────────────────────────────────────────────

function createMockAdapter(): PlatformAdapter {
  return {
    async execute() {
      return { success: true, requiresManual: false };
    },
    async checkStatus() {
      return { state: "succeeded" };
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("evaluateSchedules", () => {
  // ── Test 1: No enabled schedules ──────────────────────────────────────────

  it("returns zero counts when no schedules are enabled", async () => {
    const repo = new InMemoryRunRepository();
    const clock = fixedClock();
    const schedules = [
      createSchedule({ enabled: false }),
      createSchedule({ scheduleId: "sched-002", enabled: false }),
    ];

    const result = await evaluateSchedules(schedules, repo, clock);

    expect(result.evaluated).toBe(0);
    expect(result.executed).toBe(0);
    expect(result.due).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // ── Test 2: Schedule not yet due ─────────────────────────────────────────

  it("returns due=0 when schedule is not yet due", async () => {
    const repo = new InMemoryRunRepository();
    // Clock at 10:30, schedule last ran at 10:00, next @hourly is 11:00 > 10:30
    const clock = fixedClock();
    const schedules = [
      createSchedule({
        lastRunAt: new Date("2026-06-15T10:00:00Z"),
      }),
    ];

    const result = await evaluateSchedules(schedules, repo, clock);

    expect(result.evaluated).toBe(1);
    expect(result.due).toBe(0);
    expect(result.executed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // ── Test 3: Schedule due, no overlap ─────────────────────────────────────

  it("creates a run when schedule is due and no overlap exists", async () => {
    const repo = new InMemoryRunRepository();
    // Clock at 11:05, schedule last ran at 10:00, @hourly → next is 11:00 ≤ 11:05
    const clock = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));
    const schedules = [
      createSchedule({
        lastRunAt: new Date("2026-06-15T10:00:00Z"),
      }),
    ];

    const result = await evaluateSchedules(schedules, repo, clock);

    expect(result.evaluated).toBe(1);
    expect(result.due).toBe(1);
    expect(result.executed).toBe(1);
    expect(result.skippedOverlap).toBe(0);
    expect(result.skippedConcurrency).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify run was persisted with correct fields
    const runs = await repo.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe("queued");
    expect(runs[0]!.brandId).toBe("best-fluency");
    expect(runs[0]!.market).toBe("PT");
    expect(runs[0]!.platform).toBe("google-ads");
    expect(runs[0]!.operation).toBe("campaign-sync");
    expect(runs[0]!.schemaVersion).toBe(1);
    expect(runs[0]!.attempt).toBe(1);
    expect(runs[0]!.maxAttempts).toBe(3);
    expect(runs[0]!.metadata).toBeDefined();
    expect(runs[0]!.metadata!.scheduleId).toBe("sched-001");
  });

  // ── Test 4: Schedule due, overlap exists ─────────────────────────────────

  it("skips execution when overlap exists (active run with same key)", async () => {
    const repo = new InMemoryRunRepository();
    const clock = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));

    const schedules = [
      createSchedule({
        lastRunAt: new Date("2026-06-15T10:00:00Z"),
      }),
    ];

    // First execution creates a queued run
    const firstResult = await evaluateSchedules(schedules, repo, clock);
    expect(firstResult.executed).toBe(1);

    // Second evaluation with same clock should detect overlap
    const clock2 = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));
    const secondResult = await evaluateSchedules(schedules, repo, clock2);

    expect(secondResult.skippedOverlap).toBe(1);
    expect(secondResult.executed).toBe(0);
    expect(secondResult.due).toBe(1);
  });

  // ── Test 5: Concurrency limit ────────────────────────────────────────────

  it("respects MAX_CONCURRENT_BATCH limit (5)", async () => {
    const repo = new InMemoryRunRepository();
    const clock = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));

    // Create 6 due schedules with distinct configs (different platforms)
    const schedules: ScheduleRecord[] = [];
    for (let i = 0; i < 6; i++) {
      schedules.push(createDistinctSchedule(i));
    }

    const result = await evaluateSchedules(schedules, repo, clock);

    expect(result.evaluated).toBe(6);
    expect(result.due).toBe(6);
    expect(result.executed).toBe(5);
    expect(result.skippedConcurrency).toBe(1);
    expect(result.skippedOverlap).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify exactly 5 runs were created
    const runs = await repo.list();
    expect(runs).toHaveLength(5);
  });

  // ── Test 6: Invalid cron expression ──────────────────────────────────────

  it("logs error and skips schedule with invalid cron", async () => {
    const repo = new InMemoryRunRepository();
    const clock = fixedClock();
    const schedules = [
      createSchedule({
        config: {
          cron: "invalid cron expression here too many",
          timezone: "UTC",
          brandId: "best-fluency",
          market: "PT",
          platform: "google-ads",
          operation: "campaign-sync",
          enabled: true,
          mode: "single",
        },
      }),
    ];

    const result = await evaluateSchedules(schedules, repo, clock);

    expect(result.evaluated).toBe(1);
    expect(result.executed).toBe(0);
    expect(result.due).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.scheduleId).toBe("sched-001");
    expect(result.errors[0]!.error).toBeTruthy();
  });

  // ── Test 7: Repository create throws error ───────────────────────────────

  it("captures repository errors in result.errors[]", async () => {
    const repo = new InMemoryRunRepository();
    // Override create to simulate a database error
    repo.create = async () => {
      throw new Error("database connection failed");
    };

    const clock = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));
    const schedules = [
      createSchedule({
        lastRunAt: new Date("2026-06-15T10:00:00Z"),
      }),
    ];

    const result = await evaluateSchedules(schedules, repo, clock);

    expect(result.evaluated).toBe(1);
    expect(result.due).toBe(1);
    expect(result.executed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.scheduleId).toBe("sched-001");
    expect(result.errors[0]!.error).toBe("database connection failed");
  });

  // ── Test 8: lastRunAt updated via scheduleRepo ──────────────────────────

  it("updates schedule lastRunAt when scheduleRepo is provided", async () => {
    const repo = new InMemoryRunRepository();

    // Simple in-memory schedule repository
    const scheduleStore = new Map<string, ScheduleRecord>();
    const scheduleRepo = {
      async create(record: ScheduleRecord) {
        scheduleStore.set(record.scheduleId, record);
        return record;
      },
      async getById(id: string) {
        return scheduleStore.get(id) ?? null;
      },
      async update(record: ScheduleRecord) {
        scheduleStore.set(record.scheduleId, record);
        return record;
      },
      async list() {
        return Array.from(scheduleStore.values());
      },
      async findByIdempotencyKey() {
        return null;
      },
    };

    const clock = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));
    const schedule = createSchedule({
      lastRunAt: new Date("2026-06-15T10:00:00Z"),
    });
    scheduleStore.set(schedule.scheduleId, schedule);

    const result = await evaluateSchedules([schedule], repo, clock, scheduleRepo);

    expect(result.executed).toBe(1);

    // Verify schedule was updated
    const updated = scheduleStore.get(schedule.scheduleId);
    expect(updated).toBeDefined();
    expect(updated!.lastRunAt).toEqual(new Date("2026-06-15T11:05:00Z"));
    expect(updated!.revision).toBe(1);
    expect(updated!.updatedAt).toEqual(new Date("2026-06-15T11:05:00Z"));
  });

  // ── Test 9: Deterministic with DeterministicClock ────────────────────────

  it("produces identical results across multiple evaluations with same clock", async () => {
    const schedules = [
      createSchedule({
        lastRunAt: new Date("2026-06-15T10:00:00Z"),
      }),
    ];

    // First run
    const repo1 = new InMemoryRunRepository();
    const clock1 = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));
    const result1 = await evaluateSchedules(schedules, repo1, clock1);

    // Second run with identical setup
    const repo2 = new InMemoryRunRepository();
    const clock2 = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));
    const result2 = await evaluateSchedules(schedules, repo2, clock2);

    // Results must be identical
    expect(result1.evaluated).toBe(result2.evaluated);
    expect(result1.due).toBe(result2.due);
    expect(result1.executed).toBe(result2.executed);
    expect(result1.skippedOverlap).toBe(result2.skippedOverlap);
    expect(result1.skippedConcurrency).toBe(result2.skippedConcurrency);
    expect(result1.errors).toHaveLength(result2.errors.length);

    // Runs must have identical idempotency keys
    const runs1 = await repo1.list();
    const runs2 = await repo2.list();
    expect(runs1).toHaveLength(1);
    expect(runs2).toHaveLength(1);
    expect(runs1[0]!.idempotencyKey).toBe(runs2[0]!.idempotencyKey);
  });

  // ── Test 10: Integration — run created and persisted correctly ───────────

  it("creates a complete run record with all required fields", async () => {
    const repo = new InMemoryRunRepository();
    const clock = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));
    const schedules = [
      createSchedule({
        lastRunAt: new Date("2026-06-15T10:00:00Z"),
      }),
    ];

    const result = await evaluateSchedules(schedules, repo, clock);
    expect(result.executed).toBe(1);

    const runs = await repo.list();
    const run = runs[0]!;

    // Verify all RunRecord fields are populated
    expect(run.schemaVersion).toBe(1);
    expect(run.runId).toBeTruthy();
    expect(run.brandId).toBe("best-fluency");
    expect(run.market).toBe("PT");
    expect(run.platform).toBe("google-ads");
    expect(run.operation).toBe("campaign-sync");
    expect(run.state).toBe("queued");
    expect(run.attempt).toBe(1);
    expect(run.maxAttempts).toBe(3);
    expect(run.idempotencyKey).toBeTruthy();
    expect(run.payloadFingerprint).toBeTruthy();
    expect(run.createdAt).toEqual(new Date("2026-06-15T11:05:00Z"));
    expect(run.updatedAt).toEqual(new Date("2026-06-15T11:05:00Z"));
    expect(run.metadata).toBeDefined();
    expect(run.metadata!.scheduleId).toBe("sched-001");
    expect(run.metadata!.scheduledAt).toBeTruthy();
  });

  // ── Test 11: redactLog applied to error outputs ─────────────────────────

  it("applies redaction to error messages (no sensitive data in output)", async () => {
    const repo = new InMemoryRunRepository();
    // Simulate an error with potentially sensitive content
    repo.create = async () => {
      throw new Error(
        "Connection failed: password=secret123 token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      );
    };

    const clock = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));
    const schedules = [
      createSchedule({
        lastRunAt: new Date("2026-06-15T10:00:00Z"),
      }),
    ];

    const result = await evaluateSchedules(schedules, repo, clock);

    expect(result.errors).toHaveLength(1);
    const errorMessage = result.errors[0]!.error;

    // Verify sensitive data is redacted
    expect(errorMessage).not.toContain("secret123");
    expect(errorMessage).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(errorMessage).toContain("[REDACTED]");
  });

  // ── Test 12: MAX_CONCURRENT_BATCH constant ──────────────────────────────

  it("exports MAX_CONCURRENT_BATCH = 5", () => {
    expect(MAX_CONCURRENT_BATCH).toBe(5);
    expect(typeof MAX_CONCURRENT_BATCH).toBe("number");
  });

  // ── Test 13: Batch mode creates BatchJob ──────────────────────────────

  it("creates BatchJob when schedule mode is 'batch'", async () => {
    const repo = new InMemoryRunRepository();
    const batchRepo = new InMemoryBatchRepository();
    const adapter = createMockAdapter();
    const clock = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));

    const schedules = [
      createSchedule({
        lastRunAt: new Date("2026-06-15T10:00:00Z"),
        config: {
          cron: "@hourly",
          timezone: "UTC",
          brandId: "best-fluency",
          market: "PT",
          platform: "google-ads",
          operation: "campaign-sync",
          enabled: true,
          mode: "batch",
          metadata: {
            items: [{ id: "item-1" }, { id: "item-2" }],
          },
        },
      }),
    ];

    const batchDeps: SchedulerBatchDependencies = { batchRepo, adapter };
    const result = await evaluateSchedules(schedules, repo, clock, undefined, batchDeps);

    expect(result.evaluated).toBe(1);
    expect(result.due).toBe(1);
    expect(result.executed).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify BatchJob was created and succeeded
    const jobs = await batchRepo.listJobsByStatus("succeeded");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.metadata?.scheduleId).toBe("sched-001");

    // Verify BatchItems were created
    const batchItems = await batchRepo.listItemsByBatchId(jobs[0]!.batchId);
    expect(batchItems).toHaveLength(2);

    // Verify RunRecords were created for each batch item
    const runs = await repo.list();
    expect(runs).toHaveLength(2);
    expect(runs[0]!.metadata?.batchId).toBe(jobs[0]!.batchId);
    expect(runs[1]!.metadata?.batchId).toBe(jobs[0]!.batchId);
  });

  // ── Test 14: Single mode explicitly creates RunRecord ─────────────────

  it("creates RunRecord when schedule mode is 'single'", async () => {
    const repo = new InMemoryRunRepository();
    const clock = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));

    const schedules = [
      createSchedule({
        lastRunAt: new Date("2026-06-15T10:00:00Z"),
        config: {
          cron: "@hourly",
          timezone: "UTC",
          brandId: "best-fluency",
          market: "PT",
          platform: "google-ads",
          operation: "campaign-sync",
          enabled: true,
          mode: "single",
        },
      }),
    ];

    const result = await evaluateSchedules(schedules, repo, clock);

    expect(result.executed).toBe(1);

    const runs = await repo.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe("queued");
    expect(runs[0]!.brandId).toBe("best-fluency");
  });

  // ── Test 15: Mode not defined uses single (default) ───────────────────

  it("defaults to single mode when mode field uses schema default", async () => {
    const repo = new InMemoryRunRepository();
    const clock = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));

    // createSchedule defaults to mode: "single"
    const schedules = [
      createSchedule({
        lastRunAt: new Date("2026-06-15T10:00:00Z"),
      }),
    ];

    const result = await evaluateSchedules(schedules, repo, clock);

    expect(result.executed).toBe(1);
    expect(result.errors).toHaveLength(0);

    const runs = await repo.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe("queued");
  });

  // ── Test 16: Batch mode overlap detection via BatchRepository ─────────

  it("skips batch execution when a running batch exists for the same schedule", async () => {
    const repo = new InMemoryRunRepository();
    const batchRepo = new InMemoryBatchRepository();
    const adapter = createMockAdapter();
    const clock = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));

    const schedules = [
      createSchedule({
        lastRunAt: new Date("2026-06-15T10:00:00Z"),
        config: {
          cron: "@hourly",
          timezone: "UTC",
          brandId: "best-fluency",
          market: "PT",
          platform: "google-ads",
          operation: "campaign-sync",
          enabled: true,
          mode: "batch",
          metadata: {
            items: [{ id: "item-1" }, { id: "item-2" }],
          },
        },
      }),
    ];

    // First execution creates a batch job (it will complete immediately with mock adapter)
    const batchDeps: SchedulerBatchDependencies = { batchRepo, adapter };
    const firstResult = await evaluateSchedules(schedules, repo, clock, undefined, batchDeps);
    expect(firstResult.executed).toBe(1);

    // Manually set the batch job status to "running" to simulate an active batch
    const jobs = await batchRepo.listJobsByStatus("succeeded");
    expect(jobs).toHaveLength(1);
    const runningJob = { ...jobs[0]!, status: "running" as const };
    await batchRepo.updateJob(runningJob);

    // Second evaluation should detect overlap via batch repo
    const clock2 = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));
    const secondResult = await evaluateSchedules(schedules, repo, clock2, undefined, batchDeps);

    expect(secondResult.skippedOverlap).toBe(1);
    expect(secondResult.executed).toBe(0);
    expect(secondResult.due).toBe(1);
  });

  // ── Test 17: Batch mode without dependencies produces error ───────────

  it("produces error when batch mode is used without batch dependencies", async () => {
    const repo = new InMemoryRunRepository();
    const clock = new DeterministicClock(new Date("2026-06-15T11:05:00Z"));

    const schedules = [
      createSchedule({
        lastRunAt: new Date("2026-06-15T10:00:00Z"),
        config: {
          cron: "@hourly",
          timezone: "UTC",
          brandId: "best-fluency",
          market: "PT",
          platform: "google-ads",
          operation: "campaign-sync",
          enabled: true,
          mode: "batch",
          metadata: {
            items: [{ id: "item-1" }],
          },
        },
      }),
    ];

    // No batchDeps provided
    const result = await evaluateSchedules(schedules, repo, clock);

    expect(result.evaluated).toBe(1);
    expect(result.due).toBe(1);
    expect(result.executed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.scheduleId).toBe("sched-001");
    expect(result.errors[0]!.error).toContain("Batch mode requires");
  });
});
