/**
 * Unit tests for SqlScheduleRepository (Sprint 5 — I-3b, AC-27, AC-28,
 * AC-29, D-11).
 *
 * The adapter is exercised against a deterministic in-memory `SqlExecutor`
 * declared in this file: the shared fake-sql-executor.ts only models
 * dbo.Runs and dbo.Checkpoints, so it cannot dispatch the dbo.Schedules
 * statements. No live SQL Server is ever contacted (AC-49).
 *
 * Coverage:
 * - AC-27: every `ScheduleRecord` field round-trips through
 *   create/getById; corrupted rows raise `CorruptedRecordError`
 *   (FR-07 parity with FileScheduleRepository).
 * - D-12 (REV-30): the single frozen `Enabled` column cannot represent a
 *   divergent `config.enabled`/`enabled` pair (which the FS backend
 *   preserves), so the adapter rejects such records up front instead of
 *   collapsing them — the AC-27 round-trip asserts the invariant on both
 *   `enabled` values and covers the rejected divergent case explicitly.
 * - AC-28: `update` guards on `record.revision`, returns `revision + 1`,
 *   increments the stored `Revision` and distinguishes
 *   `ConcurrencyConflictError` from "record not found" through the
 *   revision probe.
 * - AC-29: `list` honours brandId/market/platform filters, treats an empty
 *   string as "no filter" (sentinel-free `(@x = N'' OR col = @x)`
 *   predicates) and filters on the real BIT `enabled` parameter (true and
 *   false).
 * - D-11: `IdempotencyKey` is intentionally NOT unique;
 *   `findByIdempotencyKey` returns the lowest ScheduleId deterministically
 *   when duplicates exist.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ScheduleConfig, ScheduleId, ScheduleRecord } from "../../domain/schedule-schema.js";
import { ConcurrencyConflictError, CorruptedRecordError } from "../persistence-errors.js";
import {
  INSERT_SCHEDULE_SQL,
  SELECT_SCHEDULE_BY_IDEMPOTENCY_SQL,
  SELECT_SCHEDULE_BY_ID_SQL,
  SELECT_SCHEDULES_SQL,
  SELECT_SCHEDULE_REVISION_SQL,
  SqlScheduleRepository,
  UPDATE_SCHEDULE_GUARDED_SQL,
} from "./sql-schedule-repo.js";
import type { SqlExecutor } from "./sql-pool.js";

// ─── Stored row shape (dbo.Schedules) ────────────────────────────────────────

type StoredScheduleRow = Record<string, unknown>;

/** Column order of every SELECT exported by sql-schedule-repo.ts. */
const SCHEDULE_COLUMNS = [
  "ScheduleId",
  "SchemaVersion",
  "IdempotencyKey",
  "Cron",
  "Timezone",
  "BrandId",
  "Market",
  "Platform",
  "Operation",
  "Mode",
  "Enabled",
  "CreatedAt",
  "UpdatedAt",
  "LastRunAt",
  "NextRunAt",
  "Revision",
  "MetadataJson",
] as const;

const PK_SCHEDULES_MESSAGE =
  "Violation of PRIMARY KEY constraint 'PK_Schedules'. Cannot insert duplicate key in object 'dbo.Schedules'.";

function projectRow(row: StoredScheduleRow): unknown[] {
  return SCHEDULE_COLUMNS.map((column) => row[column]);
}

function byScheduleIdAscending(a: StoredScheduleRow, b: StoredScheduleRow): number {
  const left = String(a["ScheduleId"]);
  const right = String(b["ScheduleId"]);
  return left < right ? -1 : left > right ? 1 : 0;
}

// ─── In-memory executor for dbo.Schedules ────────────────────────────────────

interface FakeScheduleExecutor extends SqlExecutor {
  /** Direct read/seed access for assertions and corruption seeds. */
  readonly schedules: Map<string, StoredScheduleRow>;
}

