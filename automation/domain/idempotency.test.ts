import { describe, expect, it } from "vitest";
import { computeIdempotencyKey, createRunId, fingerprintPayload } from "./idempotency.js";

const identity = {
  brandId: "best-fluency",
  market: "PT",
  platform: "example",
  operation: "publish",
};

describe("identity and idempotency primitives", () => {
  it("creates unique UUID v4 RunIds", () => {
    const first = createRunId();
    const second = createRunId();

    expect(first).not.toBe(second);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("fingerprints objects canonically regardless of key order", () => {
    expect(fingerprintPayload({ b: 2, a: 1 })).toBe(fingerprintPayload({ a: 1, b: 2 }));
    expect(fingerprintPayload({ items: ["a", "b"] })).not.toBe(
      fingerprintPayload({ items: ["b", "a"] }),
    );
  });

  it("returns a lowercase hexadecimal SHA-256 fingerprint", () => {
    expect(fingerprintPayload({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives deterministic keys from logical identity and canonical payload", () => {
    const first = computeIdempotencyKey(identity, { title: "Hello", count: 1 });
    const sameRequest = computeIdempotencyKey(identity, { count: 1, title: "Hello" });
    const differentOperation = computeIdempotencyKey(
      { ...identity, operation: "update" },
      { title: "Hello", count: 1 },
    );

    expect(first).toBe(sameRequest);
    expect(first).not.toBe(differentOperation);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    { token: "opaque-token" },
    { password: "not-for-hashing" },
    { cookie: "session=abc" },
    { authorization: "Bearer abc.def.ghi" },
  ])("rejects sensitive fields before hashing", (payload) => {
    expect(() => fingerprintPayload(payload)).toThrow(/Sensitive/);
    expect(() => computeIdempotencyKey(identity, payload)).toThrow(/Sensitive/);
  });

  it("rejects sensitive token-like values even without a sensitive key", () => {
    expect(() =>
      fingerprintPayload({ value: "eyJhbGciOiJIUzI1NiJ9.payload.signature" }),
    ).toThrow(/Sensitive/);
  });

  it.each([
    new Date("2025-01-01T00:00:00.000Z"),
    new Map([["key", "value"]]),
    new Set(["value"]),
    /regular-expression/,
    Object.create({ inherited: true }),
  ])("rejects special objects instead of canonicalizing them as JSON objects", (payload) => {
    expect(() => fingerprintPayload(payload)).toThrow(/non-plain object|non-JSON property/);
  });

  it("rejects circular payloads", () => {
    const payload: Record<string, unknown> = {};
    payload.self = payload;

    expect(() => fingerprintPayload(payload)).toThrow(/circular reference/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite number %s",
    (value) => {
      expect(() => fingerprintPayload({ value })).toThrow(/non-finite number/);
    },
  );

  it.each([undefined, 1n, Symbol("value"), () => true])(
    "rejects non-JSON values (%s)",
    (value) => {
      expect(() => fingerprintPayload({ value })).toThrow(/unsupported value/);
    },
  );

  it("rejects symbol properties and accessors", () => {
    const symbolPayload = { value: "ok" } as Record<string | symbol, unknown>;
    symbolPayload[Symbol("hidden")] = "secret";
    expect(() => fingerprintPayload(symbolPayload)).toThrow(/non-JSON property/);

    const accessorPayload = {};
    Object.defineProperty(accessorPayload, "value", { get: () => "ok", enumerable: true });
    expect(() => fingerprintPayload(accessorPayload)).toThrow(/accessor property/);
  });

  it("rejects sensitive fields nested inside arrays and objects", () => {
    const payload = { outer: [{ safe: true, credentials: { apiKey: "secret" } }] };

    expect(() => fingerprintPayload(payload)).toThrow(/Sensitive/);
  });

  it("rejects sparse arrays rather than allowing canonical collisions", () => {
    const payload = [] as string[];
    payload.length = 1;

    expect(() => fingerprintPayload(payload)).toThrow(/sparse array/);
  });

  it.each([
    { ...identity, brandId: "" },
    { ...identity, market: "   " },
    { ...identity, platform: " platform" },
    { ...identity, operation: 42 },
    { ...identity, operation: "publish\nnow" },
  ])("rejects invalid logical identity fields", (invalidIdentity) => {
    expect(() =>
      computeIdempotencyKey(invalidIdentity as unknown as typeof identity, { ok: true }),
    ).toThrow(/Run identity/);
  });

  it("rejects identity objects with incompatible extra fields", () => {
    expect(() =>
      computeIdempotencyKey(
        { ...identity, extra: "not part of identity" } as unknown as typeof identity,
        { ok: true },
      ),
    ).toThrow(/exactly/);
  });
});
