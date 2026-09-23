import { describe, it, expect } from "vitest";
import { parseCronExpression, nextExecutionTime, matchesCron } from "./cron-parser.js";
import { DeterministicClock } from "./clock.js";

describe("parseCronExpression", () => {
  it("*/15 * * * * → minutes = {0,15,30,45}, hours = 0-23", () => {
    const cron = parseCronExpression("*/15 * * * *");
    expect(cron.minutes).toEqual(new Set([0, 15, 30, 45]));
    expect(cron.hours.size).toBe(24);
    for (let h = 0; h < 24; h++) {
      expect(cron.hours.has(h)).toBe(true);
    }
  });

  it("0 9 * * 1-5 → hour = {9}, weekday = {1,2,3,4,5}", () => {
    const cron = parseCronExpression("0 9 * * 1-5");
    expect(cron.minutes).toEqual(new Set([0]));
    expect(cron.hours).toEqual(new Set([9]));
    expect(cron.daysOfWeek).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it("0 0 1 1 * → day=1, month=1, hour=0, min=0", () => {
    const cron = parseCronExpression("0 0 1 1 *");
    expect(cron.minutes).toEqual(new Set([0]));
    expect(cron.hours).toEqual(new Set([0]));
    expect(cron.daysOfMonth).toEqual(new Set([1]));
    expect(cron.months).toEqual(new Set([1]));
    expect(cron.daysOfWeek.size).toBe(7); // 0-6 (7 normalizado para 0)
  });

  it("5 4 * * 0 → weekday = {0} (domingo)", () => {
    const cron = parseCronExpression("5 4 * * 0");
    expect(cron.minutes).toEqual(new Set([5]));
    expect(cron.hours).toEqual(new Set([4]));
    expect(cron.daysOfWeek).toEqual(new Set([0]));
  });

  it("5 4 * * 7 → weekday = {0} (7 normalizado para 0)", () => {
    const cron = parseCronExpression("5 4 * * 7");
    expect(cron.daysOfWeek).toEqual(new Set([0]));
  });

  it("* * * * * → todos os minutos, todas as horas", () => {
    const cron = parseCronExpression("* * * * *");
    expect(cron.minutes.size).toBe(60);
    expect(cron.hours.size).toBe(24);
    expect(cron.daysOfMonth.size).toBe(31);
    expect(cron.months.size).toBe(12);
    expect(cron.daysOfWeek.size).toBe(7);
  });

  it("0,15,30 9-17 * * 1-5 → minutes={0,15,30}, hours=9..17", () => {
    const cron = parseCronExpression("0,15,30 9-17 * * 1-5");
    expect(cron.minutes).toEqual(new Set([0, 15, 30]));
    const expectedHours = new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(cron.hours).toEqual(expectedHours);
    expect(cron.daysOfWeek).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it("@daily expande para 0 0 * * *", () => {
    const cron = parseCronExpression("@daily");
    expect(cron.minutes).toEqual(new Set([0]));
    expect(cron.hours).toEqual(new Set([0]));
    expect(cron.daysOfMonth.size).toBe(31);
    expect(cron.months.size).toBe(12);
    expect(cron.daysOfWeek.size).toBe(7);
    expect(cron.raw).toBe("@daily");
  });

  it("@hourly expande para 0 * * * *", () => {
    const cron = parseCronExpression("@hourly");
    expect(cron.minutes.size).toBe(1);
    expect(cron.hours.size).toBe(24);
    expect(cron.raw).toBe("@hourly");
  });

  it("@weekly expande para 0 0 * * 0", () => {
    const cron = parseCronExpression("@weekly");
    expect(cron.minutes).toEqual(new Set([0]));
    expect(cron.hours).toEqual(new Set([0]));
    expect(cron.daysOfWeek).toEqual(new Set([0]));
    expect(cron.raw).toBe("@weekly");
  });

  it("@monthly expande para 0 0 1 * *", () => {
    const cron = parseCronExpression("@monthly");
    expect(cron.minutes).toEqual(new Set([0]));
    expect(cron.hours).toEqual(new Set([0]));
    expect(cron.daysOfMonth).toEqual(new Set([1]));
    expect(cron.raw).toBe("@monthly");
  });

  it("@yearly expande para 0 0 1 1 *", () => {
    const cron = parseCronExpression("@yearly");
    expect(cron.minutes).toEqual(new Set([0]));
    expect(cron.hours).toEqual(new Set([0]));
    expect(cron.daysOfMonth).toEqual(new Set([1]));
    expect(cron.months).toEqual(new Set([1]));
    expect(cron.raw).toBe("@yearly");
  });

  it("Campo com 6 valores → throws", () => {
    expect(() => parseCronExpression("0 9 * * * 1")).toThrow(
      "Cron expression must have exactly 5 fields, got 6",
    );
  });

  it("Campo com valor fora de range (60 em min) → throws", () => {
    expect(() => parseCronExpression("60 * * * *")).toThrow(
      "Value 60 out of bounds for minute (0-59)",
    );
  });

  it("Expressão 1-5/2 → minutes = {1,3,5}", () => {
    const cron = parseCronExpression("1-5/2 * * * *");
    expect(cron.minutes).toEqual(new Set([1, 3, 5]));
  });
});

describe("nextExecutionTime", () => {
  it("0 9 * * * → Retorna 09:00 UTC do mesmo dia (se from < 09:00)", () => {
    // from = 2026-09-20T08:00:00Z (antes das 09:00)
    const from = new Date("2026-09-20T08:00:00Z");
    const next = nextExecutionTime("0 9 * * *", from, "UTC");
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(9);
    expect(next!.getUTCMinutes()).toBe(0);
    expect(next!.getUTCDate()).toBe(20); // mesmo dia
    expect(next!.getUTCMonth()).toBe(8); // setembro (0-indexed)
  });

  it("0 9 * * * → Retorna 09:00 UTC do dia seguinte (se from > 09:00)", () => {
    // from = 2026-09-20T10:00:00Z (depois das 09:00)
    const from = new Date("2026-09-20T10:00:00Z");
    const next = nextExecutionTime("0 9 * * *", from, "UTC");
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(9);
    expect(next!.getUTCMinutes()).toBe(0);
    expect(next!.getUTCDate()).toBe(21); // dia seguinte
    expect(next!.getUTCMonth()).toBe(8); // setembro (0-indexed)
  });

  it("nextExecutionTime com DeterministicClock → Resultado determinístico", () => {
    const clock = new DeterministicClock(new Date("2026-09-20T08:00:00Z"));
    const next = nextExecutionTime("0 9 * * *", clock.now(), "UTC", clock);
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(9);
    expect(next!.getUTCMinutes()).toBe(0);
    expect(next!.getUTCDate()).toBe(20);
  });

  it("nextExecutionTime com timezone Europe/Lisbon → Respeita timezone (DST)", () => {
    // 29 março 2026 = horário de verão (UTC+1)
    const from = new Date("2026-03-29T08:00:00Z");
    const next = nextExecutionTime("0 0 * * *", from, "Europe/Lisbon");

    expect(next).toBeDefined();
    expect(next).not.toBeNull();
    // 00:00 Europe/Lisbon em horário de verão = 23:00 UTC do dia anterior
    expect(next!.toISOString()).toBe("2026-03-29T23:00:00.000Z");
  });

  it("nextExecutionTime aceita ParsedCron diretamente", () => {
    const cron = parseCronExpression("0 9 * * *");
    const from = new Date("2026-09-20T08:00:00Z");
    const next = nextExecutionTime(cron, from, "UTC");
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(9);
    expect(next!.getUTCMinutes()).toBe(0);
    expect(next!.getUTCDate()).toBe(20);
  });

  it("nextExecutionTime com timezone inválida → throws RangeError", () => {
    const from = new Date("2026-09-20T08:00:00Z");
    expect(() => nextExecutionTime("0 9 * * *", from, "Invalid/Timezone")).toThrow(RangeError);
  });
});

describe("matchesCron", () => {
  it("matchesCron positivo → Componentes exatos → true", () => {
    const cron = parseCronExpression("0 9 * * 1-5");
    // 2026-09-21T09:00:00Z = Monday
    const date = new Date("2026-09-21T09:00:00Z");
    expect(matchesCron(cron, date, "UTC")).toBe(true);
  });

  it("matchesCron negativo → Minuto errado → false", () => {
    const cron = parseCronExpression("0 9 * * 1-5");
    // 2026-09-21T09:01:00Z = Monday, minuto errado
    const date = new Date("2026-09-21T09:01:00Z");
    expect(matchesCron(cron, date, "UTC")).toBe(false);
  });
});

describe("Limite de busca", () => {
  it("Não entra em loop infinito com expressão impossível", () => {
    // Expressão que nunca vai coincidir: 31 de fevereiro
    const from = new Date("2026-01-01T00:00:00Z");
    const result = nextExecutionTime("0 0 31 2 *", from, "UTC");
    expect(result).toBeNull();
  });
});
