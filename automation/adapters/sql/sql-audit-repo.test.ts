/**
 * Unit tests for SqlAuditRepository (Sprint 5 — I-3d.2, AC-33, AC-34,
 * AC-35).
 *
 * The adapter is exercised against a deterministic in-memory `SqlExecutor`
 * declared in this file. No live SQL Server is ever contacted (AC-49).
 *
 * Coverage:
 * - AC-33: append round-trip (all `AuditEntry` fields incl. metadata),
 *   append duplicate (PK violation → `Audit entry already exists:`),
 *   append with null MetadataJson stored as null.
 * - AC-34: list without filters (all), individual filters (category,
 *   action, RunId, ScheduleId, BatchId), combined filters, sentinel-free
 *   (empty string = no filter), listByCorrelation (empty / single / multi
 *   OR), listByTimeRange (inclusive bounds), listByCategory.
 * - AC-35: append with invalid MetadataJson → `CorruptedRecordError`
 *   (defense-in-depth on read).
 */

import { describe, expect, it } from "vitest";

import type { AuditEntry, AuditEntryId } from "../../domain/audit-entry.js";
import { CorruptedRecordError } from "../persistence-errors.js";
import type { SqlExecutor } from "./sql-pool.js";
import {
  INSERT_AUDIT_ENTRY_SQL,
  SELECT_AUDIT_ENTRIES_SQL,
  SELECT_AUDIT_ENTRIES_BY_CORRELATION_SQL,
  SELECT_AUDIT_ENTRIES_BY_TIME_RANGE_SQL,
  SELECT_AUDIT_ENTRIES_BY_CATEGORY_SQL,
  SELECT_AUDIT_ENTRY_EXISTS_SQL,
  SqlAuditRepository,
} from "./sql-audit-repo.js";

// ─── Stored row shape (dbo.AuditEntries) ─────────────────────────────────────

type StoredAuditRow = Record<string, unknown>;

/** Column order of every SELECT exported by sql-audit-repo.ts. */
const AUDIT_COLUMNS = [
  "EntryId",
  "Timestamp",
  "Category",
  "Action",
  "Actor",
  "RunId",
  "ScheduleId",
  "BatchId",
  "PreviousState",
  "NewState",
  "MetadataJson",
] as const;

const PK_AUDIT_ENTRIES_MESSAGE =
  "Violation of PRIMARY KEY constraint 'PK_AuditEntries'. Cannot insert duplicate key in object 'dbo.AuditEntries'.";

function projectRow(row: StoredAuditRow): unknown[] {
  return AUDIT_COLUMNS.map((column) => row[column]);
}

function byTimestampThenEntryId(a: StoredAuditRow, b: StoredAuditRow): number {
  const ta = (a["Timestamp"] as Date).getTime();
  const tb = (b["Timestamp"] as Date).getTime();
  if (ta !== tb) {
    return ta - tb;
  }
  const ea = String(a["EntryId"]);
  const eb = String(b["EntryId"]);
  return ea < eb ? -1 : ea > eb ? 1 : 0;
}

// ─── In-memory executor for dbo.AuditEntries ─────────────────────────────────

interface FakeAuditExecutor extends SqlExecutor {
  /** Direct read/seed access for assertions. */
  readonly entries: Map<string, StoredAuditRow>;
}

