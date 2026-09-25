# Sprint 5 --- SQL Server Production Persistence & Product Readiness

## 1. Objective

Introduce SQL Server as the production-grade persistence provider for
VianaHub.Global.Marketing.Ops while preserving existing domain
contracts, execution semantics, idempotency, recovery behavior,
filesystem persistence, security boundaries, and CI quality gates.

Target database: `opsdb`.

Sprint 5 does **not** integrate Marketing.Ops with
VianaHub.Global.Identity, `identitydb`, `geritdb`, or any other
application/database.

## 2. Architectural Principles

### AP-01 --- Bounded database ownership

`opsdb` belongs to VianaHub.Global.Marketing.Ops. No cross-database
foreign keys, queries, stored procedures, synonyms, views, or runtime
dependencies on `identitydb`, `geritdb`, Hangfire databases, or other
application databases. Future Identity integration requires a separate
integration contract.

### AP-02 --- Domain independence

Domain/application layers remain technology-agnostic. SQL Server
implements repository contracts as an adapter. Domain code must not
import SQL drivers or contain SQL.

### AP-03 --- Filesystem compatibility

Existing filesystem repositories remain supported. Provider selection is
explicit and configuration-driven.

### AP-04 --- Production isolation

Ordinary pull-request CI must never connect to or mutate production
`opsdb`. Production DB availability is not required by the five standard
CI checks.

### AP-05 --- No secrets in source

Existing GitHub configuration names are `SQL_SERVER_HOST`,
`SQL_SERVER_PORT`, `SQL_SERVER_DATABASE`, `SQL_SERVER_USER`, and secret
`SQL_SERVER_PASSWORD`. Source and `.env.example` contain
names/placeholders only.

## 3. Scope

In scope: SQL persistence adapters; versioned migrations/history;
connection/config validation; SQL implementations of RunRepository,
CheckpointRepository, ScheduleRepository, BatchRepository and
AuditRepository; provider selection; optimistic concurrency;
idempotency; transaction boundaries; relational constraints/indexes;
JSON validation; repository/isolated integration/concurrency tests;
controlled schema deployment; filesystem-to-SQL import; fallback;
operational documentation; production-readiness review.

Out of scope: Identity integration; auth redesign; cross-database
dependencies; Identity RLS; frontend/dashboard; public HTTP API;
Redis/message broker; new marketing adapter; multi-market redesign;
advanced analytics/reporting; replacing the domain model; removing
filesystem persistence.

## 4. Target Architecture

``` text
Domain / Application
  -> Repository Contracts
      -> Filesystem Adapters
      -> SQL Server Adapters
          -> opsdb
              -> Runs
              -> Checkpoints
              -> Schedules
              -> Batches
              -> BatchItems
              -> AuditEntries
              -> SchemaMigrations
```

## 5. Database Schema

### 5.1 Runs

Persist complete RunRecord plus persistence metadata. Required logical
fields: RunId (PK), SchemaVersion, BrandId, Market, Platform, Operation,
State, Attempt, MaxAttempts, IdempotencyKey, PayloadFingerprint,
CreatedAt, UpdatedAt, StartedAt nullable, FinishedAt nullable,
ErrorMessage nullable, ErrorCode nullable, ErrorRetryable nullable,
MetadataJson nullable, Revision, StoredAt.

Requirements: unique RunId; database-enforced unique/indexed
IdempotencyKey; Revision starts at 1 and remains persistence metadata
(must not be added to RunRecord solely for SQL); valid JSON constraint
when MetadataJson is non-null; State constrained to
`queued|running|waiting_manual|succeeded|failed|cancelled`; numeric
constraints follow current domain semantics; indexes support existing
repository filters.

### 5.2 Checkpoints

Required logical fields: CheckpointId (surrogate PK), RunId,
SchemaVersion, State, Attempt, PayloadJson, CreatedAt. RunId references
Runs. Checkpoints are append-only. PayloadJson must be valid JSON.
Retrieval preserves current chronological semantics: CreatedAt ascending
with Attempt as deterministic tie-breaker. `getLatest(runId)` must be
efficient. Required logical index: `(RunId, CreatedAt, Attempt)`.

### 5.3 Schedules

