# Persistence Architecture — Filesystem & SQL Server

> Sprint 3 (Filesystem) + Sprint 5 (SQL Server) — Production Persistence

## Overview

The persistence layer provides durable storage for domain entities using
a **pluggable provider architecture**. Two providers are supported:

| Provider | Selection | Status |
|---|---|---|
| **Filesystem** (default) | `PERSISTENCE_PROVIDER=filesystem` or unset | Active since Sprint 3 |
| **SQL Server** | `PERSISTENCE_PROVIDER=sqlserver` | Added in Sprint 5 |

Provider selection is centralized, configuration-driven, and fail-closed
(AC-05). Unknown values produce an actionable error. The domain and
application layers remain technology-agnostic — they depend only on
repository contracts (AC-03, AP-02).

```text
Domain / Application
  -> Repository Contracts
      -> Filesystem Adapters  (FileRunRepository, FileCheckpointRepository, ...)
      -> SQL Server Adapters  (SqlRunRepository, SqlCheckpointRepository, ...)
          -> opsdb
```

### Provider Selection

```typescript
// automation/adapters/sql/persistence-config.ts
const provider = resolvePersistenceProvider(process.env);
// "filesystem" | "sqlserver" — throws PersistenceConfigError on unknown
```

- Variable absent → safe `filesystem` default (backward compatible, AC-64).
- `sqlserver` → SQL configuration is validated with Zod BEFORE any
  connection attempt (AC-08).
- Unknown value → fail closed with actionable error.

---

## SQL Server Provider (Sprint 5)

### Target Database

`opsdb` is the sole application database (AP-01). No cross-database
foreign keys, queries, views, synonyms or runtime dependencies on
`identitydb`, `geritdb`, or other application databases.

### Configuration

| Variable | Description | Default |
|---|---|---|
| `SQL_SERVER_HOST` | Server hostname | (required) |
| `SQL_SERVER_PORT` | Port number | `1433` |
| `SQL_SERVER_DATABASE` | Target database | `opsdb` |
| `SQL_SERVER_USER` | Login user | (required) |
| `SQL_SERVER_PASSWORD` | Login password (secret) | (required) |
| `PERSISTENCE_PROVIDER` | `filesystem` or `sqlserver` | `filesystem` |

See `.env.example` for placeholders. **Never** commit real credentials.

TLS behavior is explicit and fail-closed: `encrypt: true`,
`trustServerCertificate: false`.

### Database Schema

The migration `database/migrations/001_initial_schema.sql` creates:

| Table | Purpose | Key Properties |
|---|---|---|
| `dbo.SchemaMigrations` | Migration ledger | Version unique, checksum SHA-256 |
| `dbo.Runs` | Complete RunRecord + metadata | PK `RunId`, unique `IdempotencyKey`, `Revision` for optimistic concurrency |
| `dbo.Checkpoints` | Append-only checkpoint history | FK to `Runs`, ordered by `(CreatedAt, Attempt)` |
| `dbo.Schedules` | Schedule records | `Revision` for optimistic concurrency |
| `dbo.Batches` | Batch job records | No `Revision` (D-04) |
| `dbo.BatchItems` | Items belonging to a batch | FK to `Batches` |
| `dbo.AuditEntries` | Append-only audit log | ISJSON constraint on metadata |

JSON fields use `NVARCHAR(MAX)` with `ISJSON` constraints where
appropriate (AC-35). Relational columns are used for identity,
filtering, uniqueness, concurrency, state, timestamps and relationships.

### Migrations

Migrations are versioned files in `database/migrations/`. Application is
**human-controlled** via `migration-runner.ts` with an explicit approval
flag (`apply=true`). Ordinary PR CI never migrates production (AC-13,
AP-04). See `database/README.md` for the complete procedure.

### Optimistic Concurrency

Run and Schedule updates compare the `Revision` column atomically:

```sql
UPDATE dbo.Runs SET ..., Revision = Revision + 1
WHERE RunId = @runId AND Revision = @expectedRevision;
```

