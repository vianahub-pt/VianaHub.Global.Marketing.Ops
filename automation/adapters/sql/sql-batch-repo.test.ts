/**
 * Unit tests for SqlBatchRepository (Sprint 5 — I-3c, AC-30, AC-31,
 * AC-32, D-04).
 *
 * The adapter is exercised against a deterministic in-memory `SqlExecutor`
 * declared in this file: the shared fake-sql-executor.ts only models
 * dbo.Runs and dbo.Checkpoints, so it cannot dispatch the dbo.Batches /
 * dbo.BatchItems statements. No live SQL Server is ever contacted (AC-49).
 *
 * Coverage:
 * - AC-30 (separate tables + referential integrity): full `BatchJob` and
 *   `BatchItem` round-trips (metadata, dates, `runId` null/present,
 *   `error`), deterministic ordering for `listItemsByBatchId` /
 *   `listJobsByStatus`, `getBatchWithItems`, a failed item insert against
 *   an absent parent batch and a failed item update re-pointed at an
 *   absent batch — both surfaced as `Record not found: <batchId>` (via
 *   the probe) instead of a raw FK error, plus a successful re-point to
 *   an existing batch. Corrupted rows raise `CorruptedRecordError`
 *   (FR-07 parity with the repository error semantics).
 * - AC-31 / D-04 (Opção A): no revision anywhere — no exported `*_SQL`
 *   constant and no frozen DDL column for dbo.Batches / dbo.BatchItems
 *   mentions Revision, and updates are guarded only by the primary key
 *   (consecutive updates never raise a concurrency conflict).
 * - AC-32 (contract parity): duplicate keys raise
 *   `Record already exists: <id>` and absent rows raise
 *   `Record not found: <id>`, mirroring the shared repository message
 *   convention; SQL-only behaviour never leaks into the
 *   `BatchRepository` contract.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { BatchRepository } from "../../domain/batch-repository.js";
import {
  BATCH_STATUSES,
  createBatchItem,
  createBatchJob,
  type BatchId,
  type BatchItem,
  type BatchItemId,
  type BatchJob,
} from "../../domain/batch-schema.js";
import { CorruptedRecordError } from "../persistence-errors.js";
import * as sqlBatchRepo from "./sql-batch-repo.js";
import { SELECT_SCHEDULE_REVISION_SQL } from "./sql-schedule-repo.js";
import type { SqlExecutor } from "./sql-pool.js";

const {
  INSERT_BATCH_SQL,
  INSERT_BATCH_ITEM_SQL,
  SELECT_BATCH_BY_ID_SQL,
  SELECT_BATCH_ITEM_BY_ID_SQL,
  SELECT_BATCHES_BY_STATUS_SQL,
  SELECT_BATCH_ITEMS_BY_BATCH_ID_SQL,
  UPDATE_BATCH_SQL,
  UPDATE_BATCH_ITEM_SQL,
  SqlBatchRepository,
} = sqlBatchRepo;

// ─── Stored row shapes (dbo.Batches / dbo.BatchItems) ────────────────────────

type StoredRow = Record<string, unknown>;

/** Column order of every SELECT over dbo.Batches exported by sql-batch-repo.ts. */
const BATCH_COLUMNS = [
  "BatchId",
  "SchemaVersion",
  "Status",
  "TotalItems",
  "CompletedItems",
  "FailedItems",
  "CreatedAt",
  "UpdatedAt",
  "MetadataJson",
] as const;

/** Column order of every SELECT over dbo.BatchItems exported by sql-batch-repo.ts. */
const ITEM_COLUMNS = [
  "ItemId",
  "BatchId",
  "SchemaVersion",
  "RunId",
  "Status",
  "Error",
  "CreatedAt",
  "UpdatedAt",
  "MetadataJson",
] as const;

const PK_BATCHES_MESSAGE =
  "Violation of PRIMARY KEY constraint 'PK_Batches'. Cannot insert duplicate key in object 'dbo.Batches'.";

const PK_BATCH_ITEMS_MESSAGE =
  "Violation of PRIMARY KEY constraint 'PK_BatchItems'. Cannot insert duplicate key in object 'dbo.BatchItems'.";

const FK_BATCH_ITEMS_MESSAGE =
  'The INSERT statement conflicted with the FOREIGN KEY constraint "FK_BatchItems_Batches".';

function projectRow(columns: readonly string[], row: StoredRow): unknown[] {
  return columns.map((column) => row[column]);
}