function createFakeAuditExecutor(): FakeAuditExecutor {
  const entries = new Map<string, StoredAuditRow>();

  const executor: FakeAuditExecutor = {
    entries,

    async query(text, params) {
      const bound = params ?? {};

      if (text === INSERT_AUDIT_ENTRY_SQL) {
        const entryId = bound["entryId"] as string;
        if (entries.has(entryId)) {
          throw new Error(PK_AUDIT_ENTRIES_MESSAGE);
        }
        entries.set(entryId, {
          EntryId: entryId,
          Timestamp: bound["timestamp"],
          Category: bound["category"],
          Action: bound["action"],
          Actor: bound["actor"],
          RunId: bound["runId"],
          ScheduleId: bound["scheduleId"],
          BatchId: bound["batchId"],
          PreviousState: bound["previousState"],
          NewState: bound["newState"],
          MetadataJson: bound["metadataJson"],
        });
        return { columns: [], rows: [] };
      }

      if (text === SELECT_AUDIT_ENTRY_EXISTS_SQL) {
        const entryId = bound["entryId"] as string;
        if (entries.has(entryId)) {
          return { columns: ["EntryId"], rows: [[entryId]] };
        }
        return { columns: ["EntryId"], rows: [] };
      }

      if (text === SELECT_AUDIT_ENTRIES_SQL) {
        const category = bound["category"] as string;
        const action = bound["action"] as string;
        const runId = bound["runId"] as string;
        const scheduleId = bound["scheduleId"] as string;
        const batchId = bound["batchId"] as string;
        const since = bound["since"] as Date | null;
        const until = bound["until"] as Date | null;

        const rows = [...entries.values()]
          .filter(
            (row) =>
              (category === "" || row["Category"] === category) &&
              (action === "" || row["Action"] === action) &&
              (runId === "" || row["RunId"] === runId) &&
              (scheduleId === "" || row["ScheduleId"] === scheduleId) &&
              (batchId === "" || row["BatchId"] === batchId) &&
              (since === null || (row["Timestamp"] as Date) >= since) &&
              (until === null || (row["Timestamp"] as Date) <= until),
          )
          .sort(byTimestampThenEntryId);
        return { columns: AUDIT_COLUMNS, rows: rows.map(projectRow) };
      }

      if (text === SELECT_AUDIT_ENTRIES_BY_CORRELATION_SQL) {
        const runId = bound["runId"] as string | null;
        const scheduleId = bound["scheduleId"] as string | null;
        const batchId = bound["batchId"] as string | null;

        const rows = [...entries.values()]
          .filter(
            (row) =>
              (runId !== null && row["RunId"] === runId) ||
              (scheduleId !== null && row["ScheduleId"] === scheduleId) ||
              (batchId !== null && row["BatchId"] === batchId),
          )
          .sort(byTimestampThenEntryId);
        return { columns: AUDIT_COLUMNS, rows: rows.map(projectRow) };
      }

      if (text === SELECT_AUDIT_ENTRIES_BY_TIME_RANGE_SQL) {
        const from = bound["from"] as Date;
        const to = bound["to"] as Date;

        const rows = [...entries.values()]
          .filter((row) => (row["Timestamp"] as Date) >= from && (row["Timestamp"] as Date) <= to)
          .sort(byTimestampThenEntryId);
        return { columns: AUDIT_COLUMNS, rows: rows.map(projectRow) };
      }

      if (text === SELECT_AUDIT_ENTRIES_BY_CATEGORY_SQL) {
        const category = bound["category"] as string;

        const rows = [...entries.values()]
          .filter((row) => row["Category"] === category)
          .sort(byTimestampThenEntryId);
        return { columns: AUDIT_COLUMNS, rows: rows.map(projectRow) };
      }

      throw new Error(`Statement not supported by the audit test executor: ${text.slice(0, 160)}`);
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

let nextEntrySequence = 0;

function makeEntry(
  overrides: Omit<Partial<AuditEntry>, "entryId"> & { entryId?: string } = {},
): AuditEntry {
  nextEntrySequence += 1;
  const { entryId: rawEntryId, ...rest } = overrides;
  return {
    entryId: (rawEntryId ?? `entry-${nextEntrySequence}`) as AuditEntryId,
    timestamp: new Date("2026-06-01T10:00:00.000Z"),
    category: "schedule",
    action: "created",
    actor: "system",
    correlationIds: {
      runId: `run-${nextEntrySequence}`,
      scheduleId: `sched-${nextEntrySequence}`,
      batchId: `batch-${nextEntrySequence}`,
    },
    previousState: undefined,
    newState: "active",
    metadata: undefined,
    ...rest,
  };
}

function newRepo() {
  const executor = createFakeAuditExecutor();
  return { executor, repo: new SqlAuditRepository(executor) };
}

// ─── AC-33 — append round-trip ───────────────────────────────────────────────

describe("SqlAuditRepository — append (AC-33)", () => {
  it("faz round-trip de todos os campos de AuditEntry, incluindo metadata", async () => {
    const { executor, repo } = newRepo();
    const entry = makeEntry({
      previousState: "draft",
      newState: "active",
      metadata: { owner: "ops", tags: ["daily", "pt"], count: 42 },
    });

    const result = await repo.append(entry);

    expect(result.entryId).toBe(entry.entryId);
    expect(result.timestamp).toEqual(entry.timestamp);
    expect(result.category).toBe(entry.category);
    expect(result.action).toBe(entry.action);
    expect(result.actor).toBe(entry.actor);
    expect(result.correlationIds.runId).toBe(entry.correlationIds.runId);
    expect(result.correlationIds.scheduleId).toBe(entry.correlationIds.scheduleId);
    expect(result.correlationIds.batchId).toBe(entry.correlationIds.batchId);
    expect(result.previousState).toBe("draft");
    expect(result.newState).toBe("active");
    expect(result.metadata).toEqual({ owner: "ops", tags: ["daily", "pt"], count: 42 });

    // Verifica persistência no executor
    const row = executor.entries.get(entry.entryId);
    expect(row).toBeDefined();
    expect(row?.["MetadataJson"]).toBe(
      JSON.stringify({ owner: "ops", tags: ["daily", "pt"], count: 42 }),
    );
    expect(row?.["RunId"]).toBe(entry.correlationIds.runId);
    expect(row?.["ScheduleId"]).toBe(entry.correlationIds.scheduleId);
    expect(row?.["BatchId"]).toBe(entry.correlationIds.batchId);
  });

  it("armazena null para campos opcionais ausentes (PreviousState, NewState, MetadataJson)", async () => {
    const { executor, repo } = newRepo();
    const entry = makeEntry({
      correlationIds: {},
      previousState: undefined,
      newState: undefined,
      metadata: undefined,
    });

    const result = await repo.append(entry);

    expect(result.previousState).toBeUndefined();
    expect(result.newState).toBeUndefined();
    expect(result.metadata).toBeUndefined();

    const row = executor.entries.get(entry.entryId);
    expect(row?.["PreviousState"]).toBeNull();
    expect(row?.["NewState"]).toBeNull();
    expect(row?.["MetadataJson"]).toBeNull();
    expect(row?.["RunId"]).toBeNull();
    expect(row?.["ScheduleId"]).toBeNull();
    expect(row?.["BatchId"]).toBeNull();
  });

  it("lança erro de duplicata quando entryId já existe (PK violation)", async () => {
    const { repo } = newRepo();
    const entry = makeEntry();
    await repo.append(entry);

    await expect(repo.append({ ...entry })).rejects.toThrow(
      `Audit entry already exists: ${entry.entryId}`,
    );
  });

  it("propaga o erro original do executor quando a sonda de duplicata falha", async () => {
    const { executor, repo } = newRepo();
    const entry = makeEntry();

    // Força erro no INSERT que não é PK violation
    const originalQuery = executor.query.bind(executor);
    let callCount = 0;
    executor.query = async (text, params) => {
      callCount += 1;
      if (text === INSERT_AUDIT_ENTRY_SQL && callCount === 1) {
        throw new Error("Connection timeout");
      }
      return originalQuery(text, params);
    };

    await expect(repo.append(entry)).rejects.toThrow("Connection timeout");
  });

  it("redactAuditEntry é aplicado antes da persistência (AC-26 parity)", async () => {
    const { executor, repo } = newRepo();
    // Usa JWT para ativar redação (PASSWORD_PATTERN requer 'password=' no valor)
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const entry = makeEntry({
      metadata: { token: jwt, normal: "value" },
    });

    const result = await repo.append(entry);

    // O JWT deve ser redactado
    expect(result.metadata?.["token"]).toContain("REDACTED");
    expect(result.metadata?.["normal"]).toBe("value");

    // A linha armazenada também deve conter o valor redactado
    const row = executor.entries.get(entry.entryId);
    const storedMeta = JSON.parse(row?.["MetadataJson"] as string);
    expect(storedMeta.token).toContain("REDACTED");
    expect(storedMeta.normal).toBe("value");
  });
});

// ─── AC-34 — list com filtros ────────────────────────────────────────────────

describe("SqlAuditRepository — list (AC-34)", () => {
  async function seedStandardSet(repo: SqlAuditRepository) {
    const entryA = makeEntry({
      entryId: "entry-a",
      timestamp: new Date("2026-06-01T01:00:00.000Z"),
      category: "schedule",
      action: "created",
      correlationIds: { runId: "run-1", scheduleId: "sched-1", batchId: "batch-1" },
    });
    const entryB = makeEntry({
      entryId: "entry-b",
      timestamp: new Date("2026-06-01T02:00:00.000Z"),
      category: "run",
      action: "started",
      correlationIds: { runId: "run-1", scheduleId: "sched-2", batchId: "batch-2" },
    });
    const entryC = makeEntry({
      entryId: "entry-c",
      timestamp: new Date("2026-06-01T03:00:00.000Z"),
      category: "schedule",
      action: "updated",
      correlationIds: { runId: "run-2", scheduleId: "sched-1", batchId: "batch-3" },
    });
    const entryD = makeEntry({
      entryId: "entry-d",
      timestamp: new Date("2026-06-01T04:00:00.000Z"),
      category: "batch",
      action: "completed",
      correlationIds: { runId: "run-3", scheduleId: "sched-3", batchId: "batch-1" },
    });
    const entryE = makeEntry({
      entryId: "entry-e",
      timestamp: new Date("2026-06-01T05:00:00.000Z"),
      category: "checkpoint",
      action: "saved",
      correlationIds: { runId: "run-2", scheduleId: "sched-4", batchId: "batch-4" },
    });

    for (const entry of [entryA, entryB, entryC, entryD, entryE]) {
      await repo.append(entry);
    }
    return { entryA, entryB, entryC, entryD, entryE };
  }

  it("retorna todos os registros ordenados por Timestamp ASC, EntryId ASC quando não há filtros", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    const all = await repo.list();

    expect(all).toEqual([
      seeded.entryA,
      seeded.entryB,
      seeded.entryC,
      seeded.entryD,
      seeded.entryE,
    ]);
    expect(await repo.list({})).toHaveLength(5);
  });

  it("filtra por category", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    expect(await repo.list({ category: "schedule" })).toEqual([seeded.entryA, seeded.entryC]);
    expect(await repo.list({ category: "run" })).toEqual([seeded.entryB]);
    expect(await repo.list({ category: "nonexistent" })).toEqual([]);
  });

  it("filtra por action", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    expect(await repo.list({ action: "created" })).toEqual([seeded.entryA]);
    expect(await repo.list({ action: "completed" })).toEqual([seeded.entryD]);
  });

  it("filtra por runId", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    expect(await repo.list({ runId: "run-1" })).toEqual([seeded.entryA, seeded.entryB]);
    expect(await repo.list({ runId: "run-2" })).toEqual([seeded.entryC, seeded.entryE]);
  });

  it("filtra por scheduleId", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    expect(await repo.list({ scheduleId: "sched-1" })).toEqual([seeded.entryA, seeded.entryC]);
    expect(await repo.list({ scheduleId: "sched-3" })).toEqual([seeded.entryD]);
  });

  it("filtra por batchId", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    expect(await repo.list({ batchId: "batch-1" })).toEqual([seeded.entryA, seeded.entryD]);
    expect(await repo.list({ batchId: "batch-2" })).toEqual([seeded.entryB]);
  });

  it("filtra por intervalo de tempo (since/until)", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    expect(
      await repo.list({
        since: new Date("2026-06-01T02:00:00.000Z"),
        until: new Date("2026-06-01T04:00:00.000Z"),
      }),
    ).toEqual([seeded.entryB, seeded.entryC, seeded.entryD]);
  });

  it("combina múltiplos filtros", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    expect(await repo.list({ category: "schedule", runId: "run-1" })).toEqual([seeded.entryA]);
    expect(
      await repo.list({ category: "schedule", action: "updated", scheduleId: "sched-1" }),
    ).toEqual([seeded.entryC]);
  });

  it("trata string vazia como 'sem filtro' (sentinel-free)", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    const all = await repo.list({
      category: "",
      action: "",
      runId: "",
      scheduleId: "",
      batchId: "",
    });

    expect(all).toEqual([
      seeded.entryA,
      seeded.entryB,
      seeded.entryC,
      seeded.entryD,
      seeded.entryE,
    ]);
  });

  it("aplica limit client-side após ordenação determinística", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    const first3 = await repo.list({ limit: 3 });
    expect(first3).toHaveLength(3);
    expect(first3[0]).toEqual(seeded.entryA);
    expect(first3[1]).toEqual(seeded.entryB);
    expect(first3[2]).toEqual(seeded.entryC);
  });

  it("limit negativo retorna todos (sem slice)", async () => {
    const { repo } = newRepo();
    await seedStandardSet(repo);

    const all = await repo.list({ limit: -1 });
    expect(all).toHaveLength(5);
  });
});