A zero-row update distinguishes not-found from revision conflict and
maps the latter to `ConcurrencyConflictError` (AC-20, AC-21).

### Transactions

Bounded transactions are used only for logical multi-write consistency.
Transactions roll back on failure, preserve idempotency, prevent partial
logical writes, and never span external platform API calls (AC-37,
AC-38).

### SQL Adapters

| Adapter | Contract | Key Properties |
|---|---|---|
| `SqlRunRepository` | `RunRepository` | CRUD, list/filter, idempotency, concurrency |
| `SqlCheckpointRepository` | `CheckpointRepository` | Append-only, `getLatest`, chronological ordering |
| `SqlScheduleRepository` | `ScheduleRepository` | CRUD, list/filter, concurrency, idempotency lookup |
| `SqlBatchRepository` | `BatchRepository` | 9 methods, FK integrity on BatchItems |
| `SqlAuditRepository` | `AuditRepository` | Append-only, filters (category, action, time range) |

All SQL statements are parameterized (AC-36). Shared helpers live in
`sql-row-helpers.ts`. The driver (`mssql` / tedious) is lazy-loaded
behind an injectable `SqlExecutor` interface — environments using only
filesystem persistence never require the driver.

### FS→SQL Import

The import module (`fs-to-sql-import.ts`) reads data from filesystem
repositories and inserts via SQL repositories:

- **Explicit and non-destructive:** source `.data` is never deleted or
  modified (AC-45, AC-48).
- **Preserves:** RunId, idempotency keys, UTC timestamps, states,
  checkpoint order (AC-46).
- **Duplicate detection:** existing records are reported as conflicts,
  never overwritten (AC-47).
- **Dry-run mode** available for validation before actual import.

### Recovery

Recovery logic (`recovery.ts` + `recoveryLoop`) works identically with
both providers. The `recoverRun` function evaluates each interrupted
run's remote status and applies the appropriate strategy. Recovery is
covered by env-gated SQL integration tests (`recovery-sql-integration.test.ts`,
AC-44).

---

## Filesystem Provider

The persistence layer provides durable storage for `RunRecord` and
`Checkpoint` data using the local filesystem. This enables recovery
after process crashes, restarts, and other interruptions without
requiring a database.

The design follows the existing architecture principles:

- **Domain-agnostic:** `RunRepository` and `CheckpointRepository` interfaces are defined in the domain layer.
- **File-based implementations:** `FileRunRepository` and `FileCheckpointRepository` implement these interfaces.
- **Atomic writes:** All writes use temp-file + rename to prevent corruption.
- **Optimistic concurrency:** `FileRunRepository` uses a `revision` counter for concurrent update detection.

---

## File Structure

```
.data/
├── runs/                          # RunRecord files
│   ├── <runId>.json               # One file per run
│   └── ...
└── checkpoints/                   # Checkpoint files
    ├── <runId>-<timestamp>.json   # One file per checkpoint
    └── ...
```

### Storage Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `FILERUN_STORAGE_DIR` | `<cwd>/.data/runs` | Directory for run record files |
| `FILECHECKPOINT_STORAGE_DIR` | `<cwd>/.data/checkpoints` | Directory for checkpoint files |

---

## File Format

### RunRecord File (`<runId>.json`)

```json
{
  "schemaVersion": 1,
  "revision": 3,
  "storedAt": "2026-09-15T10:30:00.000Z",
  "record": {
    "schemaVersion": 1,
    "runId": "550e8400-e29b-41d4-a716-446655440000",
    "brandId": "best-fluency",
    "market": "PT",
    "platform": "google-business",
    "operation": "createLocalPost",
    "state": "succeeded",
    "attempt": 2,
    "maxAttempts": 3,
    "idempotencyKey": "...",
    "payloadFingerprint": "...",
    "createdAt": "2026-09-15T10:00:00.000Z",
    "updatedAt": "2026-09-15T10:30:00.000Z",
    "startedAt": "2026-09-15T10:15:00.000Z",
    "finishedAt": "2026-09-15T10:30:00.000Z",
    "metadata": {
      "statusSync": { "reconciledState": "succeeded", "synchronizedAt": "..." }
    }
  }
}
```