function byBatchIdAscending(a: StoredRow, b: StoredRow): number {
  const left = String(a["BatchId"]);
  const right = String(b["BatchId"]);
  return left < right ? -1 : left > right ? 1 : 0;
}

function byItemIdAscending(a: StoredRow, b: StoredRow): number {
  const left = String(a["ItemId"]);
  const right = String(b["ItemId"]);
  return left < right ? -1 : left > right ? 1 : 0;
}

// ─── In-memory executor for dbo.Batches / dbo.BatchItems ─────────────────────

interface FakeBatchExecutor extends SqlExecutor {
  /** Direct read/seed access for assertions and corruption seeds. */
  readonly batches: Map<string, StoredRow>;
  readonly items: Map<string, StoredRow>;
}

/**
 * Dispatches the exact statements exported by sql-batch-repo.ts, mirroring
 * the SQL Server semantics the repository relies on: primary-key-guarded
 * inserts, the `FK_BatchItems_Batches` referential check (an item insert
 * requires an existing parent batch and an item update requires an
 * existing target batch), `OUTPUT inserted.*` row counts for guarded
 * updates, the sentinel-free status filter and `ORDER BY` on the primary
 * key for deterministic listings.
 */
function createFakeBatchExecutor(): FakeBatchExecutor {
  const batches = new Map<string, StoredRow>();
  const items = new Map<string, StoredRow>();

  const executor: FakeBatchExecutor = {
    batches,
    items,

    async query(text, params) {
      const bound = params ?? {};

      if (text === INSERT_BATCH_SQL) {
        const batchId = bound["batchId"] as string;
        if (batches.has(batchId)) {
          throw new Error(PK_BATCHES_MESSAGE);
        }
        batches.set(batchId, {
          BatchId: batchId,
          SchemaVersion: bound["schemaVersion"],
          Status: bound["status"],
          TotalItems: bound["totalItems"],
          CompletedItems: bound["completedItems"],
          FailedItems: bound["failedItems"],
          CreatedAt: bound["createdAt"],
          UpdatedAt: bound["updatedAt"],
          MetadataJson: bound["metadataJson"],
        });
        return { columns: [], rows: [] };
      }

      if (text === SELECT_BATCH_BY_ID_SQL) {
        const row = batches.get(bound["batchId"] as string);
        if (row === undefined) {
          return { columns: BATCH_COLUMNS, rows: [] };
        }
        return { columns: BATCH_COLUMNS, rows: [projectRow(BATCH_COLUMNS, row)] };
      }

      if (text === UPDATE_BATCH_SQL) {
        const batchId = bound["batchId"] as string;
        const row = batches.get(batchId);
        if (row === undefined) {
          return { columns: [], rows: [] };
        }
        batches.set(batchId, {
          ...row,
          SchemaVersion: bound["schemaVersion"],
          Status: bound["status"],
          TotalItems: bound["totalItems"],
          CompletedItems: bound["completedItems"],
          FailedItems: bound["failedItems"],
          CreatedAt: bound["createdAt"],
          UpdatedAt: bound["updatedAt"],
          MetadataJson: bound["metadataJson"],
        });
        return { columns: ["BatchId"], rows: [[batchId]] };
      }

      if (text === SELECT_BATCHES_BY_STATUS_SQL) {
        const status = bound["status"] as string;
        const rows = [...batches.values()]
          .filter((row) => row["Status"] === status)
          .sort(byBatchIdAscending);
        return { columns: BATCH_COLUMNS, rows: rows.map((row) => projectRow(BATCH_COLUMNS, row)) };
      }

      if (text === INSERT_BATCH_ITEM_SQL) {
        const itemId = bound["itemId"] as string;
        const batchId = bound["batchId"] as string;
        if (items.has(itemId)) {
          throw new Error(PK_BATCH_ITEMS_MESSAGE);
        }
        if (!batches.has(batchId)) {
          throw new Error(FK_BATCH_ITEMS_MESSAGE);
        }
        items.set(itemId, {
          ItemId: itemId,
          BatchId: batchId,
          SchemaVersion: bound["schemaVersion"],
          RunId: bound["runId"],
          Status: bound["status"],
          Error: bound["error"],
          CreatedAt: bound["createdAt"],
          UpdatedAt: bound["updatedAt"],
          MetadataJson: bound["metadataJson"],
        });
        return { columns: [], rows: [] };
      }

      if (text === SELECT_BATCH_ITEM_BY_ID_SQL) {
        const row = items.get(bound["itemId"] as string);
        if (row === undefined) {
          return { columns: ITEM_COLUMNS, rows: [] };
        }
        return { columns: ITEM_COLUMNS, rows: [projectRow(ITEM_COLUMNS, row)] };
      }

      if (text === UPDATE_BATCH_ITEM_SQL) {
        const itemId = bound["itemId"] as string;
        const batchId = bound["batchId"] as string;
        // FK_BatchItems_Batches também vale no UPDATE: mover o item para
        // um batch alvo inexistente é rejeitado antes de aplicar a linha.
        if (!batches.has(batchId)) {
          throw new Error(FK_BATCH_ITEMS_MESSAGE);
        }
        const row = items.get(itemId);
        if (row === undefined) {
          return { columns: [], rows: [] };
        }
        items.set(itemId, {
          ...row,
          BatchId: batchId,
          SchemaVersion: bound["schemaVersion"],
          RunId: bound["runId"],
          Status: bound["status"],
          Error: bound["error"],
          CreatedAt: bound["createdAt"],
          UpdatedAt: bound["updatedAt"],
          MetadataJson: bound["metadataJson"],
        });
        return { columns: ["ItemId"], rows: [[itemId]] };
      }

      if (text === SELECT_BATCH_ITEMS_BY_BATCH_ID_SQL) {
        const batchId = bound["batchId"] as string;
        const statusFilter = bound["statusFilter"] as string;
        const status = bound["status"] as string;
        const rows = [...items.values()]
          .filter(
            (row) =>
              row["BatchId"] === batchId && (statusFilter === "" || row["Status"] === status),
          )
          .sort(byItemIdAscending);
        return { columns: ITEM_COLUMNS, rows: rows.map((row) => projectRow(ITEM_COLUMNS, row)) };
      }

      throw new Error(`Statement not supported by the batch test executor: ${text.slice(0, 160)}`);
    },

    async transaction(statements) {
      for (const statement of statements) {
        await executor.query(statement.text, statement.params);
      }
    },

    async close() {
      // Auto-tests never open sockets.
    },
  };

  return executor;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Builds a valid `BatchJob` with fixed ids/dates (`batch-a` by default). */
function makeJob(overrides: Partial<BatchJob> = {}): BatchJob {
  return {
    ...createBatchJob({ source: "test" }),
    batchId: "batch-a" as BatchId,
    createdAt: new Date("2026-07-01T09:00:00.000Z"),
    updatedAt: new Date("2026-07-01T10:00:00.000Z"),
    ...overrides,
  };
}

/** Builds a valid `BatchItem` with fixed ids/dates (`item-a` on `batch-a`). */
function makeItem(overrides: Partial<BatchItem> = {}): BatchItem {
  return {
    ...createBatchItem("batch-a" as BatchId, { source: "test" }),
    itemId: "item-a" as BatchItemId,
    createdAt: new Date("2026-07-01T11:00:00.000Z"),
    updatedAt: new Date("2026-07-01T12:00:00.000Z"),
    ...overrides,
  };
}

/** Positional `dbo.Batches` row for a job (corruption seeds). */
function seedJobRow(executor: FakeBatchExecutor, job: BatchJob, overrides: StoredRow = {}): void {
  executor.batches.set(job.batchId, {
    BatchId: job.batchId,
    SchemaVersion: job.schemaVersion,
    Status: job.status,
    TotalItems: job.totalItems,
    CompletedItems: job.completedItems,
    FailedItems: job.failedItems,
    CreatedAt: job.createdAt,
    UpdatedAt: job.updatedAt,
    MetadataJson: job.metadata === undefined ? null : JSON.stringify(job.metadata),
    ...overrides,
  });
}

/** Positional `dbo.BatchItems` row for an item (corruption seeds). */
function seedItemRow(
  executor: FakeBatchExecutor,
  item: BatchItem,
  overrides: StoredRow = {},
): void {
  executor.items.set(item.itemId, {
    ItemId: item.itemId,
    BatchId: item.batchId,
    SchemaVersion: item.schemaVersion,
    RunId: item.runId,
    Status: item.status,
    Error: item.error ?? null,
    CreatedAt: item.createdAt,
    UpdatedAt: item.updatedAt,
    MetadataJson: item.metadata === undefined ? null : JSON.stringify(item.metadata),
    ...overrides,
  });
}

function newRepo() {
  const executor = createFakeBatchExecutor();
  return { executor, repo: new SqlBatchRepository(executor) };
}

// ─── AC-30 / AC-32 — createJob e getJobById ──────────────────────────────────

describe("SqlBatchRepository — createJob e getJobById (AC-30, AC-32)", () => {
  it("faz round-trip completo de um job com todos os campos e metadata", async () => {
    const { executor, repo } = newRepo();
    const job = makeJob({
      status: "succeeded",
      totalItems: 5,
      completedItems: 4,
      failedItems: 1,
      metadata: { source: "test" },
    });

    await expect(repo.createJob(job)).resolves.toEqual(job);
    const fetched = await repo.getJobById(job.batchId);

    expect(fetched).toEqual(job);
    expect(fetched?.schemaVersion).toBe(1);
    expect(fetched?.status).toBe("succeeded");
    expect(fetched?.totalItems).toBe(5);
    expect(fetched?.completedItems).toBe(4);
    expect(fetched?.failedItems).toBe(1);
    expect(fetched?.createdAt).toBeInstanceOf(Date);
    expect(fetched?.updatedAt).toBeInstanceOf(Date);
    expect(fetched?.createdAt).toEqual(job.createdAt);
    expect(fetched?.updatedAt).toEqual(job.updatedAt);
    expect(fetched?.metadata).toEqual({ source: "test" });
    expect(executor.batches.get(job.batchId)?.["MetadataJson"]).toBe(
      JSON.stringify({ source: "test" }),
    );
  });

  it("faz round-trip de um job sem metadata (MetadataJson persistido como null)", async () => {
    const { executor, repo } = newRepo();
    const job = makeJob({ metadata: undefined });

    await expect(repo.createJob(job)).resolves.toEqual(job);
    const fetched = await repo.getJobById(job.batchId);

    expect(fetched).toEqual(job);
    expect(fetched?.metadata).toBeUndefined();
    expect(executor.batches.get(job.batchId)?.["MetadataJson"]).toBeNull();
  });

  it("preserva todos os statuses de BATCH_STATUSES em round-trip", async () => {
    const { repo } = newRepo();

    for (const status of BATCH_STATUSES) {
      const job = makeJob({ batchId: `batch-${status}` as BatchId, status });
      await repo.createJob(job);
      await expect(repo.getJobById(job.batchId)).resolves.toEqual(job);
    }
  });

  it("rejeita batchId duplicado com a mensagem de paridade do file adapter", async () => {
    const { repo } = newRepo();
    const job = makeJob();
    await repo.createJob(job);

    await expect(repo.createJob({ ...job })).rejects.toThrow(
      `Record already exists: ${job.batchId}`,
    );
  });

  it("propaga o erro original do executor quando a sonda de duplicata falha", async () => {
    const { executor, repo } = newRepo();
    const conflicting = makeJob({ batchId: "batch-corrupt" as BatchId });
    seedJobRow(executor, conflicting, { MetadataJson: "{not-json" });

    await expect(repo.createJob(conflicting)).rejects.toThrow(/PK_Batches/);
  });

  it("retorna null para um batchId desconhecido", async () => {
    const { repo } = newRepo();
    await expect(repo.getJobById("batch-missing" as BatchId)).resolves.toBeNull();
  });
});

// ─── AC-30 / AC-32 — createItem e getItemById ────────────────────────────────

describe("SqlBatchRepository — createItem e getItemById (AC-30, AC-32)", () => {
  it("faz round-trip de um item mínimo: runId null, sem error e metadata vazia", async () => {
    const { executor, repo } = newRepo();
    await repo.createJob(makeJob());
    const item = makeItem({ metadata: {} });

    await expect(repo.createItem(item)).resolves.toEqual(item);
    const fetched = await repo.getItemById(item.itemId);

    expect(fetched).toEqual(item);
    expect(fetched?.batchId).toBe("batch-a");
    expect(fetched?.runId).toBeNull();
    expect(fetched?.status).toBe("pending");
    expect(fetched?.error).toBeUndefined();
    expect(fetched?.metadata).toEqual({});
    expect(executor.items.get(item.itemId)?.["RunId"]).toBeNull();
    expect(executor.items.get(item.itemId)?.["Error"]).toBeNull();
    expect(executor.items.get(item.itemId)?.["MetadataJson"]).toBe("{}");
  });

  it("faz round-trip completo de um item com runId, error, metadata e datas", async () => {
    const { executor, repo } = newRepo();
    await repo.createJob(makeJob());
    const item = makeItem({
      status: "failed",
      runId: "run-42",
      error: "boom",
      metadata: { source: "test" },
    });

    await expect(repo.createItem(item)).resolves.toEqual(item);
    const fetched = await repo.getItemById(item.itemId);

    expect(fetched).toEqual(item);
    expect(fetched?.schemaVersion).toBe(1);
    expect(fetched?.runId).toBe("run-42");
    expect(fetched?.status).toBe("failed");
    expect(fetched?.error).toBe("boom");
    expect(fetched?.createdAt).toBeInstanceOf(Date);
    expect(fetched?.updatedAt).toBeInstanceOf(Date);
    expect(fetched?.metadata).toEqual({ source: "test" });
    expect(executor.items.get(item.itemId)?.["RunId"]).toBe("run-42");
    expect(executor.items.get(item.itemId)?.["Error"]).toBe("boom");
  });

  it("rejeita itemId duplicado com a mensagem de paridade do file adapter", async () => {
    const { repo } = newRepo();
    await repo.createJob(makeJob());
    const item = makeItem();
    await repo.createItem(item);

    await expect(repo.createItem({ ...item })).rejects.toThrow(
      `Record already exists: ${item.itemId}`,
    );
  });

  it("rejeita item órfão com Record not found do batch inexistente (FK)", async () => {
    const { repo } = newRepo();
    await repo.createJob(makeJob());
    const orphan = makeItem({
      itemId: "item-a" as BatchItemId,
      batchId: "batch-missing" as BatchId,
    });

    await expect(repo.createItem(orphan)).rejects.toThrow("Record not found: batch-missing");
  });

  it("propaga o erro original do executor quando a sonda de itemId falha", async () => {
    const { executor, repo } = newRepo();
    const conflicting = makeItem({ itemId: "item-corrupt" as BatchItemId });
    seedItemRow(executor, conflicting, { MetadataJson: "{not-json" });

    await expect(
      repo.createItem(makeItem({ itemId: "item-corrupt" as BatchItemId })),
    ).rejects.toThrow(/PK_BatchItems/);
  });

  it("retorna null para um itemId desconhecido", async () => {
    const { repo } = newRepo();
    await expect(repo.getItemById("item-missing" as BatchItemId)).resolves.toBeNull();
  });
});

// ─── AC-30 / AC-31 — updateJob e updateItem ──────────────────────────────────

describe("SqlBatchRepository — updateJob e updateItem (AC-30, AC-31)", () => {
  it("updateJob persiste o novo estado e o getJobById reflete a substituição", async () => {
    const { executor, repo } = newRepo();
    const created = await repo.createJob(makeJob());
    const next: BatchJob = {
      ...created,
      status: "running",
      totalItems: 4,
      completedItems: 2,
      failedItems: 0,
      updatedAt: new Date("2026-07-02T08:00:00.000Z"),
      metadata: { source: "test" },
    };

    await expect(repo.updateJob(next)).resolves.toEqual(next);
    await expect(repo.getJobById(created.batchId)).resolves.toEqual(next);
    expect(executor.batches.get(created.batchId)?.["Status"]).toBe("running");
    expect(executor.batches.get(created.batchId)?.["TotalItems"]).toBe(4);
    expect(executor.batches.get(created.batchId)?.["CompletedItems"]).toBe(2);
  });

  it("updateItem persiste o novo estado e o getItemById reflete a substituição", async () => {
    const { executor, repo } = newRepo();
    await repo.createJob(makeJob());
    const created = await repo.createItem(makeItem());
    const next: BatchItem = {
      ...created,
      status: "succeeded",
      runId: "run-7",
      updatedAt: new Date("2026-07-02T09:00:00.000Z"),
      metadata: { source: "test" },
    };

    await expect(repo.updateItem(next)).resolves.toEqual(next);
    await expect(repo.getItemById(created.itemId)).resolves.toEqual(next);
    expect(executor.items.get(created.itemId)?.["Status"]).toBe("succeeded");
    expect(executor.items.get(created.itemId)?.["RunId"]).toBe("run-7");
  });

  it("updateJob lança Record not found quando o batchId não existe", async () => {
    const { repo } = newRepo();
    const missing = makeJob({ batchId: "batch-absent" as BatchId });

    await expect(repo.updateJob(missing)).rejects.toThrow(/^Record not found: batch-absent$/);
  });

  it("updateItem lança Record not found quando o itemId não existe", async () => {
    const { repo } = newRepo();
    const missing = makeItem({ itemId: "item-absent" as BatchItemId });

    await expect(repo.updateItem(missing)).rejects.toThrow(/^Record not found: item-absent$/);
  });

  it("updateItem aponta o batchId alvo ausente como Record not found, não como erro bruto da FK", async () => {
    const { executor, repo } = newRepo();
    await repo.createJob(makeJob());
    const created = await repo.createItem(makeItem());
    const moved: BatchItem = { ...created, batchId: "batch-missing" as BatchId };

    await expect(repo.updateItem(moved)).rejects.toThrow(/^Record not found: batch-missing$/);
    // A linha original permanece intacta: a violação foi da FK, não um update parcial.
    expect(executor.items.get(created.itemId)?.["BatchId"]).toBe("batch-a");
  });

  it("updateItem de item inexistente responde Record not found: <itemId> mesmo com o batch alvo ausente", async () => {
    const { repo } = newRepo();
    await repo.createJob(makeJob());

    // Batch alvo existe: o UPDATE casa nenhuma linha.
    await expect(
      repo.updateItem(makeItem({ itemId: "item-absent" as BatchItemId })),
    ).rejects.toThrow(/^Record not found: item-absent$/);

    // Batch alvo ausente: a sonda ainda responde pelo item, nunca pela FK.
    await expect(
      repo.updateItem(
        makeItem({
          itemId: "item-absent-2" as BatchItemId,
          batchId: "batch-missing" as BatchId,
        }),
      ),
    ).rejects.toThrow(/^Record not found: item-absent-2$/);
  });

  it("updateItem troca o BatchId com sucesso quando o batch alvo existe", async () => {
    const { executor, repo } = newRepo();
    await repo.createJob(makeJob());
    await repo.createJob(makeJob({ batchId: "batch-b" as BatchId }));
    const created = await repo.createItem(makeItem());
    const moved: BatchItem = {
      ...created,
      batchId: "batch-b" as BatchId,
      updatedAt: new Date("2026-07-02T10:00:00.000Z"),
    };

    await expect(repo.updateItem(moved)).resolves.toEqual(moved);
    await expect(repo.getItemById(created.itemId)).resolves.toEqual(moved);
    expect(executor.items.get(created.itemId)?.["BatchId"]).toBe("batch-b");
    expect(executor.items.get(created.itemId)?.["Status"]).toBe(created.status);
  });

  it("guarda o update só pela chave primária: atualizações seguidas não conflitam (AC-31)", async () => {
    const { repo } = newRepo();
    const created = await repo.createJob(makeJob());

    const running = { ...created, status: "running" as const };
    const succeeded = { ...created, status: "succeeded" as const };

    await expect(repo.updateJob(running)).resolves.toEqual(running);
    await expect(repo.updateJob(succeeded)).resolves.toEqual(succeeded);
    await expect(repo.getJobById(created.batchId)).resolves.toEqual(succeeded);
  });
});

// ─── AC-30 — listItemsByBatchId e listJobsByStatus ───────────────────────────

describe("SqlBatchRepository — listItemsByBatchId e listJobsByStatus (AC-30)", () => {
  async function seedItemSet(repo: BatchRepository) {
    await repo.createJob(makeJob());
    // Inserção deliberadamente fora de ordem para provar a ordenação.
    const itemC = makeItem({ itemId: "item-c" as BatchItemId, status: "failed", error: "boom" });
    const itemA = makeItem({ itemId: "item-a" as BatchItemId, status: "pending", metadata: {} });
    const itemB = makeItem({
      itemId: "item-b" as BatchItemId,
      status: "pending",
      runId: "run-1",
    });
    for (const item of [itemC, itemA, itemB]) {
      await repo.createItem(item);
    }
    return { itemA, itemB, itemC };
  }

  it("lista todos os itens do batch ordenados por ItemId ASC, sem filtros", async () => {
    const { repo } = newRepo();
    const seeded = await seedItemSet(repo);

    const all = await repo.listItemsByBatchId("batch-a" as BatchId);

    expect(all).toEqual([seeded.itemA, seeded.itemB, seeded.itemC]);
    expect(await repo.listItemsByBatchId("batch-a" as BatchId, {})).toHaveLength(3);
    // Itens de outros batches não vazam para a listagem.
    expect(await repo.listItemsByBatchId("batch-b" as BatchId)).toEqual([]);
  });

  it("filtra itens por status e retorna lista vazia sem correspondência", async () => {
    const { repo } = newRepo();
    const seeded = await seedItemSet(repo);

    expect(await repo.listItemsByBatchId("batch-a" as BatchId, { status: "pending" })).toEqual([
      seeded.itemA,
      seeded.itemB,
    ]);
    expect(await repo.listItemsByBatchId("batch-a" as BatchId, { status: "failed" })).toEqual([
      seeded.itemC,
    ]);
    expect(await repo.listItemsByBatchId("batch-a" as BatchId, { status: "running" })).toEqual([]);
  });

  it("lista jobs pelo status presente, ordenados por BatchId ASC", async () => {
    const { repo } = newRepo();
    const jobB = makeJob({ batchId: "batch-b" as BatchId, status: "succeeded" });
    const jobA = makeJob({
      batchId: "batch-a" as BatchId,
      status: "succeeded",
      totalItems: 3,
      completedItems: 3,
      failedItems: 0,
    });
    const jobC = makeJob({ batchId: "batch-c" as BatchId, status: "pending" });
    // Inserção deliberadamente fora de ordem para provar a ordenação.
    for (const job of [jobB, jobA, jobC]) {
      await repo.createJob(job);
    }

    expect(await repo.listJobsByStatus("succeeded")).toEqual([jobA, jobB]);
    expect(await repo.listJobsByStatus("pending")).toEqual([jobC]);
  });

  it("lista jobs por status ausente retornando a lista vazia", async () => {
    const { repo } = newRepo();
    await repo.createJob(makeJob({ batchId: "batch-a" as BatchId, status: "succeeded" }));

    expect(await repo.listJobsByStatus("failed")).toEqual([]);
    expect(await repo.listJobsByStatus("cancelled")).toEqual([]);
  });
});

// ─── AC-30 — getBatchWithItems ───────────────────────────────────────────────

describe("SqlBatchRepository — getBatchWithItems (AC-30)", () => {
  it("retorna o job e todos os seus itens, ordenados por ItemId ASC", async () => {
    const { repo } = newRepo();
    const job = makeJob();
    const itemB = makeItem({ itemId: "item-b" as BatchItemId, runId: "run-3" });
    const itemA = makeItem({ itemId: "item-a" as BatchItemId, status: "running" });

    await repo.createJob(job);
    await repo.createItem(itemB);
    await repo.createItem(itemA);

    const result = await repo.getBatchWithItems(job.batchId);

    expect(result?.job).toEqual(job);
    expect(result?.items).toEqual([itemA, itemB]);
    expect(result?.items.map((item) => item.itemId)).toEqual(["item-a", "item-b"]);
  });

  it("retorna o job com lista de itens vazia quando o batch não tem itens", async () => {
    const { repo } = newRepo();
    const job = makeJob({ batchId: "batch-b" as BatchId });
    await repo.createJob(job);

    await expect(repo.getBatchWithItems(job.batchId)).resolves.toEqual({ job, items: [] });
  });

  it("retorna null para um batch inexistente", async () => {
    const { repo } = newRepo();
    await repo.createJob(makeJob());

    await expect(repo.getBatchWithItems("batch-missing" as BatchId)).resolves.toBeNull();
  });
});

// ─── Linhas corrompidas (FR-07 parity) ───────────────────────────────────────

describe("SqlBatchRepository — armazenamento corrompido", () => {
  it("lança CorruptedRecordError quando MetadataJson do job não é JSON válido", async () => {
    const { executor, repo } = newRepo();
    seedJobRow(executor, makeJob({ batchId: "batch-corrupt-1" as BatchId }), {
      MetadataJson: "{not-json",
    });

    await expect(repo.getJobById("batch-corrupt-1" as BatchId)).rejects.toBeInstanceOf(
      CorruptedRecordError,
    );
  });

  it("lança CorruptedRecordError quando uma coluna datetime do job não é Date", async () => {
    const { executor, repo } = newRepo();
    seedJobRow(executor, makeJob({ batchId: "batch-corrupt-2" as BatchId }), {
      CreatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(repo.getJobById("batch-corrupt-2" as BatchId)).rejects.toBeInstanceOf(
      CorruptedRecordError,
    );
  });

  it("lança CorruptedRecordError quando o status do job viola o enum do domínio", async () => {
    const { executor, repo } = newRepo();
    seedJobRow(executor, makeJob({ batchId: "batch-corrupt-3" as BatchId }), {
      Status: "bogus",
    });

    await expect(repo.getJobById("batch-corrupt-3" as BatchId)).rejects.toBeInstanceOf(
      CorruptedRecordError,
    );
  });

  it("lança CorruptedRecordError quando MetadataJson do item não é JSON válido", async () => {
    const { executor, repo } = newRepo();
    seedItemRow(executor, makeItem({ itemId: "item-corrupt-1" as BatchItemId }), {
      MetadataJson: "{not-json",
    });

    await expect(repo.getItemById("item-corrupt-1" as BatchItemId)).rejects.toBeInstanceOf(
      CorruptedRecordError,
    );
  });

  it("lança CorruptedRecordError quando uma coluna datetime do item não é Date", async () => {
    const { executor, repo } = newRepo();
    seedItemRow(executor, makeItem({ itemId: "item-corrupt-2" as BatchItemId }), {
      UpdatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(repo.getItemById("item-corrupt-2" as BatchItemId)).rejects.toBeInstanceOf(
      CorruptedRecordError,
    );
  });

  it("lança CorruptedRecordError quando o status do item viola o enum do domínio", async () => {
    const { executor, repo } = newRepo();
    seedItemRow(executor, makeItem({ itemId: "item-corrupt-3" as BatchItemId }), {
      Status: "bogus",
    });

    await expect(repo.getItemById("item-corrupt-3" as BatchItemId)).rejects.toBeInstanceOf(
      CorruptedRecordError,
    );
  });

  it("propaga a corrupção durante listJobsByStatus", async () => {
    const { executor, repo } = newRepo();
    seedJobRow(executor, makeJob({ batchId: "batch-good" as BatchId }));
    seedJobRow(executor, makeJob({ batchId: "batch-corrupt-list" as BatchId }), {
      MetadataJson: "}",
    });

    await expect(repo.listJobsByStatus("pending")).rejects.toBeInstanceOf(CorruptedRecordError);
  });

  it("propaga a corrupção durante listItemsByBatchId", async () => {
    const { executor, repo } = newRepo();
    seedItemRow(executor, makeItem({ itemId: "item-good" as BatchItemId }));
    seedItemRow(executor, makeItem({ itemId: "item-corrupt-list" as BatchItemId }), {
      MetadataJson: "}",
    });

    await expect(repo.listItemsByBatchId("batch-a" as BatchId)).rejects.toBeInstanceOf(
      CorruptedRecordError,
    );
  });
});

// ─── Statements e DDL estáticos sem revision (AC-31, D-04) ───────────────────

describe("SqlBatchRepository — statements e DDL sem revision (AC-31, D-04)", () => {
  const migrationSql = readFileSync(
    fileURLToPath(new URL("../../../database/migrations/001_initial_schema.sql", import.meta.url)),
    "utf8",
  );

  it("nenhuma constante *_SQL exportada contém Revision (AC-31)", () => {
    const exportedSqlConstants = Object.entries(sqlBatchRepo).filter(
      ([name, value]) => name.endsWith("_SQL") && typeof value === "string",
    );

    expect(exportedSqlConstants.length).toBeGreaterThan(0);
    for (const [name, value] of exportedSqlConstants) {
      expect(String(value), `constante exportada ${name}`).not.toMatch(/Revision/i);
    }

    // Controle: o detector enxerga Revision onde ela existe (schedules).
    expect(SELECT_SCHEDULE_REVISION_SQL).toMatch(/Revision/);
  });

  it("dbo.Batches e dbo.BatchItems não declaram coluna Revision no DDL (D-04)", () => {
    const batchesTable = migrationSql.match(/CREATE TABLE dbo\.Batches \(([\s\S]*?)\);/);
    expect(batchesTable).not.toBeNull();
    expect(batchesTable?.[1]).not.toMatch(/Revision/);

    const itemsTable = migrationSql.match(/CREATE TABLE dbo\.BatchItems \(([\s\S]*?)\);/);
    expect(itemsTable).not.toBeNull();
    expect(itemsTable?.[1]).not.toMatch(/Revision/);

    // Controle: dbo.Schedules continua declarando Revision — o teste não é vazio.
    const schedulesTable = migrationSql.match(/CREATE TABLE dbo\.Schedules \(([\s\S]*?)\);/);
    expect(schedulesTable).not.toBeNull();
    expect(schedulesTable?.[1]).toMatch(/Revision/);
  });
});
