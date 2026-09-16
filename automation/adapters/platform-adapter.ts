import { z } from "zod";

import type { RunId } from "../domain/idempotency.js";
import type { RunError, RunState } from "../domain/run-state.js";

// ─── Re-exports from adapter-context.ts (retrocompatibility) ─────────────────

export {
  adapterContextSchema,
  buildAdapterContext,
  type AdapterContext,
} from "./adapter-context.js";

// Local type reference for use in PlatformAdapter interface
import type { AdapterContext } from "./adapter-context.js";

// ─── Result ──────────────────────────────────────────────────────────────────

export interface AdapterResult {
  readonly success: boolean;
  readonly output?: unknown;
  readonly error?: RunError;
  readonly requiresManual: boolean;
}

const runErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
});

export const adapterResultSchema = z
  .object({
    success: z.boolean(),
    output: z.unknown().optional(),
    error: runErrorSchema.optional(),
    requiresManual: z.boolean(),
  })
  .strict();

// ─── Status check ────────────────────────────────────────────────────────────

export interface StatusCheckResult {
  readonly state: RunState;
  readonly output?: unknown;
  readonly error?: RunError;
}

const runStateSchema = z.enum([
  "queued",
  "running",
  "waiting_manual",
  "succeeded",
  "failed",
  "cancelled",
]);

export const statusCheckResultSchema = z
  .object({
    state: runStateSchema,
    output: z.unknown().optional(),
    error: runErrorSchema.optional(),
  })
  .strict();

// ─── PlatformAdapter contract ────────────────────────────────────────────────

export interface PlatformAdapter {
  execute(context: AdapterContext): Promise<AdapterResult>;
  checkStatus(runId: RunId): Promise<StatusCheckResult>;
}
