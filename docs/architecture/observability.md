# Observability — Events, Audit & Alerts

> Sprint 4 — Scheduling + Observability + Operational Hardening

## Overview

The observability subsystem provides structured, correlated visibility into the execution lifecycle through three complementary mechanisms:

1. **Operational Events** — Real-time, ephemeral notifications for monitoring and alerting.
2. **Audit Entries** — Immutable, persisted history for compliance, debugging, and forensics.
3. **Alerts** — Severity-classified notifications with deduplication for operational escalation.

All three mechanisms share a common correlation model (`runId`, `scheduleId`, `batchId`) and enforce strict secret rejection to prevent credential leaks.

---

## Core Types

### Operational Events

#### `OperationalEvent`

```typescript
interface OperationalEvent {
  readonly eventId: EventId;             // UUID
  readonly timestamp: Date;
  readonly level: EventLevel;            // "info" | "warn" | "error"
  readonly category: EventCategory;      // "run" | "schedule" | "batch" | "recovery" | "system"
  readonly name: OperationalEventName;   // e.g., "run.succeeded", "batch.partial_failure"
  readonly message: string;
  readonly correlationIds: CorrelationIds;
  readonly metadata?: Record<string, unknown>;
}
```

#### `OperationalEmitter`

```typescript
interface OperationalEmitter {
  emit(event: OperationalEvent): void;
  subscribe(handler: EventHandler): () => void;
}
```

#### Event Name Catalog

| Category | Event Names |
| --- | --- |
| `run` | `run.queued`, `run.running`, `run.succeeded`, `run.failed`, `run.waiting_manual` |
| `schedule` | `schedule.triggered`, `schedule.skipped_overlap`, `schedule.skipped_concurrency`, `schedule.error` |
| `batch` | `batch.started`, `batch.item_completed`, `batch.item_failed`, `batch.succeeded`, `batch.partial_failure`, `batch.failed` |
| `recovery` | `recovery.detected`, `recovery.succeeded`, `recovery.failed`, `recovery.skipped` |
| `system` | `system.startup`, `system.shutdown`, `system.error` |

---

### Audit Entries

#### `AuditEntry`

```typescript
interface AuditEntry {
  readonly entryId: AuditEntryId;        // UUID
  readonly timestamp: Date;
  readonly category: string;
  readonly action: AuditAction;          // e.g., "run.succeeded"
  readonly actor: AuditActor;            // "system" | "scheduled" | "manual" | string
  readonly correlationIds: AuditCorrelationIds;
  readonly previousState?: string;       // State before transition
  readonly newState?: string;            // State after transition
  readonly metadata?: Record<string, unknown>;
}
```

#### `AuditRepository`

```typescript
interface AuditRepository {
  append(entry: AuditEntry): Promise<AuditEntry>;
  list?(filters?: AuditListFilters): Promise<AuditEntry[]>;
  listByCorrelation?(correlationIds: AuditCorrelationIds): Promise<readonly AuditEntry[]>;
  listByTimeRange?(range: AuditTimeRange): Promise<readonly AuditEntry[]>;
  listByCategory?(category: AuditCategory): Promise<readonly AuditEntry[]>;
}
```

---

### Alerts

#### `AlertEntry`

```typescript
interface AlertEntry {
  readonly alertId: AlertId;             // UUID
  readonly timestamp: Date;
  readonly severity: AlertSeverity;      // "info" | "warn" | "error" | "critical"
  readonly category: AlertCategory;      // "recovery" | "lock" | "schedule" | "batch" | "system" | "pilot"
  readonly message: string;
  readonly correlationIds: AlertCorrelationIds;
  readonly deduplicationKey?: string;    // For dedup within window
  readonly suppressedCount?: number;     // Populated when deduplicated
  readonly metadata?: Record<string, unknown>;
}
```

#### `AlertEmitter`

```typescript
interface AlertEmitter {
  emit(alert: AlertEntry): AlertEntry;
  subscribe(handler: AlertHandler): () => void;
}
```

---

## Distinction: Audit Entries vs RunRecord.metadata (AC-25)

| Aspect | `AuditEntry` | `RunRecord.metadata` |
| --- | --- | --- |
| **Mutability** | Immutable — append-only, no `update()` or `delete()` | Mutable — updated via `RunRepository.update()` |
| **Purpose** | Compliance history, forensics, state transition tracking | Operational context, batch correlation, adapter data |
| **Persistence** | Individual JSON files (one per entry) | Embedded in RunRecord JSON file |
| **Lifecycle** | Created at each state transition; never modified | Created with run; updated as run progresses |
| **State tracking** | Explicit `previousState` / `newState` fields | No state tracking; reflects current run state |
| **Query** | By correlation IDs, time range, category | By run filters (brandId, market, state, etc.) |
| **Redaction** | `redactAuditEntry()` applied before persistence | `redactLog()` applied at event emission time |

