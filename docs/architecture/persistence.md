# Filesystem Persistence & Recovery

> Sprint 3 — Production Persistence + First Real Controlled Adapter

## Overview

The persistence layer provides durable storage for `RunRecord` and `Checkpoint` data using the local filesystem. This enables recovery after process crashes, restarts, and other interruptions without requiring a database.

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

## Security Considerations

1. **Path traversal protection:** All file paths are validated using `safeResolve()` from `path-security.ts`
2. **No secrets in records:** Credentials are never stored in RunRecord, Checkpoint, or metadata
3. **Atomic writes prevent partial exposure:** Temp files are renamed atomically
4. **Zod validation on read:** All deserialized data is validated before use