Persist the complete existing Schedule representation.
Identity/filter/scheduling/concurrency fields remain relational,
including ScheduleId, IdempotencyKey, cron, timezone, BrandId, Market,
Platform, Operation, Mode, Enabled, CreatedAt, UpdatedAt, Revision.
Preserve idempotency, revision concurrency, filters, and cron/timezone
semantics.

### 5.4 Batches

Persist existing BatchJob representation. Batches and BatchItems are
separate relational entities. Reconcile the documented BatchRepository
revision behavior with the current domain before SQL implementation. Do
not invent hidden SQL-only concurrency semantics. Any required revision
change must be explicit, tested, and consistently applied to relevant
repository implementations.

### 5.5 BatchItems

Each item belongs to one Batch. Preserve current identity, BatchId,
status/state, optional RunId association, timestamps, and existing
retry/error/result metadata. Index current access paths.

### 5.6 AuditEntries

Append-only. Persist all current fields and support existing category,
action, RunId, ScheduleId, BatchId and time-range filters. Metadata may
use validated JSON. SQL repository exposes no mutation that violates
append-only semantics.

### 5.7 SchemaMigrations

Track migration identifier/version, name/description, applied timestamp,
and checksum/equivalent immutable identity where practical. Applied
migrations are never silently rewritten.

## 6. Migrations

Use versioned files, conceptually:

``` text
database/
  migrations/
    001_initial_schema.sql
  README.md
```

Execution must be deterministic, fail loudly on incompatible/partial
state, never automatically drop production data, contain no credentials,
record success, safely handle duplicate application, and emit actionable
failures. Document human-controlled deployment to `opsdb`. Ordinary PR
CI never migrates production.

## 7. Configuration

Use existing `SQL_SERVER_HOST`, `SQL_SERVER_PORT`,
`SQL_SERVER_DATABASE`, `SQL_SERVER_USER`, `SQL_SERVER_PASSWORD`.
Introduce centralized `PERSISTENCE_PROVIDER=filesystem|sqlserver`, with
safe backward-compatible default. Validate SQL configuration before
connection. Never log passwords, credential-bearing connection strings,
tokens, or secrets. Sanitize connection errors. TLS/encryption behavior
must be explicit and documented.

## 8. SQL Driver

Use a maintained SQL Server driver compatible with Node.js \>=24,
TypeScript, ESM, and current tooling; lock via package-lock.json. No ORM
is required. Prefer a small explicit adapter unless concrete evidence
justifies an ORM.

## 9. Optimistic Concurrency

Run updates must compare revision atomically and increment it. A
zero-row update must distinguish not-found from revision conflict and
map the latter to existing `ConcurrencyConflictError`. Preserve behavior
when expectedRevision is omitted without weakening integrity. Preserve
Schedule revision semantics. Resolve Batch revision inconsistency before
implementation.

## 10. Transactions

Use bounded transactions only for logical multi-write consistency. Roll
back on failure, preserve idempotency, prevent partial logical writes,
and never hold a SQL transaction across external platform API calls.

## 11. Idempotency

Existing IdempotencyKey/PayloadFingerprint behavior remains
authoritative. DB constraints reinforce, not replace, application
idempotency. Concurrent duplicate creation yields one durable logical
run. Cover races with integration tests.

## 12. Recovery

Preserve the current state machine and recovery policy. Never
automatically bypass `waiting_manual`; protect `succeeded`/`cancelled`;
retry only when policy permits; remain conservative on ambiguous remote
state; preserve idempotency/evidence across restart; do not introduce
uncontrolled `running -> queued`.

## 13. JSON

Relational columns are used for identity, filtering, uniqueness,
concurrency, state, timestamps, and relationships. Use `NVARCHAR(MAX)`
JSON only for genuinely extensible structures, with `ISJSON` constraints
where appropriate. Validate deserialization back into domain objects.

## 14. Repository Implementations

Introduce SQL implementations conceptually named SqlServerRunRepository,
SqlServerCheckpointRepository, SqlServerScheduleRepository,
SqlServerBatchRepository, SqlServerAuditRepository. Shared SQL
infrastructure may include pool/factory, config parser, error mapping,
transaction helper, and migration helper. SQL concepts must not leak
into domain.

## 15. Provider Selection

Centralize composition. No scattered provider conditionals. Filesystem
remains supported. Unknown providers fail closed with actionable
configuration errors.

