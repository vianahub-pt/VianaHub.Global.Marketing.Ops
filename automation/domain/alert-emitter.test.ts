import { describe, it, expect, vi } from "vitest";
import { createAlertEmitter } from "./alert-emitter.js";
import { createAlertEntry } from "./alert-schema.js";
import type { AlertEntry } from "./alert-schema.js";
import type { Clock } from "./clock.js";

// --- Helpers ---

function makeAlert(overrides?: Partial<AlertEntry>, clock?: Clock): AlertEntry {
  return createAlertEntry({
    severity: "warn",
    category: "system",
    message: "Test alert",
    correlationIds: {},
    clock,
    ...overrides,
  });
}

function makeClock(time: number): Clock {
  return { now: () => new Date(time) };
}

// --- Tests ---

describe("AlertEmitter", () => {
  it("entrega alerta para todos os subscribers", () => {
    const emitter = createAlertEmitter();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    emitter.subscribe(handler1);
    emitter.subscribe(handler2);

    const alert = makeAlert();
    emitter.emit(alert);

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler1).toHaveBeenCalledWith(alert);
    expect(handler2).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledWith(alert);
  });

  it("unsubscribe remove handler da entrega", () => {
    const emitter = createAlertEmitter();
    const handler = vi.fn();

    const unsubscribe = emitter.subscribe(handler);
    emitter.emit(makeAlert());
    expect(handler).toHaveBeenCalledOnce();

    unsubscribe();
    emitter.emit(makeAlert());
    expect(handler).toHaveBeenCalledOnce(); // still 1
  });

  it("captura erros do subscriber sem quebrar emissão", () => {
    const emitter = createAlertEmitter();
    const errorHandler = vi.fn(() => {
      throw new Error("subscriber error");
    });
    const goodHandler = vi.fn();

    emitter.subscribe(errorHandler);
    emitter.subscribe(goodHandler);

    const alert = makeAlert();
    emitter.emit(alert);

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(goodHandler).toHaveBeenCalledOnce();
    expect(goodHandler).toHaveBeenCalledWith(alert);
  });

  describe("Deduplicação", () => {
    it("segundo alerta com mesma key é suprimido", () => {
      const clock = makeClock(1000);
      const emitter = createAlertEmitter({}, clock);
      const handler = vi.fn();

      emitter.subscribe(handler);

      const alert1 = makeAlert({ deduplicationKey: "dup-key-1" }, clock);
      const result1 = emitter.emit(alert1);

      // Same time = within window
      const alert2 = makeAlert({ deduplicationKey: "dup-key-1" }, clock);
      const result2 = emitter.emit(alert2);

      // Handler should only be called once (first alert)
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(alert1);

      // Second result should reference first alert's id and timestamp
      expect(result2.alertId).toBe(result1.alertId);
      expect(result2.timestamp).toBe(result1.timestamp);
    });

    it("alerta suprimido incrementa suppressedCount", () => {
      const clock = makeClock(1000);
      const emitter = createAlertEmitter({}, clock);
      const handler = vi.fn();
      emitter.subscribe(handler);

      const alert1 = makeAlert({ deduplicationKey: "dup-key-2" }, clock);
      emitter.emit(alert1);

      const alert2 = makeAlert({ deduplicationKey: "dup-key-2" }, clock);
      const result2 = emitter.emit(alert2);
      expect(result2.suppressedCount).toBe(1);

      const alert3 = makeAlert({ deduplicationKey: "dup-key-2" }, clock);
      const result3 = emitter.emit(alert3);
      expect(result3.suppressedCount).toBe(2);
    });

    it("alerta sem deduplicationKey nunca é suprimido", () => {
      const clock = makeClock(1000);
      const emitter = createAlertEmitter({}, clock);
      const handler = vi.fn();
      emitter.subscribe(handler);

      emitter.emit(makeAlert());
      emitter.emit(makeAlert());
      emitter.emit(makeAlert());

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it("alerta após janela é entregue normalmente", () => {
      const clock = makeClock(1000);
      const emitter = createAlertEmitter({}, clock);
      const handler = vi.fn();
      emitter.subscribe(handler);

      const alert1 = makeAlert({ deduplicationKey: "dup-key-3" }, clock);
      emitter.emit(alert1);
      expect(handler).toHaveBeenCalledTimes(1);

      // Advance time beyond default 5-minute window (300000ms)
      clock.now = () => new Date(1000 + 300001);

      const alert2 = makeAlert({ deduplicationKey: "dup-key-3" }, clock);
      const result2 = emitter.emit(alert2);

      // Should be delivered again
      expect(handler).toHaveBeenCalledTimes(2);
      expect(result2.alertId).toBe(alert2.alertId); // new id
    });

    it("janela configurável via AlertEmitterConfig", () => {
      const clock = makeClock(1000);
      // 1-second window
      const emitter = createAlertEmitter({ deduplicationWindowMs: 1000 }, clock);
      const handler = vi.fn();
      emitter.subscribe(handler);

      const alert1 = makeAlert({ deduplicationKey: "dup-key-4" }, clock);
      emitter.emit(alert1);
      expect(handler).toHaveBeenCalledTimes(1);

      // Still within 1-second window
      clock.now = () => new Date(1500);
      emitter.emit(makeAlert({ deduplicationKey: "dup-key-4" }, clock));
      expect(handler).toHaveBeenCalledTimes(1); // suppressed

      // Beyond 1-second window
      clock.now = () => new Date(2001);
      emitter.emit(makeAlert({ deduplicationKey: "dup-key-4" }, clock));
      expect(handler).toHaveBeenCalledTimes(2); // delivered
    });

    it("usa Clock injetável para controle de janela", () => {
      let currentTime = 0;
      const clock: Clock = { now: () => new Date(currentTime) };
      const emitter = createAlertEmitter({}, clock);
      const handler = vi.fn();
      emitter.subscribe(handler);

      currentTime = 100;
      const alert1 = makeAlert({ deduplicationKey: "clock-test" }, clock);
      emitter.emit(alert1);
      expect(handler).toHaveBeenCalledTimes(1);

      currentTime = 200;
      emitter.emit(makeAlert({ deduplicationKey: "clock-test" }, clock));
      expect(handler).toHaveBeenCalledTimes(1); // suppressed

      // Advance 5 minutes + 1ms
      currentTime = 100 + 300001;
      emitter.emit(makeAlert({ deduplicationKey: "clock-test" }, clock));
      expect(handler).toHaveBeenCalledTimes(2); // delivered
    });
  });
});