**Key design decision:** Audit entries capture the _history_ of state transitions as immutable facts. `RunRecord.metadata` captures the _current_ operational context as mutable state. They serve different purposes and must not be conflated.

---

## Correlation Model

All three observability mechanisms share a common correlation structure:

```typescript
interface CorrelationIds {
  readonly runId?: string;
  readonly scheduleId?: string;
  readonly batchId?: string;
}
```

**Correlation rules:**

- **Run events:** Always include `runId`. Optionally include `scheduleId` and `batchId` from `RunRecord.metadata`.
- **Schedule events:** Always include `scheduleId`. Optionally include `runId` and `batchId`.
- **Batch events:** Always include `batchId`. Optionally include `scheduleId` and `runId`.
- **Recovery events:** Always include `runId`. Optionally include `scheduleId` and `batchId`.
- **System events:** Empty correlation IDs (system-wide).

---

## Emission Helpers (`orchestrator-events.ts`)

The orchestrator provides helper functions that emit both an operational event AND create a corresponding audit entry in a single call:

| Function | Description |
| --- | --- |
| `emitRunEvent(params)` | Emits a run lifecycle event + creates audit entry. Called at `executeRun`, `resumeRun`, `recoveryLoop`. |
| `emitScheduleEvent(params)` | Emits a schedule event + creates audit entry. Called at `evaluateSchedules`. |
| `emitBatchEvent(params)` | Emits a batch event + creates audit entry. Called at `executeBatch`. |
| `emitRecoveryEvent(params)` | Emits a recovery event + creates audit entry. Called at `recoveryLoop`. |

**Dual-write pattern:**

```
emitRunEvent({ emitter, auditRepo, record, eventName, ... })
    │
    ├──► createOperationalEvent({ level, category, name, ... })
    │       └── emitter.emit(event)         ← ephemeral, real-time
    │
    └──► createAuditEntry({ category, action, actor, ... })
            └── auditRepo.append(entry)     ← persisted, immutable
```

---

## Secret Rejection

### OperationalEvent Metadata

`operationalEventSchema` (Zod) includes a `superRefine` that calls `rejectSensitiveMetadata()`:

- **Field name patterns:** `token`, `secret`, `password`, `api_key`, `private_key`, `client_secret`, `authorization`, `credential`, etc.
- **Value patterns:** JWT (`eyJ...`), Bearer (`Bearer ...`), PEM (`-----BEGIN ...-----`), cookie patterns.

Rejection throws at event creation time — the event is never emitted.

### AuditEntry Metadata

`redactAuditEntry()` is applied before persistence:

- JWT tokens → `[REDACTED]`
- Bearer tokens → `Bearer [REDACTED]`
- Password/secret assignments → value replaced with `[REDACTED]`

### Alert Metadata

`redactLog()` is applied by each adapter before persistence or console output.

---

## Alert Deduplication (AC-29)

The `AlertEmitter` supports deduplication via `deduplicationKey` within a configurable sliding window (default: 5 minutes).

```
Alert 1: { deduplicationKey: "lock:run-123", severity: "error" }
    → Dispatched to subscribers. Recorded in dedup map.

Alert 2: { deduplicationKey: "lock:run-123", severity: "error" }  (within 5 min)
    → Suppressed. suppressedCount incremented on original.

Alert 3: { deduplicationKey: "lock:run-123", severity: "error" }  (after 5 min)
    → Dispatched (window expired). New dedup cycle starts.
```

**Dedup state:**

```typescript
interface DeduplicationRecord {
  readonly firstSeen: Date;
  readonly alertId: AlertId;
  suppressedCount: number;
}
```

---

## Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                  Observability Event Flow                        │
│                                                                 │
│  Domain Event Occurs (state transition, schedule trigger, etc.) │
│       │                                                         │
│       ▼                                                         │
│  ┌─────────────────┐     ┌──────────────────┐                   │
│  │ emit*Event()     │────►│ OperationalEvent │                   │
│  │ (orchestrator-   │     │                  │                   │
│  │  events.ts)      │     └────────┬─────────┘                   │
│  │                  │              │                             │
│  │                  │              ▼                             │
│  │                  │     ┌──────────────────┐                   │
│  │                  │     │ OperationalEmitter│                   │
│  │                  │     │  .emit(event)     │                   │
│  │                  │     └────────┬─────────┘                   │
│  │                  │              │                             │
│  │                  │              ▼                             │
│  │                  │     ┌──────────────────┐                   │
│  │                  │     │  Subscribers      │                   │
│  │                  │     │  (in-memory)      │                   │
│  │                  │     └──────────────────┘                   │
│  │                  │                                            │
│  │                  │     ┌──────────────────┐                   │
│  │                  │────►│ AuditEntry        │                   │
│  │                  │     │  .append(entry)   │                   │
│  │                  │     └────────┬─────────┘                   │
│  │                  │              │                             │
│  └─────────────────┘              ▼                             │
│                          ┌──────────────────┐                   │
│                          │ AuditRepository   │                   │
│                          │  (file-based)     │                   │
│                          └──────────────────┘                   │
│                                                                 │
│  Alert Condition Detected                                       │
│       │                                                         │
│       ▼                                                         │
│  ┌─────────────────┐                                            │
│  │ AlertEmitter     │                                           │
│  │  .emit(alert)    │──── Dedup check ────┐                     │
│  └────────┬────────┘                      │                     │
│           │                               ▼                     │
│           ▼                       ┌──────────────┐              │
│  ┌─────────────────┐              │ Dedup map    │              │
│  │  Subscribers     │              │ (sliding     │              │
│  │  ├─ Console      │              │  window)     │              │
│  │  └─ File         │              └──────────────┘              │
│  └─────────────────┘                                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Security Invariants