// ─── AC-34 — listByCorrelation ───────────────────────────────────────────────

describe("SqlAuditRepository — listByCorrelation (AC-34)", () => {
  it("retorna array vazio quando nenhum ID de correlação é fornecido", async () => {
    const { repo } = newRepo();
    await repo.append(makeEntry({ correlationIds: { runId: "run-1" } }));

    const result = await repo.listByCorrelation({});

    expect(result).toEqual([]);
  });

  it("retorna entradas que correspondem a um único ID de correlação", async () => {
    const { repo } = newRepo();
    const entry1 = makeEntry({
      entryId: "entry-1",
      timestamp: new Date("2026-06-01T01:00:00.000Z"),
      correlationIds: { runId: "run-x", scheduleId: "sched-x" },
    });
    const entry2 = makeEntry({
      entryId: "entry-2",
      timestamp: new Date("2026-06-01T02:00:00.000Z"),
      correlationIds: { runId: "run-y", scheduleId: "sched-y" },
    });
    await repo.append(entry1);
    await repo.append(entry2);

    const result = await repo.listByCorrelation({ runId: "run-x" });

    expect(result).toEqual([entry1]);
  });

  it("retorna entradas que correspondem a qualquer um dos múltiplos IDs (OR)", async () => {
    const { repo } = newRepo();
    const entry1 = makeEntry({
      entryId: "entry-1",
      timestamp: new Date("2026-06-01T01:00:00.000Z"),
      correlationIds: { runId: "run-1", scheduleId: "sched-1" },
    });
    const entry2 = makeEntry({
      entryId: "entry-2",
      timestamp: new Date("2026-06-01T02:00:00.000Z"),
      correlationIds: { runId: "run-2", scheduleId: "sched-2" },
    });
    const entry3 = makeEntry({
      entryId: "entry-3",
      timestamp: new Date("2026-06-01T03:00:00.000Z"),
      correlationIds: { batchId: "batch-1" },
    });
    await repo.append(entry1);
    await repo.append(entry2);
    await repo.append(entry3);

    // Deve retornar entry1 (runId match) e entry3 (batchId match)
    const result = await repo.listByCorrelation({
      runId: "run-1",
      batchId: "batch-1",
    });

    expect(result).toEqual([entry1, entry3]);
  });

  it("retorna array vazio quando nenhum registro corresponde", async () => {
    const { repo } = newRepo();
    await repo.append(makeEntry({ correlationIds: { runId: "run-1" } }));

    const result = await repo.listByCorrelation({ runId: "run-nonexistent" });

    expect(result).toEqual([]);
  });
});