## 16. Filesystem-to-SQL Transition

Existing `.data` must not be silently ignored/deleted. Provide explicit
import or controlled migration procedure. Validate source; preserve
RunId, idempotency keys, timestamps, states and checkpoints; detect
duplicates; never silently overwrite conflicts; emit summary; never
delete source automatically.

## 17. Testing

Contract/unit tests cover create/read/update/list/filter, idempotency,
duplicates, concurrency, checkpoint ordering, append-only audit,
schedules, batches, JSON validation and error mapping. SQL integration
tests use isolated/non-production SQL Server only. Deterministic
concurrency tests cover competing Run updates, duplicate IdempotencyKey
creation, competing Schedule updates, and Batch concurrency after
contract resolution.

## 18. CI Safety

Required checks remain Build, Code Quality, Domain Validation, Tests,
Type Safety. Normal PR CI must not require or mutate production SQL,
expose credentials, or become nondeterministic. If SQL integration
infrastructure is unavailable in normal CI, use a separately controlled
workflow or isolated service/database. CodeQL remains clean.

## 19. Security

Parameterized SQL only; no untrusted SQL concatenation; no
secrets/credentials in source, migrations or logs; least-privilege
runtime SQL user; separate migration/runtime privileges where practical;
production SQL unavailable to arbitrary PR code; sanitized DB errors;
existing metadata/payload secret protections preserved; no
cross-database access.

## 20. Operational Readiness

Document initial deployment, migration application/verification,
configuration validation, provider switching, filesystem
fallback/import, backup expectations, DB-outage recovery, concurrency
diagnosis, connectivity troubleshooting, rollback, credential rotation,
and production validation. `docs/runbook.md` is materialized through an
authorized human path if agent guardrails prohibit editing it.

## 21. Documentation

Document persistence architecture, relational model, migrations,
provider configuration, transactions, concurrency, idempotency, CI
isolation and operational deployment. Update roadmap only after DoD.

## 22. Acceptance Criteria

AC-01 --- `opsdb` is the only application database targeted by Sprint 5.
AC-02 --- No dependency on identitydb, geritdb, or other application
databases exists.

AC-03 --- Existing domain/application layers remain
SQL-driver independent.

AC-04 --- Existing filesystem repositories
remain functional.

AC-05 --- Persistence provider selection is
centralized and configuration-driven.

AC-06 --- Existing GitHub SQL
configuration names are supported.

AC-07 --- No secret values are
committed.

AC-08 --- SQL Server connection configuration is validated.
AC-09 --- Connection errors are sanitized and actionable.

AC-10 ---
Versioned database migrations exist.

AC-11 --- Successful migrations are
tracked.

AC-12 --- Duplicate migration execution is safely handled.
AC-13 --- Ordinary PR CI never migrates production opsdb.

AC-14 --- Runs
schema preserves the complete RunRecord contract.

AC-15 --- Run revision
remains persistence metadata rather than being added to RunRecord solely
for SQL.

AC-16 --- RunId is uniquely enforced.

AC-17 --- IdempotencyKey
is uniquely enforced.

AC-18 --- findByIdempotencyKey is index-backed.
AC-19 --- Run list/filter operations preserve existing behavior.

AC-20
--- Run expectedRevision update is atomic.

AC-21 --- Revision mismatch
maps to ConcurrencyConflictError.

AC-22 --- Concurrent duplicate
idempotent Run creation produces one durable logical run.

AC-23 ---
Checkpoints are append-only.

AC-24 --- Checkpoint payload JSON is
validated.

AC-25 --- getLatest(runId) preserves current semantics.

AC-26
--- listByRunId ordering preserves CreatedAt + Attempt semantics.

AC-27
--- Schedules preserve existing domain representation.

AC-28 ---
Schedule revision concurrency is preserved.

AC-29 --- Schedule filtering
behavior is preserved.

AC-30 --- Batches and BatchItems are relationally
separated.

AC-31 --- BatchRepository revision inconsistency is
explicitly resolved and tested.

AC-32 --- Batch SQL implementation does
not invent hidden SQL-only domain semantics.

AC-33 --- AuditEntries
remain append-only.

AC-34 --- Existing audit query/filter behavior is
preserved.

