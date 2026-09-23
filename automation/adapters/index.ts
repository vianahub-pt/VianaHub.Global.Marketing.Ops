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

export { executeRun, resumeRun, recoveryLoop } from "./orchestrator.js";
export type { RecoveryResult, RecoveryStrategy, AutomatedRecoveryResult } from "./recovery.js";
export { detectInterruptedRuns, recoverRun, automatedRecoveryLoop } from "./recovery.js";
export { synchronizeStatus, resolveAdapterState } from "./status-sync.js";
export type { ReconciledResult } from "./status-sync.js";

export { GbpDryRunAdapter } from "./gbp-dry-run-adapter.js";
export type { DryRunPostPayload, DryRunPostResult } from "./gbp-dry-run-adapter.js";

export { InMemoryRunRepository } from "./in-memory-repo.js";
export { FileRunRepository } from "./file-run-repo.js";
export type { FileStoredRunRecord } from "./file-run-repo.js";

export { FileCheckpointRepository } from "./file-checkpoint-repo.js";
export type { CheckpointRepository, CheckpointDto } from "./checkpoint-repository.js";

export { FileScheduleRepository } from "./file-schedule-repo.js";

export { FileAuditRepository } from "./file-audit-repo.js";

export {
  PersistenceError,
  CorruptedRecordError,
  ConcurrencyConflictError,
} from "./persistence-errors.js";

export { GoogleBusinessProfileAdapter } from "./google-business-profile-adapter.js";
export type {
  CreateLocalPostPayload,
  CreateLocalPostResult,
} from "./google-business-profile-adapter.js";

export {
  checkGbpPreflight,
  checkGbpPreflightReal,
  loadGbpConfig,
} from "./access-preflight-gate.js";
export type {
  PreflightStatus,
  PreflightCheckResult,
  PreflightCheck,
  RealPreflightCheckResult,
} from "./access-preflight-gate.js";

export {
  checkPilotScope,
  checkLivePilotGate,
  PILOT_ALLOWED_BRANDS,
  PILOT_ALLOWED_MARKETS,
  PILOT_ALLOWED_PLATFORMS,
  PILOT_ALLOWED_OPERATIONS,
} from "./pilot-scope.js";
export type {
  PilotScopeCheckResult,
  PilotScopeViolation,
  LivePilotGateStatus,
  LivePilotGateResult,
  LivePilotCheck,
} from "./pilot-scope.js";

export {
  emitRunEvent,
  emitRecoveryEvent,
  emitScheduleEvent,
  emitBatchEvent,
} from "./orchestrator-events.js";

export { createConsoleAlertEmitter } from "./console-alert-emitter.js";
export { createFileAlertEmitter, readPersistedAlerts } from "./file-alert-emitter.js";

export { detectPotentialOrphanLocks } from "./orphan-lock-detector.js";
export type { OrphanLockInfo, OrphanLockScanResult } from "./orphan-lock-detector.js";

export { GracefulShutdown, registerShutdownHandlers } from "./shutdown.js";
export type {
  ShutdownConfig,
  ShutdownDependencies,
  ShutdownState,
  ShutdownResult,
} from "./shutdown.js";