// ─── AC-34 — listByTimeRange ─────────────────────────────────────────────────

describe("SqlAuditRepository — listByTimeRange (AC-34)", () => {
  it("retorna entradas dentro do intervalo com limites inclusivos", async () => {
    const { repo } = newRepo();
    const entry1 = makeEntry({
      entryId: "entry-1",
      timestamp: new Date("2026-06-01T01:00:00.000Z"),
    });
    const entry2 = makeEntry({
      entryId: "entry-2",
      timestamp: new Date("2026-06-01T02:00:00.000Z"),
    });
    const entry3 = makeEntry({
      entryId: "entry-3",
      timestamp: new Date("2026-06-01T03:00:00.000Z"),
    });
    const entry4 = makeEntry({
      entryId: "entry-4",
      timestamp: new Date("2026-06-01T04:00:00.000Z"),
    });
    for (const entry of [entry1, entry2, entry3, entry4]) {
      await repo.append(entry);
    }

    const result = await repo.listByTimeRange({
      from: new Date("2026-06-01T02:00:00.000Z"),
      to: new Date("2026-06-01T03:00:00.000Z"),
    });

    // Limites inclusivos: entry2 e entry3
    expect(result).toEqual([entry2, entry3]);
  });

  it("retorna array vazio quando não há entradas no intervalo", async () => {
    const { repo } = newRepo();
    await repo.append(makeEntry({ timestamp: new Date("2026-06-01T01:00:00.000Z") }));

    const result = await repo.listByTimeRange({
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-02T00:00:00.000Z"),
    });

    expect(result).toEqual([]);
  });
});