AC-35 --- JSON fields use ISJSON constraints where
appropriate.

AC-36 --- SQL statements using application/domain data are
parameterized.

AC-37 --- External platform API calls never occur inside
SQL transactions.

AC-38 --- Transaction rollback prevents partial
logical writes.

AC-39 --- Existing Run state machine is unchanged.

AC-40
--- waiting_manual is never automatically bypassed.

AC-41 --- terminal
state protection remains intact.

AC-42 --- retry policy remains
authoritative.

AC-43 --- recovery preserves idempotency.

AC-44 --- SQL
provider restart/recovery is covered by integration tests.

AC-45 ---
filesystem-to-SQL transition is explicit and non-destructive.

AC-46 ---
import preserves identifiers, states, timestamps, idempotency, and
checkpoints.

AC-47 --- conflicting import records fail/report rather
than silently overwrite.

AC-48 --- filesystem source data is never
automatically deleted by import.

AC-49 --- SQL repository contract tests
pass.

AC-50 --- SQL integration tests use non-production isolation.
AC-51 --- concurrency race tests exist for critical uniqueness/revision
guarantees.

AC-52 --- production opsdb is not required by normal PR CI.
AC-53 --- existing five required CI checks remain green.

AC-54 ---
CodeQL reports no new Blocker/High security issue attributable to Sprint
5.

AC-55 --- new SQL persistence modules meet project coverage
thresholds: \>=80% statements, \>=75% branches, \>=80% functions.

AC-56
--- `npm run quality` passes.

AC-57 --- operational SQL
deployment/migration procedure is documented.

AC-58 --- SQL
outage/fallback procedure is documented.

AC-59 --- architecture
documentation reflects SQL Server and filesystem providers.

AC-60 --- no
production credentials appear in source, tests, fixtures, snapshots,
logs, or documentation.

AC-61 --- runtime SQL permissions follow least
privilege.

AC-62 --- migration privileges are not implicitly required by
normal runtime operation.

AC-63 --- SQL Server persistence can be
enabled without modifying domain source code.

AC-64 --- filesystem
persistence can still be selected after SQL implementation.

AC-65 ---
Sprint 5 production-readiness review explicitly records remaining risks
before any production GO decision.

## 23. Quality Gates

Before READY_FOR_HUMAN_REVIEW: 1. format check passes 2. lint passes 3.
typecheck passes 4. tests pass 5. coverage thresholds pass 6.
domain/data validation passes 7. build passes 8. SQL repository contract
tests pass 9. isolated SQL integration tests pass where infrastructure
is available 10. migration validation passes 11. security review has 0
active Blocker/High/Medium findings 12. reviewer has 0 active
Blocker/High/Medium findings 13. CodeQL has no new Sprint 5 Blocker/High
finding

Missing production credentials or unavailable production DB must not be
bypassed with fake credentials. Production access is not required for
ordinary code quality.

## 24. Definition of Done

Sprint 5 is complete only when all ACs have evidence; SQL repositories
implement required contracts; filesystem remains supported; migrations
are versioned/validated; isolated SQL integration behavior is
demonstrated; concurrency/idempotency guarantees have evidence; CI
remains production-isolated; no secrets are committed; operational
documentation is complete; quality gates pass; security/reviewer have
zero active Blocker/High/Medium findings; human review confirms
architecture; and production readiness is explicitly assessed.

Sprint completion does NOT automatically mean production GO.

## 25. Human Decisions / Fixed Constraints

HUMAN-01 --- Target database: `opsdb`.

HUMAN-02 --- Marketing.Ops is
currently independent from VianaHub.Global.Identity.

HUMAN-03 --- No
identitydb/geritdb integration in Sprint 5.

HUMAN-04 --- Existing
filesystem persistence remains supported.

HUMAN-05 --- Existing GitHub
SQL variable/secret names are retained.

HUMAN-06 --- Production opsdb
must not be mutated by ordinary PR CI.

HUMAN-07 --- SQL schema changes
use versioned migrations.

HUMAN-08 --- Existing
execution/recovery/idempotency semantics remain authoritative.

HUMAN-09
--- Database implementation must follow repository contracts rather than
redesigning the domain around SQL Server.

HUMAN-10 --- No production GO
is implied merely by completing Sprint 5.
