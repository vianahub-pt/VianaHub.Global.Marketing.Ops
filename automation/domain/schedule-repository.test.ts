import { describe, expect, it } from "vitest";

import type { ScheduleRepository, ScheduleListFilters } from "./schedule-repository.js";
import type { ScheduleConfig } from "./schedule-schema.js";
import { scheduleConfigSchema, createScheduleRecord } from "./schedule-schema.js";

const validConfig: ScheduleConfig = {
  cron: "*/15 * * * *",
  timezone: "Europe/Lisbon",
  brandId: "best-fluency",
  market: "PT",
  platform: "instagram",
  operation: "publish",
  enabled: true,
  mode: "single",
};

describe("ScheduleRepository interface", () => {
  it("has all required methods", () => {
    const stub: ScheduleRepository = {
      create: async (record) => record,
      getById: async () => null,
      update: async (record) => record,
      list: async () => [],
      findByIdempotencyKey: async () => null,
    };

    expect(stub.create).toBeTypeOf("function");
    expect(stub.getById).toBeTypeOf("function");
    expect(stub.update).toBeTypeOf("function");
    expect(stub.list).toBeTypeOf("function");
    expect(stub.findByIdempotencyKey).toBeTypeOf("function");
  });
});

describe("ScheduleListFilters", () => {
  it("accepts all optional fields", () => {
    const filters: ScheduleListFilters = {
      brandId: "best-fluency",
      market: "PT",
      platform: "instagram",
      enabled: true,
    };

    expect(filters.brandId).toBe("best-fluency");
    expect(filters.market).toBe("PT");
    expect(filters.platform).toBe("instagram");
    expect(filters.enabled).toBe(true);
  });

  it("accepts empty filters", () => {
    const filters: ScheduleListFilters = {};
    expect(Object.keys(filters)).toHaveLength(0);
  });
});

describe("ScheduleRecord fields", () => {
  it("contains all required fields", () => {
    const record = createScheduleRecord(validConfig);

    expect(record.schemaVersion).toBe(1);
    expect(typeof record.scheduleId).toBe("string");
    expect(typeof record.idempotencyKey).toBe("string");
    expect(record.config).toEqual(validConfig);
    expect(record.createdAt).toBeInstanceOf(Date);
    expect(record.updatedAt).toBeInstanceOf(Date);
  });

  it("lastRunAt is optional and can be undefined", () => {
    const record = createScheduleRecord(validConfig);
    expect(record.lastRunAt).toBeUndefined();
  });

  it("nextRunAt is optional and can be undefined", () => {
    const record = createScheduleRecord(validConfig);
    expect(record.nextRunAt).toBeUndefined();
  });

  it("nextRunAt accepts Date values", () => {
    const record = createScheduleRecord(validConfig);
    const withNextRun = { ...record, nextRunAt: new Date() };
    expect(withNextRun.nextRunAt).toBeInstanceOf(Date);
  });

  it("revision is an integer >= 0", () => {
    const record = createScheduleRecord(validConfig);
    expect(record.revision).toBe(0);
    expect(Number.isInteger(record.revision)).toBe(true);
    expect(record.revision).toBeGreaterThanOrEqual(0);
  });

  it("enabled matches config.enabled", () => {
    const record = createScheduleRecord(validConfig);
    expect(record.enabled).toBe(true);
    expect(record.enabled).toBe(validConfig.enabled);
  });

  it("enabled is false when config.enabled is false", () => {
    const disabledConfig = { ...validConfig, enabled: false };
    const record = createScheduleRecord(disabledConfig);
    expect(record.enabled).toBe(false);
  });
});

describe("ScheduleConfig Zod compatibility", () => {
  it("scheduleConfigSchema.parse works with valid config", () => {
    const result = scheduleConfigSchema.parse(validConfig);
    expect(result).toEqual(validConfig);
  });

  it("scheduleConfigSchema.parse rejects invalid config", () => {
    expect(() => scheduleConfigSchema.parse({ ...validConfig, cron: "" })).toThrow();
  });
});
