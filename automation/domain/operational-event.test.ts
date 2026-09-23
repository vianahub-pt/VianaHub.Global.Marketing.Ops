import { describe, expect, it } from "vitest";
import {
  createEventId,
  createOperationalEvent,
  operationalEventSchema,
  EVENT_LEVELS,
  EVENT_CATEGORIES,
} from "./operational-event.js";

describe("operationalEventSchema", () => {
  // --- AC-17: valid event with all required fields ---
  it("accepts valid event with all required fields", () => {
    const event = {
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-21T10:00:00.000Z"),
      level: "info" as const,
      category: "run" as const,
      name: "run.queued",
      message: "Run queued successfully",
      correlationIds: { runId: "run-123" },
    };
    const result = operationalEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  // --- AC-17: valid event with optional metadata ---
  it("accepts valid event with optional metadata", () => {
    const event = {
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-21T10:00:00.000Z"),
      level: "info" as const,
      category: "run" as const,
      name: "run.queued",
      message: "Run queued successfully",
      correlationIds: { runId: "run-123" },
      metadata: { source: "api", retries: 3 },
    };
    const result = operationalEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  // --- AC-17: reject event without eventId ---
  it("rejects event without eventId", () => {
    const event = {
      timestamp: new Date("2026-09-21T10:00:00.000Z"),
      level: "info" as const,
      category: "run" as const,
      name: "run.queued",
      message: "Run queued successfully",
      correlationIds: {},
    };
    const result = operationalEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  // --- AC-17: reject event with invalid level ---
  it("rejects event with invalid level", () => {
    const event = {
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-21T10:00:00.000Z"),
      level: "critical",
      category: "run" as const,
      name: "run.queued",
      message: "Run queued successfully",
      correlationIds: {},
    };
    const result = operationalEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  // --- AC-17: reject event with invalid category ---
  it("rejects event with invalid category", () => {
    const event = {
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-21T10:00:00.000Z"),
      level: "info" as const,
      category: "invalid",
      name: "run.queued",
      message: "Run queued successfully",
      correlationIds: {},
    };
    const result = operationalEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  // --- AC-20: reject metadata with 'token' field ---
  it("rejects metadata with field 'token'", () => {
    const event = {
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-21T10:00:00.000Z"),
      level: "info" as const,
      category: "run" as const,
      name: "run.queued",
      message: "Run queued successfully",
      correlationIds: {},
      metadata: { token: "secret-value" },
    };
    const result = operationalEventSchema.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("token");
    }
  });

  // --- AC-20: reject metadata with 'secret' field ---
  it("rejects metadata with field 'secret'", () => {
    const event = {
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-21T10:00:00.000Z"),
      level: "info" as const,
      category: "run" as const,
      name: "run.queued",
      message: "Run queued successfully",
      correlationIds: {},
      metadata: { secret: "my-secret" },
    };
    const result = operationalEventSchema.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("secret");
    }
  });

  // --- AC-20: reject metadata with 'api_key' field ---
  it("rejects metadata with field 'api_key'", () => {
    const event = {
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-21T10:00:00.000Z"),
      level: "info" as const,
      category: "run" as const,
      name: "run.queued",
      message: "Run queued successfully",
      correlationIds: {},
      metadata: { api_key: "sk_live_abc123def456" },
    };
    const result = operationalEventSchema.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("api_key");
    }
  });

  // --- AC-20: reject metadata with 'authorization' field ---
  it("rejects metadata with field 'authorization'", () => {
    const event = {
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-21T10:00:00.000Z"),
      level: "info" as const,
      category: "run" as const,
      name: "run.queued",
      message: "Run queued successfully",
      correlationIds: {},
      metadata: {
        authorization:
          "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      },
    };
    const result = operationalEventSchema.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("authorization");
    }
  });

  // --- AC-20: reject metadata with JWT value ---
  it("rejects metadata with JWT value", () => {
    const event = {
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-21T10:00:00.000Z"),
      level: "info" as const,
      category: "run" as const,
      name: "run.queued",
      message: "Run queued successfully",
      correlationIds: {},
      metadata: {
        payload:
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      },
    };
    const result = operationalEventSchema.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("Sensitive value");
    }
  });

  // --- AC-20: reject metadata with Bearer value ---
  it("rejects metadata with Bearer value", () => {
    const event = {
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-21T10:00:00.000Z"),
      level: "info" as const,
      category: "run" as const,
      name: "run.queued",
      message: "Run queued successfully",
      correlationIds: {},
      metadata: { authHeader: "Bearer abc123xyz789" },
    };
    const result = operationalEventSchema.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("Sensitive value");
    }
  });

  // --- AC-20: reject metadata with PEM value ---
  it("rejects metadata with PEM value", () => {
    const event = {
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-21T10:00:00.000Z"),
      level: "info" as const,
      category: "run" as const,
      name: "run.queued",
      message: "Run queued successfully",
      correlationIds: {},
      metadata: { cert: "-----BEGIN RSA PRIVATE KEY-----\nMIIE..." },
    };
    const result = operationalEventSchema.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("Sensitive value");
    }
  });

  // --- AC-20: reject metadata with cookie value ---
  it("rejects metadata with cookie value", () => {
    const event = {
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-21T10:00:00.000Z"),
      level: "info" as const,
      category: "run" as const,
      name: "run.queued",
      message: "Run queued successfully",
      correlationIds: {},
      metadata: { headers: "session=abc123; token=xyz789" },
    };
    const result = operationalEventSchema.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("Sensitive value");
    }
  });

  // --- AC-20: reject secrets in nested metadata ---
  it("rejects secrets in nested metadata", () => {
    const event = {
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-21T10:00:00.000Z"),
      level: "info" as const,
      category: "run" as const,
      name: "run.queued",
      message: "Run queued successfully",
      correlationIds: {},
      metadata: {
        level1: {
          level2: {
            api_key: "sk_live_abc123def456",
          },
        },
      },
    };
    const result = operationalEventSchema.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("api_key");
      expect(result.error.issues[0].message).toContain("level1.level2");
    }
  });

  // --- AC-20: accept metadata with non-sensitive fields ---
  it("accepts metadata with non-sensitive fields", () => {
    const event = {
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: new Date("2026-09-21T10:00:00.000Z"),
      level: "info" as const,
      category: "run" as const,
      name: "run.queued",
      message: "Run queued successfully",
      correlationIds: {},
      metadata: {
        source: "api",
        retries: 3,
        tags: ["production", "critical"],
        nested: { valid: true },
      },
    };
    const result = operationalEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });
});

describe("createOperationalEvent", () => {
  // --- AC-17: factory creates event with deterministic timestamp via Clock ---
  it("creates event with deterministic timestamp via Clock", () => {
    const fixedDate = new Date("2026-09-21T12:00:00.000Z");
    const clock = { now: () => fixedDate };

    const event = createOperationalEvent({
      level: "info",
      category: "run",
      name: "run.queued",
      message: "Test event",
      correlationIds: { runId: "run-456" },
      clock,
    });

    expect(event.timestamp).toEqual(fixedDate);
    expect(event.level).toBe("info");
    expect(event.category).toBe("run");
    expect(event.name).toBe("run.queued");
    expect(event.message).toBe("Test event");
    expect(event.correlationIds).toEqual({ runId: "run-456" });
  });

  // --- AC-17: factory generates unique eventId ---
  it("generates unique eventId", () => {
    const event1 = createOperationalEvent({
      level: "info",
      category: "run",
      name: "run.queued",
      message: "Event 1",
      correlationIds: {},
    });

    const event2 = createOperationalEvent({
      level: "warn",
      category: "system",
      name: "system.startup",
      message: "Event 2",
      correlationIds: {},
    });

    expect(event1.eventId).not.toBe(event2.eventId);
    // Verify eventId format (UUID v4)
    expect(event1.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe("createEventId", () => {
  it("returns a branded EventId", () => {
    const id = createEventId();
    expect(typeof id).toBe("string");
    // Verify UUID v4 format
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

describe("EVENT_LEVELS and EVENT_CATEGORIES", () => {
  it("defines all expected event levels", () => {
    expect(EVENT_LEVELS).toEqual(["info", "warn", "error"]);
  });

  it("defines all expected event categories", () => {
    expect(EVENT_CATEGORIES).toEqual(["run", "schedule", "batch", "recovery", "system"]);
  });
});
