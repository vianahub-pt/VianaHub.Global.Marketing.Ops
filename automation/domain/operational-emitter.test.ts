import { describe, it, expect, vi } from "vitest";
import { createOperationalEmitter } from "./operational-emitter.js";
import type { OperationalEvent } from "./operational-event.js";
import { createOperationalEvent } from "./operational-event.js";

// Helper to create a minimal valid OperationalEvent
function makeEvent(name: string): OperationalEvent {
  return createOperationalEvent({
    level: "info",
    category: "system",
    name: "system.startup",
    message: `Test event: ${name}`,
    correlationIds: {},
  });
}

describe("createOperationalEmitter", () => {
  it("entrega evento para todos os subscribers", () => {
    const emitter = createOperationalEmitter();
    const event = makeEvent("test-1");
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    emitter.subscribe(handler1);
    emitter.subscribe(handler2);
    emitter.emit(event);

    expect(handler1).toHaveBeenCalledWith(event);
    expect(handler2).toHaveBeenCalledWith(event);
  });

  it("entrega eventos em ordem de registro", () => {
    const emitter = createOperationalEmitter();
    const order: number[] = [];

    emitter.subscribe(() => {
      order.push(1);
    });
    emitter.subscribe(() => {
      order.push(2);
    });
    emitter.subscribe(() => {
      order.push(3);
    });

    emitter.emit(makeEvent("order-test"));

    expect(order).toEqual([1, 2, 3]);
  });

  it("unsubscribe remove handler da entrega", () => {
    const emitter = createOperationalEmitter();
    const handler = vi.fn();

    const unsubscribe = emitter.subscribe(handler);
    unsubscribe();

    emitter.emit(makeEvent("after-unsub"));

    expect(handler).not.toHaveBeenCalled();
  });

  it("nao entrega eventos apos unsubscribe", () => {
    const emitter = createOperationalEmitter();
    const handler = vi.fn();

    const unsubscribe = emitter.subscribe(handler);

    emitter.emit(makeEvent("before-unsub"));
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();

    emitter.emit(makeEvent("after-unsub"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("captura erros do subscriber sem quebrar emissao", () => {
    const emitter = createOperationalEmitter();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    emitter.subscribe(() => {
      throw new Error("subscriber failure");
    });

    expect(() => emitter.emit(makeEvent("error-test"))).not.toThrow();

    stderrSpy.mockRestore();
  });

  it("continua entregando para subscribers restantes apos um falhar", () => {
    const emitter = createOperationalEmitter();
    const handler2 = vi.fn();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    emitter.subscribe(() => {
      throw new Error("first handler fails");
    });
    emitter.subscribe(handler2);

    const event = makeEvent("continue-test");
    emitter.emit(event);

    expect(handler2).toHaveBeenCalledWith(event);

    stderrSpy.mockRestore();
  });

  it("lida com zero subscribers graciosamente", () => {
    const emitter = createOperationalEmitter();

    expect(() => emitter.emit(makeEvent("no-subscribers"))).not.toThrow();
  });

  it("lida com multiplas chamadas de emit corretamente", () => {
    const emitter = createOperationalEmitter();
    const handler = vi.fn();

    emitter.subscribe(handler);

    const event1 = makeEvent("multi-1");
    const event2 = makeEvent("multi-2");
    const event3 = makeEvent("multi-3");

    emitter.emit(event1);
    emitter.emit(event2);
    emitter.emit(event3);

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenNthCalledWith(1, event1);
    expect(handler).toHaveBeenNthCalledWith(2, event2);
    expect(handler).toHaveBeenNthCalledWith(3, event3);
  });
});