**Key fields:**

| Field | Purpose |
|---|---|
| `schemaVersion` | Format version for future migrations (FR-10) |
| `revision` | Optimistic concurrency counter (FR-06) |
| `storedAt` | Timestamp of last write to disk |
| `record` | The actual RunRecord |

### Checkpoint File (`<runId>-<timestamp>.json`)

```json
{
  "schemaVersion": 1,
  "data": {
    "runId": "550e8400-e29b-41d4-a716-446655440000",
    "state": "running",
    "attempt": 1,
    "payload": {},
    "createdAt": "2026-09-15T10:00:00.000Z"
  }
}
```

---

## Atomic Writes

All file writes follow the atomic write pattern to prevent corruption:

```
1. Write data to <path>.tmp.<pid>.<timestamp>
2. Rename temp file to <path>
3. Remove temp file on failure
```

This ensures that:
- Readers never see partially written files
- A crash during write leaves either the old file or the new file, never corrupted data
- The temp file is cleaned up even if the rename fails

---

## Optimistic Concurrency (FR-06)

`FileRunRepository.update()` supports optimistic concurrency control via the `revision` field:

```typescript
// With concurrency check
await runRepo.update(record, expectedRevision);

// Without concurrency check (backward-compatible)
await runRepo.update(record);
```

When `expectedRevision` is provided:
1. The stored record's current `revision` is compared to `expectedRevision`
2. If they match, the update proceeds and `revision` is incremented
3. If they don't match, a `ConcurrencyConflictError` is thrown

---

## Recovery Flow

When the process crashes or is interrupted, runs may be left in the `running` state. The recovery mechanism detects and handles these interrupted runs.

### Recovery Flow Diagram

```
Process starts
    │
    ▼
recoveryLoop(adapter, repo)
    │
    ├──► detectInterruptedRuns(repo)
    │       │
    │       ▼
    │    Find all RunRecords in state "running"
    │       │
    │       ▼
    │    Also find all RunRecords in state "waiting_manual"
    │       │
    │       ▼
    │    Return list of runs to process
    │
    ├──► For each run:
    │       │
    │       ▼
    │    recoverRun(record, adapter, repo)
    │       │
    │       ├──► Is state "waiting_manual"?
    │       │       │
    │       │       YES → Skip (metadata: action="skipped")
    │       │
    │       ├──► Is state terminal (succeeded/cancelled)?
    │       │       │
    │       │       YES → Return as-is
    │       │
    │       ├──► Is state not "running"?
    │       │       │
    │       │       YES → Throw error
    │       │
    │       ├──► adapter.checkStatus(runId)
    │       │       │
    │       │       ▼
    │       │    Remote status available?
    │       │       │
    │       │       NO → action: "leave_running"
    │       │       │
    │       │       YES → Evaluate remote state:
    │       │              │
    │       │              ├── succeeded → action: "succeed"
    │       │              ├── waiting_manual → action: "wait_manual"
    │       │              ├── failed (retryable & canRetryMore) → action: "retry"
    │       │              ├── failed (non-retryable or maxAttempts) → action: "fail"
    │       │              ├── running/queued → action: "leave_running"
    │       │              ├── cancelled → action: "fail"
    │       │              └── unknown → action: "leave_running"
    │       │
    │       ▼
    │    Apply strategy:
    │       │
    │       ├── succeed → transition running → succeeded
    │       ├── wait_manual → transition running → waiting_manual
    │       ├── retry → transition running → failed → queued
    │       ├── fail → transition running → failed (terminal)
    │       └── leave_running → update metadata, keep running
    │
    ▼
Return RecoveryResult[] with actions taken
```

### Recovery Strategies

