-- =============================================================================
-- 001_initial_schema.sql — Sprint 5, Seções 5 e 6 (AC-01, AC-02, AC-10, AC-35)
-- =============================================================================
--
-- Target database: opsdb (AP-01 — bounded database ownership).
-- This script only creates objects inside the connected opsdb. It contains no
-- cross-database foreign keys, queries, views, synonyms or dependencies on any
-- other application database.
--
-- Security (Seção 19 / AP-05): no credentials, logins, passwords or secrets
-- appear in this file. Account provisioning lives in database/privileges/.
--
-- Deployment (Seção 6 / AC-13): application is human-controlled and explicit
-- through migration-runner.ts (apply=true). Ordinary PR CI never migrates
-- production. Applied migrations are recorded in dbo.SchemaMigrations in the
-- same transaction as this script (AC-11); reaplying a recorded migration is a
-- safe no-op (AC-12).
--
-- Script shape: must run as a single batch (it is executed via
-- sp_executesql), so it deliberately contains no GO separators. Every object
-- is guarded with IF OBJECT_ID / sys.indexes checks for safe re-execution.
--
-- Append-only tables: dbo.Checkpoints and dbo.AuditEntries are append-only by
-- contract (AC-23, AC-33). This migration performs no destructive UPDATE,
-- DELETE, DROP or TRUNCATE against any table, preserving append-only
-- representation in DDL.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- dbo.SchemaMigrations — migration ledger (Seção 5.7 / AC-11)
-- Shape matches automation/adapters/sql/migration-runner.ts exactly.
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.SchemaMigrations', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.SchemaMigrations (
    Id INT IDENTITY(1, 1) NOT NULL,
    Version INT NOT NULL,
    Name NVARCHAR(200) NOT NULL,
    Checksum NVARCHAR(64) NOT NULL,
    AppliedAt DATETIME2(3) NOT NULL
      CONSTRAINT DF_SchemaMigrations_AppliedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_SchemaMigrations PRIMARY KEY CLUSTERED (Id),
    CONSTRAINT UQ_SchemaMigrations_Version UNIQUE (Version),
    CONSTRAINT CK_SchemaMigrations_Checksum CHECK (LEN(Checksum) = 64)
  );
END;

-- -----------------------------------------------------------------------------
-- dbo.Runs — complete RunRecord plus persistence metadata (Seção 5.1)
-- - RunId is the primary key (AC-16); IdempotencyKey is unique and indexed
--   (AC-17, AC-18); Revision starts at 1 and is persistence metadata only
--   (AC-15) — it is intentionally NOT part of the domain RunRecord.
-- - The live sys.indexes / sys.index_columns verification that
--   UQ_Runs_IdempotencyKey backs findByIdempotencyKey (AC-18) runs in the
--   env-gated automation/adapters/sql/index-sql-integration.test.ts
--   (SQL_INTEGRATION_URL / AC-50) — PR CI never connects to SQL Server.
-- - State is constrained to the domain state machine values (AC-39).
-- - MetadataJson must be valid JSON when present (AC-35).
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.Runs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.Runs (
    RunId NVARCHAR(64) NOT NULL,
    SchemaVersion INT NOT NULL,
    BrandId NVARCHAR(100) NOT NULL,
    Market NVARCHAR(32) NOT NULL,
    Platform NVARCHAR(64) NOT NULL,
    Operation NVARCHAR(100) NOT NULL,
    State NVARCHAR(32) NOT NULL,
    Attempt INT NOT NULL,
    MaxAttempts INT NOT NULL,
    IdempotencyKey NVARCHAR(128) NOT NULL,
    PayloadFingerprint NVARCHAR(64) NOT NULL,
    CreatedAt DATETIME2(3) NOT NULL,
    UpdatedAt DATETIME2(3) NOT NULL,
    StartedAt DATETIME2(3) NULL,
    FinishedAt DATETIME2(3) NULL,
    ErrorMessage NVARCHAR(MAX) NULL,
    ErrorCode NVARCHAR(100) NULL,
    ErrorRetryable BIT NULL,
    MetadataJson NVARCHAR(MAX) NULL,
    Revision INT NOT NULL,
    StoredAt DATETIME2(3) NOT NULL,
    CONSTRAINT PK_Runs PRIMARY KEY CLUSTERED (RunId),
    CONSTRAINT UQ_Runs_IdempotencyKey UNIQUE (IdempotencyKey),
    CONSTRAINT CK_Runs_State CHECK (
      State IN (N'queued', N'running', N'waiting_manual', N'succeeded', N'failed', N'cancelled')
    ),
    CONSTRAINT CK_Runs_Attempt CHECK (Attempt >= 0),
    CONSTRAINT CK_Runs_MaxAttempts CHECK (MaxAttempts >= 0),
    CONSTRAINT CK_Runs_PayloadFingerprint CHECK (LEN(PayloadFingerprint) = 64),
    CONSTRAINT CK_Runs_MetadataJson CHECK (MetadataJson IS NULL OR ISJSON(MetadataJson) = 1),
    CONSTRAINT CK_Runs_Revision CHECK (Revision >= 1)
  );
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.Runs') AND name = N'IX_Runs_Filters'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_Runs_Filters
    ON dbo.Runs (BrandId, Market, Platform, Operation, State);
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.Runs') AND name = N'IX_Runs_State'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_Runs_State
    ON dbo.Runs (State);