// ─── AC-34 — listByCategory ──────────────────────────────────────────────────

describe("SqlAuditRepository — listByCategory (AC-34)", () => {
  it("retorna entradas de uma categoria específica", async () => {
    const { repo } = newRepo();
    const entry1 = makeEntry({
      entryId: "entry-1",
      timestamp: new Date("2026-06-01T01:00:00.000Z"),
      category: "schedule",
    });
    const entry2 = makeEntry({
      entryId: "entry-2",
      timestamp: new Date("2026-06-01T02:00:00.000Z"),
      category: "run",
    });
    const entry3 = makeEntry({
      entryId: "entry-3",
      timestamp: new Date("2026-06-01T03:00:00.000Z"),
      category: "schedule",
    });
    for (const entry of [entry1, entry2, entry3]) {
      await repo.append(entry);
    }

    const result = await repo.listByCategory("schedule");

    expect(result).toEqual([entry1, entry3]);
  });

  it("retorna array vazio quando a categoria não existe", async () => {
    const { repo } = newRepo();
    await repo.append(makeEntry({ category: "schedule" }));

    const result = await repo.listByCategory("nonexistent");

    expect(result).toEqual([]);
  });
});

// ─── AC-35 — MetadataJson inválido → CorruptedRecordError ───────────────────