| ID | Invariant | Implementation |
| --- | --- | --- |
| SEC-01 | No secrets in events | `rejectSensitiveMetadata()` in `operationalEventSchema` rejects events with sensitive field names or values |
| SEC-02 | No secrets in audit | `redactAuditEntry()` redacts JWT, Bearer, and password patterns before persistence |
| SEC-03 | No secrets in alerts | `redactLog()` applied by adapters before persistence or console output |
| SEC-04 | Immutable audit trail | `AuditRepository` interface has no `update()` or `delete()` methods; entries are append-only |
| SEC-05 | Atomic audit writes | `FileAuditRepository` uses temp-file + rename pattern |
| SEC-06 | Path traversal protection | `FileAuditRepository` and `FileAlertEmitter` use `safeResolve()` |
| SEC-07 | Zod validation at boundaries | `operationalEventSchema`, `auditEntrySchema`, `alertEntrySchema` validate all persisted data |
| SEC-08 | Subscriber errors isolated | Emitter catches subscriber errors and logs to stderr; never propagates |
| SEC-09 | Correlation IDs structured | `CorrelationIds` uses strict Zod schema; no arbitrary keys |
| SEC-10 | Alert dedup prevents noise | Sliding window deduplication suppresses repeated alerts within configurable window |

---

## Related Tests

| Test File | AC Coverage | Description |
| --- | --- | --- |
| `operational-event.test.ts` | AC-19 to AC-22 | Event creation, secret rejection, correlation IDs, Zod validation |
| `operational-emitter.test.ts` | AC-23 | Subscriber dispatch, error isolation, unsubscribe |
| `orchestrator-events.test.ts` | AC-24 | Dual-write (event + audit) integration |
| `audit-vs-metadata.test.ts` | AC-25 | Audit immutability vs RunRecord.metadata mutability distinction |
| `alert-schema.test.ts` | AC-27 to AC-28 | Alert schema validation, severity levels |
| `alert-emitter.test.ts` | AC-29 | Deduplication behavior, window expiration |
| `file-audit-repo.test.ts` | AC-26 | File persistence, redaction on write |
| `file-alert-emitter.test.ts` | AC-30 | File persistence, console output |
| `console-alert-emitter.test.ts` | AC-30 | Severity-based routing (stdout vs stderr) |

---

## File Structure

```
automation/domain/
├── operational-event.ts       # OperationalEvent, schemas, secret rejection
├── operational-event.test.ts
├── operational-emitter.ts     # OperationalEmitter interface, in-memory factory
├── operational-emitter.test.ts
├── audit-entry.ts             # AuditEntry, redaction, factory
├── audit-repository.ts        # AuditRepository interface
├── alert-schema.ts            # AlertEntry, severity, dedup support
├── alert-schema.test.ts
├── alert-emitter.ts           # AlertEmitter interface, dedup factory
├── alert-emitter.test.ts
└── audit-vs-metadata.test.ts  # AC-25 distinction tests

automation/adapters/
├── orchestrator-events.ts     # Dual-write helpers (event + audit)
├── orchestrator-events.test.ts
├── file-audit-repo.ts         # FileAuditRepository implementation
├── file-audit-repo.test.ts
├── file-alert-emitter.ts      # File-based alert persistence
├── file-alert-emitter.test.ts
├── console-alert-emitter.ts   # Console alert output
└── console-alert-emitter.test.ts
```

---

## Conventions

- **Dual-write pattern:** `emit*Event()` helpers always emit an operational event AND create an audit entry. This ensures both real-time monitoring and durable history.
- **Secret rejection at creation:** `OperationalEvent` metadata is validated for secrets at creation time (throws). `AuditEntry` metadata is redacted at persistence time (silent).
- **Correlation is required:** All events and audit entries must include at least one correlation ID for traceability.
- **Immutable audit, mutable metadata:** Audit entries are append-only facts. `RunRecord.metadata` is mutable operational context. They must never be conflated.
- **Fail-open for events:** Subscriber errors in `OperationalEmitter` and `AlertEmitter` are caught and logged to stderr; they never break the emitting code path.
