export type RunState =
  "queued" | "running" | "waiting_manual" | "succeeded" | "failed" | "cancelled";

export interface RunError {
  message: string;
  code?: string;
  retryable?: boolean;
}

export const INITIAL_STATE: RunState = "queued";