describe("SqlAuditRepository — defesa em profundidade (AC-35)", () => {
  it("lança CorruptedRecordError quando MetadataJson não é JSON válido no read", async () => {
    const { executor, repo } = newRepo();

    // Injeta linha corrompida diretamente no executor
    executor.entries.set("entry-corrupt-1", {
      EntryId: "entry-corrupt-1",
      Timestamp: new Date("2026-06-01T01:00:00.000Z"),
      Category: "schedule",
      Action: "created",
      Actor: "system",
      RunId: null,
      ScheduleId: null,
      BatchId: null,
      PreviousState: null,
      NewState: null,
      MetadataJson: "{not-json",
    });

    await expect(repo.list()).rejects.toBeInstanceOf(CorruptedRecordError);
  });

  it("lança CorruptedRecordError quando MetadataJson não é texto", async () => {
    const { executor, repo } = newRepo();

    executor.entries.set("entry-corrupt-2", {
      EntryId: "entry-corrupt-2",
      Timestamp: new Date("2026-06-01T01:00:00.000Z"),
      Category: "schedule",
      Action: "created",
      Actor: "system",
      RunId: null,
      ScheduleId: null,
      BatchId: null,
      PreviousState: null,
      NewState: null,
      MetadataJson: 42,
    });

    await expect(repo.list()).rejects.toBeInstanceOf(CorruptedRecordError);
  });

  it("lança CorruptedRecordError quando Timestamp não é Date", async () => {
    const { executor, repo } = newRepo();

    executor.entries.set("entry-corrupt-3", {
      EntryId: "entry-corrupt-3",
      Timestamp: "2026-06-01T01:00:00.000Z",
      Category: "schedule",
      Action: "created",
      Actor: "system",
      RunId: null,
      ScheduleId: null,
      BatchId: null,
      PreviousState: null,
      NewState: null,
      MetadataJson: null,
    });

    await expect(repo.list()).rejects.toBeInstanceOf(CorruptedRecordError);
  });

  it("append com MetadataJson nulo é armazenado como null (sem erro)", async () => {
    const { executor, repo } = newRepo();
    const entry = makeEntry({ metadata: undefined });

    const result = await repo.append(entry);

    expect(result.metadata).toBeUndefined();

    const row = executor.entries.get(entry.entryId);
    expect(row?.["MetadataJson"]).toBeNull();
  });
});
