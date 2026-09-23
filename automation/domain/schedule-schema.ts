/**
 * Schedule configuration schema and types.
 *
 * Defines the configuration for automated scheduling
 * of run executions with cron expressions and timezone support.
 */

import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";

/**
 * Branded type for ScheduleId.
 */
export type ScheduleId = string & { readonly __brand: "ScheduleId" };

/**
 * Creates a new unique ScheduleId.
 */
export function createScheduleId(): ScheduleId {
  return randomUUID() as ScheduleId;
}

/**
 * Zod schema for cron expression validation.
 * Accepts standard 5-field format and convenience aliases.
 */
const _cronFieldSchema = z
  .string()
  .regex(/^(\*|\d+(-\d+)?(\/\d+)?)(,\s*(\*|\d+(-\d+)?(\/\d+)?))*$/, "Invalid cron field");

const cronAliasSchema = z.enum(["@daily", "@hourly", "@weekly", "@monthly", "@yearly"]);

const cronExpressionSchema = z.union([
  z.string().regex(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/, "Cron must have exactly 5 fields"),
  cronAliasSchema,
]);

/**
 * Zod schema for IANA timezone validation.
 */
const timezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid IANA timezone" },
);

/**
 * Zod schema for schedule configuration.
 */
export const scheduleConfigSchema = z
  .object({
    cron: cronExpressionSchema,
    timezone: timezoneSchema,
    brandId: z.string().min(1, "brandId is required"),
    market: z.string().min(1, "market is required"),
    platform: z.string().min(1, "platform is required"),
    operation: z.string().min(1, "operation is required"),
    enabled: z.boolean(),
    mode: z.enum(["single", "batch"]).default("single"),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * Type inferred from the schedule config schema.
 */
export type ScheduleConfig = z.infer<typeof scheduleConfigSchema>;

/**
 * Zod schema for schedule record (persisted state).
 */
export const scheduleRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    scheduleId: z.string(),
    idempotencyKey: z.string(),
    config: scheduleConfigSchema,
    createdAt: z.date(),
    updatedAt: z.date(),
    lastRunAt: z.date().optional(),
    nextRunAt: z.date().optional(),
    enabled: z.boolean(),
    revision: z.number().int().min(0),
  })
  .strict();

/**
 * Type inferred from the schedule record schema.
 */
export type ScheduleRecord = z.infer<typeof scheduleRecordSchema>;

/**
 * Computes a deterministic idempotency key from schedule config.
 * Same config always produces the same key.
 */
export function computeScheduleIdempotencyKey(config: ScheduleConfig): string {
  const { cron, timezone, brandId, market, platform, operation } = config;
  const payload = JSON.stringify({ cron, timezone, brandId, market, platform, operation });
  const hash = createHash("sha256").update(payload, "utf8").digest("hex");
  return `schedule:${hash}`;
}

/**
 * Creates a new ScheduleRecord from config.
 */
export function createScheduleRecord(config: ScheduleConfig): ScheduleRecord {
  const now = new Date();
  return {
    schemaVersion: 1,
    scheduleId: createScheduleId(),
    idempotencyKey: computeScheduleIdempotencyKey(config),
    config,
    createdAt: now,
    updatedAt: now,
    enabled: config.enabled,
    revision: 0,
  };
}
