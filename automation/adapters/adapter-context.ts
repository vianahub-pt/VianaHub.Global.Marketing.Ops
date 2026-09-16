import { z } from "zod";

import type { IdempotencyKey, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";

// ─── Sensitive field rejection ───────────────────────────────────────────────

const SENSITIVE_FIELD_PATTERN =
  /(?:token|secret|password|passwd|passphrase|cookie|session(?:id)?|authorization|credential|api[-_]?key|private[-_]?key|client[-_]?secret|access[-_]?key)/i;

function rejectSensitiveFields(value: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(value)) {
    if (SENSITIVE_FIELD_PATTERN.test(key)) {
      throw new Error(`Sensitive field "${key}" is not allowed in adapter context at ${path}`);
    }
  }
}

// ─── Context ─────────────────────────────────────────────────────────────────

export interface AdapterContext {
  readonly runId: RunId;
  readonly brandId: string;
  readonly market: string;
  readonly platform: string;
  readonly operation: string;
  readonly payload: unknown;
  readonly idempotencyKey: IdempotencyKey;
}

export const adapterContextSchema = z
  .object({
    runId: z.string().pipe(z.unknown() as z.ZodType<RunId>),
    brandId: z.string().min(1),
    market: z.string().min(1),
    platform: z.string().min(1),
    operation: z.string().min(1),
    payload: z.unknown(),
    idempotencyKey: z.string().pipe(z.unknown() as z.ZodType<IdempotencyKey>),
  })
  .strict()
  .superRefine((value, ctx) => {
    const obj = value as unknown as Record<string, unknown>;
    try {
      rejectSensitiveFields(obj, "$");
    } catch (error) {
      if (error instanceof Error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error.message,
        });
      }
    }
  });

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Builds an AdapterContext from an existing RunRecord.
 *
 * Only non-sensitive, non-domain fields are extracted. The `payload` field
 * must be supplied separately because it is not stored on RunRecord.
 */
export function buildAdapterContext(
  record: RunRecord,
  payload: unknown = undefined,
): AdapterContext {
  return {
    runId: record.runId,
    brandId: record.brandId,
    market: record.market,
    platform: record.platform,
    operation: record.operation,
    payload,
    idempotencyKey: record.idempotencyKey,
  };
}