/**
 * Dispatches the exact statements exported by sql-schedule-repo.ts,
 * mirroring the SQL Server semantics the repository relies on:
 * guarded UPDATE with `Revision + 1`, `TOP (1) ... ORDER BY ScheduleId ASC`,
 * sentinel-free string filters and the BIT `enabled` filter.
 */
function createFakeScheduleExecutor(): FakeScheduleExecutor {
  const schedules = new Map<string, StoredScheduleRow>();

  const executor: FakeScheduleExecutor = {
    schedules,

    async query(text, params) {
      const bound = params ?? {};

      if (text === INSERT_SCHEDULE_SQL) {
        const scheduleId = bound["scheduleId"] as string;
        if (schedules.has(scheduleId)) {
          throw new Error(PK_SCHEDULES_MESSAGE);
        }
        schedules.set(scheduleId, {
          ScheduleId: scheduleId,
          SchemaVersion: bound["schemaVersion"],
          IdempotencyKey: bound["idempotencyKey"],
          Cron: bound["cron"],
          Timezone: bound["timezone"],
          BrandId: bound["brandId"],
          Market: bound["market"],
          Platform: bound["platform"],
          Operation: bound["operation"],
          Mode: bound["mode"],
          Enabled: bound["enabled"],
          CreatedAt: bound["createdAt"],
          UpdatedAt: bound["updatedAt"],
          LastRunAt: bound["lastRunAt"],
          NextRunAt: bound["nextRunAt"],
          Revision: bound["revision"],
          MetadataJson: bound["metadataJson"],
        });
        return { columns: [], rows: [] };
      }

      if (text === SELECT_SCHEDULE_BY_ID_SQL) {
        const row = schedules.get(bound["scheduleId"] as string);
        if (row === undefined) {
          return { columns: SCHEDULE_COLUMNS, rows: [] };
        }
        return { columns: SCHEDULE_COLUMNS, rows: [projectRow(row)] };
      }

      if (text === SELECT_SCHEDULE_BY_IDEMPOTENCY_SQL) {
        const key = bound["idempotencyKey"] as string;
        const matches = [...schedules.values()]
          .filter((row) => row["IdempotencyKey"] === key)
          .sort(byScheduleIdAscending);
        const first = matches[0];
        if (first === undefined) {
          return { columns: SCHEDULE_COLUMNS, rows: [] };
        }
        return { columns: SCHEDULE_COLUMNS, rows: [projectRow(first)] };
      }

      if (text === SELECT_SCHEDULES_SQL) {
        const brandId = bound["brandId"] as string;
        const market = bound["market"] as string;
        const platform = bound["platform"] as string;
        const enabledFilter = bound["enabledFilter"] as string;
        const enabled = bound["enabled"] as boolean;
        const rows = [...schedules.values()]
          .filter(
            (row) =>
              (brandId === "" || row["BrandId"] === brandId) &&
              (market === "" || row["Market"] === market) &&
              (platform === "" || row["Platform"] === platform) &&
              (enabledFilter === "" || row["Enabled"] === enabled),
          )
          .sort(byScheduleIdAscending);
        return { columns: SCHEDULE_COLUMNS, rows: rows.map(projectRow) };
      }

      if (text === UPDATE_SCHEDULE_GUARDED_SQL) {
        const scheduleId = bound["scheduleId"] as string;
        const row = schedules.get(scheduleId);
        if (row === undefined || row["Revision"] !== bound["expectedRevision"]) {
          return { columns: [], rows: [] };
        }
        const nextRevision = (row["Revision"] as number) + 1;
        schedules.set(scheduleId, {
          ...row,
          SchemaVersion: bound["schemaVersion"],
          IdempotencyKey: bound["idempotencyKey"],
          Cron: bound["cron"],
          Timezone: bound["timezone"],
          BrandId: bound["brandId"],
          Market: bound["market"],
          Platform: bound["platform"],
          Operation: bound["operation"],
          Mode: bound["mode"],
          Enabled: bound["enabled"],
          CreatedAt: bound["createdAt"],
          UpdatedAt: bound["updatedAt"],
          LastRunAt: bound["lastRunAt"],
          NextRunAt: bound["nextRunAt"],
          MetadataJson: bound["metadataJson"],
          Revision: nextRevision,
        });
        return { columns: ["Revision"], rows: [[nextRevision]] };
      }

      if (text === SELECT_SCHEDULE_REVISION_SQL) {
        const row = schedules.get(bound["scheduleId"] as string);
        if (row === undefined) {
          return { columns: ["Revision"], rows: [] };
        }
        return { columns: ["Revision"], rows: [[row["Revision"]]] };
      }

      throw new Error(
        `Statement not supported by the schedule test executor: ${text.slice(0, 160)}`,
      );
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

let nextScheduleSequence = 0;

function makeConfig(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    cron: "0 3 * * *",
    timezone: "Europe/Lisbon",
    brandId: "best-fluency",
    market: "PT",
    platform: "google_business_profile",
    operation: "sync_listings",
    enabled: true,
    mode: "single",
    ...overrides,
  };
}

/**
 * Builds a valid `ScheduleRecord`. `enabled` and `config.enabled` are kept
 * in sync (as `createScheduleRecord` does), so every fixture satisfies the
 * D-12 invariant and round-trips. Divergent fixtures are assembled
 * explicitly in the invariant tests below — never through this helper —
 * so the round-trip tests can never pass by silently collapsing the pair.
 */
function makeSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  nextScheduleSequence += 1;
  const merged: ScheduleRecord = {
    schemaVersion: 1,
    scheduleId: `sched-${nextScheduleSequence}` as ScheduleId,
    idempotencyKey: `schedule:key-${nextScheduleSequence}`,
    config: makeConfig(),
    createdAt: new Date("2026-05-01T03:00:00.000Z"),
    updatedAt: new Date("2026-05-01T04:00:00.000Z"),
    enabled: true,
    revision: 0,
    ...overrides,
  };
  if (overrides.enabled !== undefined) {
    merged.config = { ...merged.config, enabled: overrides.enabled };
  } else if (overrides.config !== undefined) {
    merged.enabled = merged.config.enabled;
  }
  return merged;
}

/** Positional `dbo.Schedules` row for a record (corruption seeds). */
function toRow(record: ScheduleRecord): StoredScheduleRow {
  return {
    ScheduleId: record.scheduleId,
    SchemaVersion: record.schemaVersion,
    IdempotencyKey: record.idempotencyKey,
    Cron: record.config.cron,
    Timezone: record.config.timezone,
    BrandId: record.config.brandId,
    Market: record.config.market,
    Platform: record.config.platform,
    Operation: record.config.operation,
    Mode: record.config.mode,
    Enabled: record.enabled,
    CreatedAt: record.createdAt,
    UpdatedAt: record.updatedAt,
    LastRunAt: record.lastRunAt ?? null,
    NextRunAt: record.nextRunAt ?? null,
    Revision: record.revision,
    MetadataJson:
      record.config.metadata === undefined ? null : JSON.stringify(record.config.metadata),
  };
}

function seedRow(
  executor: FakeScheduleExecutor,
  record: ScheduleRecord,
  overrides: StoredScheduleRow = {},
): void {
  executor.schedules.set(record.scheduleId, { ...toRow(record), ...overrides });
}

function newRepo() {
  const executor = createFakeScheduleExecutor();
  return { executor, repo: new SqlScheduleRepository(executor) };
}

// ─── AC-27 — create / getById round-trip ─────────────────────────────────────

describe("SqlScheduleRepository — create e getById (AC-27)", () => {
  it("faz round-trip de um registro mínimo sem campos opcionais", async () => {
    const { executor, repo } = newRepo();
    const record = makeSchedule();

    await expect(repo.create(record)).resolves.toEqual(record);
    const fetched = await repo.getById(record.scheduleId as ScheduleId);

    expect(fetched).toEqual(record);
    expect(fetched?.lastRunAt).toBeUndefined();
    expect(fetched?.nextRunAt).toBeUndefined();
    expect(fetched?.config.metadata).toBeUndefined();

    const row = executor.schedules.get(record.scheduleId);
    expect(row?.["LastRunAt"]).toBeNull();
    expect(row?.["NextRunAt"]).toBeNull();
    expect(row?.["MetadataJson"]).toBeNull();
  });

  it("faz round-trip de um registro completo com datas opcionais e metadata", async () => {
    const { executor, repo } = newRepo();
    const record = makeSchedule({
      config: makeConfig({
        cron: "@daily",
        mode: "batch",
        enabled: false,
        metadata: { owner: "ops", tags: ["daily", "pt"] },
      }),
      enabled: false,
      lastRunAt: new Date("2026-05-02T03:00:00.000Z"),
      nextRunAt: new Date("2026-05-03T03:00:00.000Z"),
      revision: 4,
    });

    await expect(repo.create(record)).resolves.toEqual(record);
    const fetched = await repo.getById(record.scheduleId as ScheduleId);

    expect(fetched).toEqual(record);
    expect(fetched?.lastRunAt).toBeInstanceOf(Date);
    expect(fetched?.nextRunAt).toBeInstanceOf(Date);
    expect(fetched?.enabled).toBe(false);
    expect(fetched?.config.enabled).toBe(false);
    expect(fetched?.config.mode).toBe("batch");
    expect(fetched?.config.metadata).toEqual({ owner: "ops", tags: ["daily", "pt"] });

    // Metadata is persisted as JSON text, never as an object.
    expect(executor.schedules.get(record.scheduleId)?.["MetadataJson"]).toBe(
      JSON.stringify({ owner: "ops", tags: ["daily", "pt"] }),
    );
  });

  it("mantém a invariante config.enabled === enabled em round-trips de ambos os valores (D-12)", async () => {
    const { repo } = newRepo();
    const enabled = makeSchedule();
    const disabled = makeSchedule({ enabled: false });

    // O round-trip de AC-27 só é completo se a coluna única `Enabled`
    // reconstruir OS DOIS campos — cobre true e false explicitamente para
    // que o teste não seja falso positivo sobre o colapso (REV-30).
    for (const record of [enabled, disabled]) {
      await repo.create(record);
      const fetched = await repo.getById(record.scheduleId as ScheduleId);

      expect(fetched).toEqual(record);
      expect(fetched?.enabled).toBe(record.enabled);
      expect(fetched?.config.enabled).toBe(record.enabled);
      expect(fetched?.config.enabled).toBe(fetched?.enabled);
    }
  });

  it("rejeita create com config.enabled divergente de enabled em vez de colapsar Enabled (D-12)", async () => {
    const { executor, repo } = newRepo();
    const base = makeSchedule();
    const divergent: ScheduleRecord = {
      ...base,
      enabled: false,
      config: { ...base.config, enabled: true },
    };

    await expect(repo.create(divergent)).rejects.toThrow(
      `Enabled invariant violated for schedule ${base.scheduleId}`,
    );
    // Fail-fast antes do statement: nada chega ao executor.
    expect(executor.schedules.size).toBe(0);
    await expect(repo.getById(base.scheduleId as ScheduleId)).resolves.toBeNull();
  });

  it("rejeita update com config.enabled divergente sem alterar a linha armazenada (D-12)", async () => {
    const { executor, repo } = newRepo();
    const created = await repo.create(makeSchedule());
    const divergent: ScheduleRecord = {
      ...created,
      enabled: true,
      config: { ...created.config, enabled: false },
    };

    await expect(repo.update(divergent)).rejects.toThrow(
      `Enabled invariant violated for schedule ${created.scheduleId}`,
    );
    expect(executor.schedules.get(created.scheduleId)?.["Revision"]).toBe(0);
    expect(executor.schedules.get(created.scheduleId)?.["Enabled"]).toBe(true);
    await expect(repo.getById(created.scheduleId as ScheduleId)).resolves.toEqual(created);
  });

  it("retorna null para um scheduleId desconhecido", async () => {
    const { repo } = newRepo();
    await expect(repo.getById("sched-missing" as ScheduleId)).resolves.toBeNull();
  });

  it("rejeita scheduleId duplicado com a mensagem de paridade do file adapter", async () => {
    const { repo } = newRepo();
    const record = makeSchedule();
    await repo.create(record);

    await expect(repo.create({ ...record })).rejects.toThrow(
      `Record already exists: ${record.scheduleId}`,
    );
  });

  it("propaga o erro original do executor quando a sonda de duplicata falha", async () => {
    const { executor, repo } = newRepo();
    const conflicting = makeSchedule({ scheduleId: "sched-corrupt-pk" as ScheduleId });
    seedRow(executor, conflicting, { MetadataJson: "{not-json" });

    await expect(repo.create(conflicting)).rejects.toThrow(/PK_Schedules/);
  });
});

// ─── AC-28 — update com concorrência otimista ────────────────────────────────

describe("SqlScheduleRepository — update (AC-28)", () => {
  it("aplica o update com a revision correta e devolve revision + 1", async () => {
    const { repo } = newRepo();
    const created = await repo.create(makeSchedule());
    const next: ScheduleRecord = {
      ...created,
      config: { ...created.config, cron: "0 4 * * *" },
      updatedAt: new Date("2026-05-01T05:00:00.000Z"),
    };

    const result = await repo.update(next);

    expect(result).toEqual({ ...next, revision: created.revision + 1 });
    expect(result.revision).toBe(1);
  });

  it("incrementa Revision armazenado e o getById reflete o novo estado", async () => {
    const { executor, repo } = newRepo();
    const created = await repo.create(makeSchedule());
    const next: ScheduleRecord = {
      ...created,
      enabled: false,
      config: { ...created.config, enabled: false },
    };

    const result = await repo.update(next);

    expect(executor.schedules.get(created.scheduleId)?.["Revision"]).toBe(1);
    expect(executor.schedules.get(created.scheduleId)?.["Enabled"]).toBe(false);
    await expect(repo.getById(created.scheduleId as ScheduleId)).resolves.toEqual(result);
  });

  it("lança ConcurrencyConflictError com a revision esperada e a atual", async () => {
    const { repo } = newRepo();
    const created = await repo.create(makeSchedule());
    const stale: ScheduleRecord = { ...created, revision: 99 };

    let caught: unknown;
    try {
      await repo.update(stale);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConcurrencyConflictError);
    const conflict = caught as ConcurrencyConflictError;
    expect(conflict.recordId).toBe(created.scheduleId);
    expect(conflict.expectedRevision).toBe(99);
    expect(conflict.actualRevision).toBe(0);
  });

  it("não altera a linha armazenada após o conflito de concorrência", async () => {
    const { executor, repo } = newRepo();
    const created = await repo.create(makeSchedule());

    await expect(
      repo.update({ ...created, config: { ...created.config, cron: "0 9 * * *" }, revision: 7 }),
    ).rejects.toBeInstanceOf(ConcurrencyConflictError);

    expect(executor.schedules.get(created.scheduleId)?.["Revision"]).toBe(0);
    expect(executor.schedules.get(created.scheduleId)?.["Cron"]).toBe(created.config.cron);
    await expect(repo.getById(created.scheduleId as ScheduleId)).resolves.toEqual(created);
  });

  it("detecta gravação perdida quando o mesmo registro é reenviado após um update", async () => {
    const { repo } = newRepo();
    const created = await repo.create(makeSchedule());
    const next: ScheduleRecord = { ...created, updatedAt: new Date("2026-05-01T06:00:00.000Z") };

    const first = await repo.update(next);
    expect(first.revision).toBe(1);

    let caught: unknown;
    try {
      await repo.update(next);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConcurrencyConflictError);
    const conflict = caught as ConcurrencyConflictError;
    expect(conflict.expectedRevision).toBe(0);
    expect(conflict.actualRevision).toBe(1);
  });

  it("lança Record not found quando o scheduleId não existe", async () => {
    const { repo } = newRepo();
    const missing = makeSchedule({ scheduleId: "sched-absent" as ScheduleId });

    await expect(repo.update(missing)).rejects.toThrow(/^Record not found: sched-absent$/);
  });
});

// ─── AC-29 — filtros de list ─────────────────────────────────────────────────

describe("SqlScheduleRepository — list (AC-29)", () => {
  async function seedStandardSet(repo: SqlScheduleRepository) {
    const schedA = makeSchedule({ scheduleId: "sched-a" as ScheduleId });
    const schedB = makeSchedule({ scheduleId: "sched-b" as ScheduleId, enabled: false });
    const schedC = makeSchedule({
      scheduleId: "sched-c" as ScheduleId,
      config: makeConfig({ brandId: "gerit" }),
    });
    const schedD = makeSchedule({
      scheduleId: "sched-d" as ScheduleId,
      config: makeConfig({ market: "ES" }),
    });
    const schedE = makeSchedule({
      scheduleId: "sched-e" as ScheduleId,
      config: makeConfig({ platform: "gbp_other" }),
    });
    for (const record of [schedA, schedB, schedC, schedD, schedE]) {
      await repo.create(record);
    }
    return { schedA, schedB, schedC, schedD, schedE };
  }

  it("retorna todos os registros ordenados por ScheduleId quando não há filtros", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    const all = await repo.list();

    expect(all).toEqual([
      seeded.schedA,
      seeded.schedB,
      seeded.schedC,
      seeded.schedD,
      seeded.schedE,
    ]);
    expect(await repo.list({})).toHaveLength(5);
  });

  it("filtra por brandId, market e platform, isolada e combinadamente", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    expect(await repo.list({ brandId: "gerit" })).toEqual([seeded.schedC]);
    expect(await repo.list({ market: "ES" })).toEqual([seeded.schedD]);
    expect(await repo.list({ platform: "gbp_other" })).toEqual([seeded.schedE]);
    expect(await repo.list({ brandId: "best-fluency", market: "PT" })).toEqual([
      seeded.schedA,
      seeded.schedB,
      seeded.schedE,
    ]);
    expect(
      await repo.list({
        brandId: "best-fluency",
        market: "PT",
        platform: "google_business_profile",
      }),
    ).toEqual([seeded.schedA, seeded.schedB]);
    expect(await repo.list({ market: "FR" })).toEqual([]);
  });

  it("filtra enabled=true retornando apenas registros habilitados", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    expect(await repo.list({ enabled: true })).toEqual([
      seeded.schedA,
      seeded.schedC,
      seeded.schedD,
      seeded.schedE,
    ]);
  });

  it("filtra enabled=false retornando apenas registros desabilitados", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    expect(await repo.list({ enabled: false })).toEqual([seeded.schedB]);
  });

  it("combina o filtro enabled com filtros de string", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    expect(await repo.list({ brandId: "best-fluency", enabled: true })).toEqual([
      seeded.schedA,
      seeded.schedD,
      seeded.schedE,
    ]);
    expect(await repo.list({ brandId: "gerit", enabled: false })).toEqual([]);
  });

  it("trata string vazia como 'sem filtro', como nos predicados SQL", async () => {
    const { repo } = newRepo();
    const seeded = await seedStandardSet(repo);

    const all = await repo.list({ brandId: "", market: "", platform: "" });

    expect(all).toEqual([
      seeded.schedA,
      seeded.schedB,
      seeded.schedC,
      seeded.schedD,
      seeded.schedE,
    ]);
  });
});