END;

-- -----------------------------------------------------------------------------
-- dbo.Checkpoints — append-only run snapshots (Seção 5.2 / AC-23, AC-25, AC-26)
-- - CheckpointId is a surrogate primary key; RunId references dbo.Runs.
-- - PayloadJson must be valid JSON (AC-24, AC-35).
-- - (RunId, CreatedAt, Attempt) supports getLatest(runId) and chronological
--   listByRunId with Attempt as deterministic tie-breaker.
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.Checkpoints', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.Checkpoints (
    CheckpointId BIGINT IDENTITY(1, 1) NOT NULL,
    RunId NVARCHAR(64) NOT NULL,
    SchemaVersion INT NOT NULL,
    State NVARCHAR(32) NOT NULL,
    Attempt INT NOT NULL,
    PayloadJson NVARCHAR(MAX) NOT NULL,
    CreatedAt DATETIME2(3) NOT NULL,
    CONSTRAINT PK_Checkpoints PRIMARY KEY CLUSTERED (CheckpointId),
    CONSTRAINT FK_Checkpoints_Runs FOREIGN KEY (RunId) REFERENCES dbo.Runs (RunId),
    CONSTRAINT CK_Checkpoints_State CHECK (
      State IN (N'queued', N'running', N'waiting_manual', N'succeeded', N'failed', N'cancelled')
    ),
    CONSTRAINT CK_Checkpoints_Attempt CHECK (Attempt >= 0),
    CONSTRAINT CK_Checkpoints_PayloadJson CHECK (ISJSON(PayloadJson) = 1)
  );
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.Checkpoints') AND name = N'IX_Checkpoints_RunId_CreatedAt_Attempt'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_Checkpoints_RunId_CreatedAt_Attempt
    ON dbo.Checkpoints (RunId, CreatedAt, Attempt);
END;

-- -----------------------------------------------------------------------------
-- dbo.Schedules — complete ScheduleRecord (Seção 5.3 / AC-27..AC-29)
-- - Revision is part of the domain contract and enables optimistic
--   concurrency (AC-28).
-- - IdempotencyKey is intentionally NOT unique here: the domain does not
--   impose schedule idempotency at the storage layer (REV-03 — see
--   ScheduleRepository / file-schedule-repo.test.ts; only dbo.Runs
--   requires UQ_Runs_IdempotencyKey per Seção 5.1 / AC-17).
-- - Enabled/BrandId/Market/Platform back existing list filters (AC-29).
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.Schedules', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.Schedules (
    ScheduleId NVARCHAR(64) NOT NULL,
    SchemaVersion INT NOT NULL,
    IdempotencyKey NVARCHAR(200) NOT NULL,
    Cron NVARCHAR(200) NOT NULL,
    Timezone NVARCHAR(100) NOT NULL,
    BrandId NVARCHAR(100) NOT NULL,
    Market NVARCHAR(32) NOT NULL,
    Platform NVARCHAR(64) NOT NULL,
    Operation NVARCHAR(100) NOT NULL,
    Mode NVARCHAR(16) NOT NULL,
    Enabled BIT NOT NULL,
    CreatedAt DATETIME2(3) NOT NULL,
    UpdatedAt DATETIME2(3) NOT NULL,
    LastRunAt DATETIME2(3) NULL,
    NextRunAt DATETIME2(3) NULL,
    Revision INT NOT NULL,
    MetadataJson NVARCHAR(MAX) NULL,
    CONSTRAINT PK_Schedules PRIMARY KEY CLUSTERED (ScheduleId),
    CONSTRAINT CK_Schedules_Mode CHECK (Mode IN (N'single', N'batch')),
    CONSTRAINT CK_Schedules_Revision CHECK (Revision >= 0),
    CONSTRAINT CK_Schedules_MetadataJson CHECK (MetadataJson IS NULL OR ISJSON(MetadataJson) = 1)
  );
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.Schedules') AND name = N'IX_Schedules_Filters'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_Schedules_Filters
    ON dbo.Schedules (Enabled, BrandId, Market, Platform);
END;

