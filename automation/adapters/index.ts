export {
  adapterContextSchema,
  adapterResultSchema,
  buildAdapterContext,
  statusCheckResultSchema,
} from "./platform-adapter.js";
export type {
  AdapterContext,
  AdapterResult,
  PlatformAdapter,
  StatusCheckResult,
} from "./platform-adapter.js";

export { FakeAdapter } from "./fake-adapter.js";
export type { FakeAdapterMode } from "./fake-adapter.js";

export { executeRun, resumeRun } from "./orchestrator.js";
export { synchronizeStatus, resolveAdapterState } from "./status-sync.js";
export type { ReconciledResult } from "./status-sync.js";