// ─── D-11 — findByIdempotencyKey sem unicidade ───────────────────────────────

describe("SqlScheduleRepository — findByIdempotencyKey (D-11)", () => {
  it("não impõe unicidade: duas chaves de idempotência duplicadas coexistem", async () => {
    const { executor, repo } = newRepo();
    const first = makeSchedule({
      scheduleId: "sched-dup-2" as ScheduleId,
      idempotencyKey: "schedule:dup",
    });
    const second = makeSchedule({
      scheduleId: "sched-dup-1" as ScheduleId,
      idempotencyKey: "schedule:dup",
    });

    await repo.create(first);
    await repo.create(second);

    expect(executor.schedules.size).toBe(2);
    expect(executor.schedules.get(first.scheduleId)).toBeDefined();
    expect(executor.schedules.get(second.scheduleId)).toBeDefined();
  });

  it("retorna deterministicamente o menor ScheduleId quando há duplicatas", async () => {
    const { repo } = newRepo();
    const higher = makeSchedule({
      scheduleId: "sched-dup-2" as ScheduleId,
      idempotencyKey: "schedule:dup",
    });
    const lower = makeSchedule({
      scheduleId: "sched-dup-1" as ScheduleId,
      idempotencyKey: "schedule:dup",
    });

    // Ordem de inserção inversa à ordem de ScheduleId.
    await repo.create(higher);
    await repo.create(lower);

    const found = await repo.findByIdempotencyKey("schedule:dup");
    expect(found).toEqual(lower);

    // Determinístico entre chamadas repetidas.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = await repo.findByIdempotencyKey("schedule:dup");
      expect(again?.scheduleId).toBe("sched-dup-1");
    }
  });

  it("mantém o mesmo vencedor quando a ordem de inserção é invertida", async () => {
    const { repo: forwardRepo } = newRepo();
    const { repo: reverseRepo } = newRepo();
    const higher = makeSchedule({
      scheduleId: "sched-dup-2" as ScheduleId,
      idempotencyKey: "schedule:dup",
    });
    const lower = makeSchedule({
      scheduleId: "sched-dup-1" as ScheduleId,
      idempotencyKey: "schedule:dup",
    });

    await forwardRepo.create(higher);
    await forwardRepo.create(lower);
    await reverseRepo.create(lower);
    await reverseRepo.create(higher);

    const forward = await forwardRepo.findByIdempotencyKey("schedule:dup");
    const reverse = await reverseRepo.findByIdempotencyKey("schedule:dup");

    expect(forward?.scheduleId).toBe("sched-dup-1");
    expect(reverse?.scheduleId).toBe("sched-dup-1");
    expect(forward).toEqual(reverse);
  });

  it("encontra o registro exato para uma chave única", async () => {
    const { repo } = newRepo();
    const record = makeSchedule();
    await repo.create(record);

    await expect(repo.findByIdempotencyKey(record.idempotencyKey)).resolves.toEqual(record);
  });

  it("retorna null para uma chave desconhecida", async () => {
    const { repo } = newRepo();
    await expect(repo.findByIdempotencyKey("schedule:missing")).resolves.toBeNull();
  });
});