-- -----------------------------------------------------------------------------
-- dbo.Batches — BatchJob representation (Seção 5.4 / AC-30..AC-32)
-- - NO Revision column: decision D-04 (Opção A) aligns the DDL with the
--   current domain BatchJob (which has no revision field). No SQL-only
--   concurrency semantics may be invented here (AC-32).
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.Batches', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.Batches (
    BatchId NVARCHAR(64) NOT NULL,
    SchemaVersion INT NOT NULL,
    Status NVARCHAR(32) NOT NULL,
    TotalItems INT NOT NULL,
    CompletedItems INT NOT NULL,
    FailedItems INT NOT NULL,
    CreatedAt DATETIME2(3) NOT NULL,
    UpdatedAt DATETIME2(3) NOT NULL,
    MetadataJson NVARCHAR(MAX) NULL,
    CONSTRAINT PK_Batches PRIMARY KEY CLUSTERED (BatchId),
    CONSTRAINT CK_Batches_Status CHECK (
      Status IN (N'pending', N'running', N'succeeded', N'partial_failure', N'failed', N'cancelled')
    ),
    CONSTRAINT CK_Batches_TotalItems CHECK (TotalItems >= 0),
    CONSTRAINT CK_Batches_CompletedItems CHECK (CompletedItems >= 0),
    CONSTRAINT CK_Batches_FailedItems CHECK (FailedItems >= 0),
    CONSTRAINT CK_Batches_MetadataJson CHECK (MetadataJson IS NULL OR ISJSON(MetadataJson) = 1)
  );
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.Batches') AND name = N'IX_Batches_Status'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_Batches_Status
    ON dbo.Batches (Status);
END;

-- -----------------------------------------------------------------------------
-- dbo.BatchItems — items separated from batches (Seção 5.5 / AC-30)
-- - Each item belongs to exactly one batch (FK to dbo.Batches).
-- - RunId is an optional association (null until a run is created) and is
--   intentionally not a foreign key: items may outlive or never create runs.
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.BatchItems', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.BatchItems (
    ItemId NVARCHAR(64) NOT NULL,
    BatchId NVARCHAR(64) NOT NULL,
    SchemaVersion INT NOT NULL,
    RunId NVARCHAR(64) NULL,
    Status NVARCHAR(32) NOT NULL,
    Error NVARCHAR(MAX) NULL,
    CreatedAt DATETIME2(3) NOT NULL,
    UpdatedAt DATETIME2(3) NOT NULL,
    MetadataJson NVARCHAR(MAX) NULL,
    CONSTRAINT PK_BatchItems PRIMARY KEY CLUSTERED (ItemId),
    CONSTRAINT FK_BatchItems_Batches FOREIGN KEY (BatchId) REFERENCES dbo.Batches (BatchId),
    CONSTRAINT CK_BatchItems_Status CHECK (
      Status IN (N'pending', N'running', N'succeeded', N'failed', N'cancelled')
    ),
    CONSTRAINT CK_BatchItems_MetadataJson CHECK (MetadataJson IS NULL OR ISJSON(MetadataJson) = 1)
  );
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.BatchItems') AND name = N'IX_BatchItems_BatchId_Status'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_BatchItems_BatchId_Status
    ON dbo.BatchItems (BatchId, Status);
END;

-- -----------------------------------------------------------------------------
-- dbo.AuditEntries — append-only audit trail (Seção 5.6 / AC-33..AC-35)
-- - Supports category, action, RunId, ScheduleId, BatchId and time-range
--   filters through dedicated indexes.
-- - MetadataJson is validated JSON when present.
-- - Correlation columns are deliberately unconstrained references: audit rows
--   must survive independently of the entities they describe (append-only).
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.AuditEntries', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.AuditEntries (
    EntryId NVARCHAR(64) NOT NULL,
    [Timestamp] DATETIME2(3) NOT NULL,
    Category NVARCHAR(100) NOT NULL,
    Action NVARCHAR(100) NOT NULL,
    Actor NVARCHAR(100) NOT NULL,
    RunId NVARCHAR(64) NULL,
    ScheduleId NVARCHAR(64) NULL,
    BatchId NVARCHAR(64) NULL,
    PreviousState NVARCHAR(64) NULL,
    NewState NVARCHAR(64) NULL,
    MetadataJson NVARCHAR(MAX) NULL,
    CONSTRAINT PK_AuditEntries PRIMARY KEY CLUSTERED (EntryId),
    CONSTRAINT CK_AuditEntries_MetadataJson CHECK (MetadataJson IS NULL OR ISJSON(MetadataJson) = 1)
  );
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.AuditEntries') AND name = N'IX_AuditEntries_Category_Action_Timestamp'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_AuditEntries_Category_Action_Timestamp
    ON dbo.AuditEntries (Category, Action, [Timestamp]);
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.AuditEntries') AND name = N'IX_AuditEntries_Timestamp'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_AuditEntries_Timestamp
    ON dbo.AuditEntries ([Timestamp]);
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.AuditEntries') AND name = N'IX_AuditEntries_RunId'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_AuditEntries_RunId
    ON dbo.AuditEntries (RunId);
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.AuditEntries') AND name = N'IX_AuditEntries_ScheduleId'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_AuditEntries_ScheduleId
    ON dbo.AuditEntries (ScheduleId);
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.AuditEntries') AND name = N'IX_AuditEntries_BatchId'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_AuditEntries_BatchId
    ON dbo.AuditEntries (BatchId);
END;