| Strategy | Condition | Transition | Metadata |
|---|---|---|---|
| `succeed` | Remote says succeeded | `running → succeeded` | `action: "succeed"` |
| `wait_manual` | Remote says waiting_manual | `running → waiting_manual` | `action: "wait_manual"` |
| `retry` | Remote failed retryable + attempts remaining | `running → failed → queued` | `action: "retry"` |
| `fail` | Remote failed non-retryable or maxAttempts | `running → failed` | `action: "fail"` |
| `leave_running` | Ambiguous or no remote status | No transition | `action: "leave_running"` |
| `skipped` | Run already in `waiting_manual` | No transition | `action: "skipped"` |

### Key Safety Properties

1. **Conservative by default:** When in doubt, the system leaves the run in its current state for manual intervention.
2. **No auto-recovery of waiting_manual:** Runs awaiting human action are never auto-recovered.
3. **Idempotency preserved:** The `idempotencyKey` is preserved through all transitions.
4. **Evidence recorded:** Every recovery attempt is logged in `RunRecord.metadata.recovery`.
5. **Terminal states protected:** `succeeded` and `cancelled` runs are never reprocessed.

---

## File Operations

### FileRunRepository

| Method | Behavior |
|---|---|
| `create(record)` | Creates new file; fails if file already exists |
| `getById(runId)` | Reads and validates file; returns null if not found |
| `update(record, expectedRevision?)` | Updates with optional concurrency check |
| `list(filters?)` | Reads all files, applies filters; throws on corruption |
| `findByIdempotencyKey(key)` | Scans all files for matching key |

### FileCheckpointRepository

| Method | Behavior |
|---|---|
| `create(checkpoint)` | Creates new checkpoint file |
| `getLatest(runId)` | Returns most recent checkpoint for a run |
| `listByRunId(runId)` | Returns all checkpoints for a run, sorted ascending |

---

## Error Handling

### CorruptedRecordError

Thrown when:
- File content is not valid JSON
- JSON structure doesn't match the expected Zod schema
- Required fields are missing or have wrong types

### ConcurrencyConflictError

Thrown when:
- `update()` is called with `expectedRevision` that doesn't match the stored revision

---

## FS×SQL Divergences (D-12)

The following divergences between filesystem and SQL Server backends are
**deliberate** and documented:

| # | Behavior | Filesystem | SQL Server |
|---|---|---|---|
| 1 | `IdempotencyKey` uniqueness (Runs) | Indexes only by `runId`; accepts duplicate key with different `runId`; `findByIdempotencyKey` is non-deterministic | Enforced by `UQ_Runs_IdempotencyKey`; `create` returns the durable winner; never stores 2nd row |
| 2 | Checkpoint orphan FK | Accepts checkpoint without existing run | Rejects via `FK_Checkpoints_Runs` |
| 3 | `list()` ordering | Non-deterministic (`readdirSync`) | Deterministic (`ORDER BY RunId ASC`) |
| 4 | Schedule `enabled` column | Preserves independent `config.enabled` and `enabled` fields | Single `Enabled` BIT column; rejects divergent pair via `assertEnabledInvariant` |

The shared contract test battery (`repository-contract.test.ts`) asserts
only what both backends guarantee. Backend-specific behavior is tested
in dedicated `describe` blocks.

---

## Security Considerations

1. **Path traversal protection:** All file paths are validated using `safeResolve()` from `path-security.ts`
2. **No secrets in records:** Credentials are never stored in RunRecord, Checkpoint, or metadata
3. **Atomic writes prevent partial exposure:** Temp files are renamed atomically
4. **Zod validation on read:** All deserialized data is validated before use
5. **Parameterized SQL:** All SQL statements use parameterized queries — no untrusted concatenation (AC-36)
6. **Sanitized errors:** Connection errors never expose passwords or connection strings
7. **Least privilege:** Runtime SQL user has DML-only access; migration user has DDL access (AC-61, AC-62)
8. **No secrets in source:** `.env.example` contains names and placeholders only
