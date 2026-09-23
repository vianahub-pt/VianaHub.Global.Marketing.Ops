import { describe, expect, it } from "vitest";
import {
  scheduleConfigSchema,
  scheduleRecordSchema,
  createScheduleId,
  computeScheduleIdempotencyKey,
  createScheduleRecord,
} from "./schedule-schema.js";
import type { ScheduleConfig } from "./schedule-schema.js";

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

describe("scheduleConfigSchema", () => {
  describe("cron expression validation", () => {
    it.each(["*/15 * * * *", "0 9 * * 1-5", "0 0 1 1 *"])(
      "accepts valid cron expression %s",
      (cron) => {
        const result = scheduleConfigSchema.safeParse({ ...validConfig, cron });
        expect(result.success).toBe(true);
      },
    );

    it.each(["@daily", "@hourly", "@weekly", "@monthly", "@yearly"])(
      "accepts cron alias %s",
      (cron) => {
        const result = scheduleConfigSchema.safeParse({ ...validConfig, cron });
        expect(result.success).toBe(true);
      },
    );

    it("rejects invalid cron expression", () => {
      const result = scheduleConfigSchema.safeParse({
        ...validConfig,
        cron: "abc",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty cron expression", () => {
      const result = scheduleConfigSchema.safeParse({
        ...validConfig,
        cron: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("timezone validation", () => {
    it.each(["Europe/Lisbon", "America/Sao_Paulo", "UTC"])(
      "accepts valid IANA timezone %s",
      (timezone) => {
        const result = scheduleConfigSchema.safeParse({ ...validConfig, timezone });
        expect(result.success).toBe(true);
      },
    );

    it("rejects invalid timezone", () => {
      const result = scheduleConfigSchema.safeParse({
        ...validConfig,
        timezone: "XYZ",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("required fields validation", () => {
    it("rejects empty brandId", () => {
      const result = scheduleConfigSchema.safeParse({
        ...validConfig,
        brandId: "",
      });
      expect(result.success).toBe(false);
    });

    it("rejects enabled as string", () => {
      const result = scheduleConfigSchema.safeParse({
        ...validConfig,
        enabled: "true" as unknown as boolean,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("strict mode", () => {
    it("rejects extra fields", () => {
      const result = scheduleConfigSchema.safeParse({
        ...validConfig,
        extraField: "not allowed",
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("ScheduleId branded type", () => {
  it("creates unique string identifiers", () => {
    const first = createScheduleId();
    const second = createScheduleId();

    expect(typeof first).toBe("string");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

describe("computeScheduleIdempotencyKey", () => {
  it("returns the same key for identical configs", () => {
    const first = computeScheduleIdempotencyKey(validConfig);
    const second = computeScheduleIdempotencyKey(validConfig);

    expect(first).toBe(second);
  });

  it("returns different keys for different configs", () => {
    const first = computeScheduleIdempotencyKey(validConfig);
    const second = computeScheduleIdempotencyKey({
      ...validConfig,
      cron: "0 0 * * *",
    });

    expect(first).not.toBe(second);
  });

  it("returns a string starting with schedule:", () => {
    const key = computeScheduleIdempotencyKey(validConfig);
    expect(key).toMatch(/^schedule:/);
  });
});

describe("createScheduleRecord", () => {
  it("populates all fields correctly", () => {
    const record = createScheduleRecord(validConfig);

    expect(record.schemaVersion).toBe(1);
    expect(typeof record.scheduleId).toBe("string");
    expect(record.scheduleId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(record.idempotencyKey).toBe(computeScheduleIdempotencyKey(validConfig));
    expect(record.config).toEqual(validConfig);
    expect(record.createdAt).toBeInstanceOf(Date);
    expect(record.updatedAt).toBeInstanceOf(Date);
    expect(record.createdAt.getTime()).toBe(record.updatedAt.getTime());
    expect(record.revision).toBe(0);
    expect(record.lastRunAt).toBeUndefined();
    expect(record.nextRunAt).toBeUndefined();
    expect(record.enabled).toBe(true);
  });

  it("validates against the schedule record schema", () => {
    const record = createScheduleRecord(validConfig);
    const result = scheduleRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
  });
});