// ─── Linhas corrompidas (FR-07/FR-08 parity) ────────────────────────────────

describe("SqlScheduleRepository — armazenamento corrompido", () => {
  it("lança CorruptedRecordError quando MetadataJson não é JSON válido", async () => {
    const { executor, repo } = newRepo();
    seedRow(executor, makeSchedule({ scheduleId: "sched-corrupt-1" as ScheduleId }), {
      MetadataJson: "{not-json",
    });

    await expect(repo.getById("sched-corrupt-1" as ScheduleId)).rejects.toBeInstanceOf(
      CorruptedRecordError,
    );
  });

  it("lança CorruptedRecordError quando MetadataJson não é texto", async () => {
    const { executor, repo } = newRepo();
    seedRow(executor, makeSchedule({ scheduleId: "sched-corrupt-2" as ScheduleId }), {
      MetadataJson: 42,
    });

    await expect(repo.getById("sched-corrupt-2" as ScheduleId)).rejects.toBeInstanceOf(
      CorruptedRecordError,
    );
  });

  it("lança CorruptedRecordError quando uma coluna datetime não é Date", async () => {
    const { executor, repo } = newRepo();
    seedRow(executor, makeSchedule({ scheduleId: "sched-corrupt-3" as ScheduleId }), {
      CreatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(repo.getById("sched-corrupt-3" as ScheduleId)).rejects.toBeInstanceOf(
      CorruptedRecordError,
    );
  });

  it("lança CorruptedRecordError quando Mode viola o enum do domínio", async () => {
    const { executor, repo } = newRepo();
    seedRow(executor, makeSchedule({ scheduleId: "sched-corrupt-4" as ScheduleId }), {
      Mode: "bogus",
    });

    await expect(repo.getById("sched-corrupt-4" as ScheduleId)).rejects.toBeInstanceOf(
      CorruptedRecordError,
    );
  });

  it("propaga a corrupção durante list, como no file adapter", async () => {
    const { executor, repo } = newRepo();
    await repo.create(makeSchedule());
    seedRow(executor, makeSchedule({ scheduleId: "sched-corrupt-5" as ScheduleId }), {
      MetadataJson: "}",
    });

    await expect(repo.list()).rejects.toBeInstanceOf(CorruptedRecordError);
  });
});

// ─── Statements e DDL estáticos (AC-29, D-11) ───────────────────────────────

describe("SqlScheduleRepository — statements e DDL estáticos (AC-29, D-11)", () => {
  const migrationSql = readFileSync(
    fileURLToPath(new URL("../../../database/migrations/001_initial_schema.sql", import.meta.url)),
    "utf8",
  );

  it("usa predicados sem sentinela para os filtros de string (AC-29)", () => {
    expect(SELECT_SCHEDULES_SQL).toContain("(@brandId = N'' OR BrandId = @brandId)");
    expect(SELECT_SCHEDULES_SQL).toContain("(@market = N'' OR Market = @market)");
    expect(SELECT_SCHEDULES_SQL).toContain("(@platform = N'' OR Platform = @platform)");
  });

  it("filtra Enabled por parâmetro BIT real via @enabledFilter (AC-29)", () => {
    expect(SELECT_SCHEDULES_SQL).toContain("(@enabledFilter = N'' OR Enabled = @enabled)");
  });

  it("ordena a busca por idempotency key pelo menor ScheduleId (D-11)", () => {
    expect(SELECT_SCHEDULE_BY_IDEMPOTENCY_SQL).toContain("TOP (1)");
    expect(SELECT_SCHEDULE_BY_IDEMPOTENCY_SQL).toContain("ORDER BY ScheduleId ASC");
  });

  it("guarda o update pela revision esperada e incrementa a armazenada (AC-28)", () => {
    expect(UPDATE_SCHEDULE_GUARDED_SQL).toContain("Revision = Revision + 1");
    expect(UPDATE_SCHEDULE_GUARDED_SQL).toContain("Revision = @expectedRevision");
    expect(SELECT_SCHEDULE_REVISION_SQL).toContain("WHERE ScheduleId = @scheduleId");
  });

  it("não declara unicidade sobre IdempotencyKey em dbo.Schedules (D-11)", () => {
    expect(migrationSql).not.toContain("UQ_Schedules_IdempotencyKey");

    const table = migrationSql.match(/CREATE TABLE dbo\.Schedules \(([\s\S]*?)\n {2}\);/);
    expect(table).not.toBeNull();
    expect(table?.[1]).not.toMatch(/UNIQUE/i);
    expect(migrationSql).toContain("CONSTRAINT CK_Schedules_Revision CHECK (Revision >= 0)");
  });
});
