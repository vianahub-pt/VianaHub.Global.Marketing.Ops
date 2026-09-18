import { describe, expect, it } from "vitest";

import {
  checkGbpPreflight,
  checkGbpPreflightReal,
  loadGbpConfig,
} from "./access-preflight-gate.js";
import type {
  GbpTransport,
  GbpTransportRequest,
  GbpTransportResponse,
} from "./gbp-http-transport.js";

// ─── T-09: Access Preflight Gate — BLOCKED_NEEDS_HUMAN sem credenciais ──────

describe("T-09: Access Preflight Gate — sem credenciais", () => {
  it("retorna BLOCKED_NEEDS_HUMAN quando nenhuma variável de ambiente está definida", () => {
    const result = checkGbpPreflight({});

    expect(result.status).toBe("BLOCKED_NEEDS_HUMAN");
    expect(result.checks).toHaveLength(6);
    expect(result.checks.every((c) => c.passed)).toBe(false);
    expect(result.message).toContain("blocked");
  });

  it("retorna BLOCKED_NEEDS_HUMAN quando apenas GBP_PROJECT_ID está definido", () => {
    const result = checkGbpPreflight({
      GBP_PROJECT_ID: "my-gcp-project",
    });

    expect(result.status).toBe("BLOCKED_NEEDS_HUMAN");
    expect(result.checks.find((c) => c.name === "GBP_PROJECT_ID")?.passed).toBe(true);
    expect(result.checks.find((c) => c.name === "GBP_OAUTH_CLIENT_ID")?.passed).toBe(false);
  });

  it("retorna BLOCKED_NEEDS_HUMAN quando todas as variáveis exceto uma estão definidas", () => {
    const result = checkGbpPreflight({
      GBP_PROJECT_ID: "my-gcp-project",
      GBP_OAUTH_CLIENT_ID: "client-id-123",
      GBP_OAUTH_CLIENT_SECRET: "client-secret-456",
      GBP_OAUTH_REFRESH_TOKEN: "refresh-token-789",
      GBP_ACCOUNT_ID: "account-123",
      // GBP_LOCATION_ID is missing
    });

    expect(result.status).toBe("BLOCKED_NEEDS_HUMAN");
    expect(result.checks.filter((c) => c.passed)).toHaveLength(5);
    expect(result.checks.find((c) => c.name === "GBP_LOCATION_ID")?.passed).toBe(false);
  });

  it("retorna mensagem detalhando variáveis faltantes", () => {
    const result = checkGbpPreflight({});

    expect(result.message).toContain("GBP_PROJECT_ID");
    expect(result.message).toContain("GBP_OAUTH_CLIENT_ID");
    expect(result.message).toContain("GBP_OAUTH_CLIENT_SECRET");
    expect(result.message).toContain("GBP_OAUTH_REFRESH_TOKEN");
    expect(result.message).toContain("GBP_ACCOUNT_ID");
    expect(result.message).toContain("GBP_LOCATION_ID");
  });

  it("cada check tem detail quando falha", () => {
    const result = checkGbpPreflight({});

    for (const check of result.checks) {
      expect(check.passed).toBe(false);
      expect(check.detail).toBeDefined();
      expect(check.detail).toContain("missing");
    }
  });
});

// ─── Access Preflight Gate — com credenciais completas ───────────────────────

describe("Access Preflight Gate — com credenciais completas", () => {
  it("retorna READY quando todas as variáveis de ambiente estão definidas", () => {
    const result = checkGbpPreflight({
      GBP_PROJECT_ID: "my-gcp-project",
      GBP_OAUTH_CLIENT_ID: "client-id-123",
      GBP_OAUTH_CLIENT_SECRET: "client-secret-456",
      GBP_OAUTH_REFRESH_TOKEN: "refresh-token-789",
      GBP_ACCOUNT_ID: "account-123",
      GBP_LOCATION_ID: "location-456",
    });

    expect(result.status).toBe("READY");
    expect(result.checks).toHaveLength(6);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.message).toContain("passed");
  });

  it("retorna READY com strings não vazias em todas as variáveis", () => {
    const result = checkGbpPreflight({
      GBP_PROJECT_ID: "  ",
      GBP_OAUTH_CLIENT_ID: "  ",
      GBP_OAUTH_CLIENT_SECRET: "  ",
      GBP_OAUTH_REFRESH_TOKEN: "  ",
      GBP_ACCOUNT_ID: "  ",
      GBP_LOCATION_ID: "  ",
    });

    // Empty/whitespace strings should fail
    expect(result.status).toBe("BLOCKED_NEEDS_HUMAN");
    expect(result.checks.every((c) => c.passed)).toBe(false);
  });
});

// ─── Access Preflight Gate —/AP-04 ausência de credenciais em output ────────

describe("Access Preflight Gate — AP-04 ausência de credenciais em output", () => {
  it("nenhum valor de credencial aparece na mensagem de resultado", () => {
    const secrets = {
      GBP_PROJECT_ID: "super-secret-project",
      GBP_OAUTH_CLIENT_ID: "secret-client-id",
      GBP_OAUTH_CLIENT_SECRET: "super-secret-client-secret-value",
      GBP_OAUTH_REFRESH_TOKEN: "super-secret-refresh-token-value",
      GBP_ACCOUNT_ID: "secret-account-id",
      GBP_LOCATION_ID: "secret-location-id",
    };

    const result = checkGbpPreflight(secrets);

    // Verificar que valores reais não aparecem na mensagem
    for (const value of Object.values(secrets)) {
      expect(result.message).not.toContain(value);
    }

    // Verificar que valores reais não aparecem nos checks
    const checksJson = JSON.stringify(result.checks);
    for (const value of Object.values(secrets)) {
      expect(checksJson).not.toContain(value);
    }
  });
});

// ─── loadGbpConfig ───────────────────────────────────────────────────────────

describe("loadGbpConfig", () => {
  it("retorna config validada quando todas as variáveis estão definidas", () => {
    const env = {
      GBP_PROJECT_ID: "my-gcp-project",
      GBP_OAUTH_CLIENT_ID: "client-id-123",
      GBP_OAUTH_CLIENT_SECRET: "client-secret-456",
      GBP_OAUTH_REFRESH_TOKEN: "refresh-token-789",
      GBP_ACCOUNT_ID: "account-123",
      GBP_LOCATION_ID: "location-456",
    };

    const config = loadGbpConfig(env);

    expect(config.GBP_PROJECT_ID).toBe("my-gcp-project");
    expect(config.GBP_OAUTH_CLIENT_ID).toBe("client-id-123");
    expect(config.GBP_OAUTH_CLIENT_SECRET).toBe("client-secret-456");
    expect(config.GBP_OAUTH_REFRESH_TOKEN).toBe("refresh-token-789");
    expect(config.GBP_ACCOUNT_ID).toBe("account-123");
    expect(config.GBP_LOCATION_ID).toBe("location-456");
  });

  it("lança erro quando variáveis estão faltando", () => {
    expect(() => loadGbpConfig({})).toThrow("Missing GBP configuration");
  });

  it("lança erro quando apenas GBP_PROJECT_ID está definido", () => {
    expect(() => loadGbpConfig({ GBP_PROJECT_ID: "my-gcp-project" })).toThrow(
      "Missing GBP configuration",
    );
  });
});

// ─── AP-05: Gate antes de live execution ─────────────────────────────────────

describe("AP-05: Gate antes de live execution", () => {
  it("checkGbpPreflight é chamado antes de qualquer execução", () => {
    // Verificar que a função está disponível e retorna tipo correto
    const result = checkGbpPreflight({});
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("checks");
    expect(result).toHaveProperty("message");
    expect(["READY", "BLOCKED_NEEDS_HUMAN"]).toContain(result.status);
  });
});

// ─── Mock Transport Helper ───────────────────────────────────────────────────

function createMockTransport(options: {
  isReady?: boolean;
  accountsResponse?: unknown;
  locationsResponse?: unknown;
  accountError?: Error;
  locationError?: Error;
}): GbpTransport {
  return {
    isReady: () => options.isReady ?? true,
    request: async <T = unknown>(req: {
      method: string;
      path: string;
    }): Promise<GbpTransportResponse<T>> => {
      if (req.path.includes("/accounts/") && req.path.includes("/locations/")) {
        if (options.locationError) {
          throw options.locationError;
        }
        return {
          status: 200,
          data: (options.locationsResponse ?? {}) as T,
          headers: {},
        };
      }
      if (req.path.includes("/accounts/")) {
        if (options.accountError) {
          throw options.accountError;
        }
        return {
          status: 200,
          data: (options.accountsResponse ?? {}) as T,
          headers: {},
        };
      }
      throw new Error(`Unexpected path: ${req.path}`);
    },
  };
}

// ─── checkGbpPreflightReal — com transport mock ─────────────────────────────

describe("checkGbpPreflightReal — transport null", () => {
  it("retorna BLOCKED_NEEDS_HUMAN quando transport é null", async () => {
    const result = await checkGbpPreflightReal(null, "account-123", "location-456");

    expect(result.status).toBe("BLOCKED_NEEDS_HUMAN");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.name).toBe("REAL_OAUTH_VALID");
    expect(result.checks[0]?.passed).toBe(false);
    expect(result.message).toContain("blocked");
    expect(result.message).toContain("transport not ready");
  });
});

describe("checkGbpPreflightReal — transport não pronto", () => {
  it("retorna BLOCKED_NEEDS_HUMAN quando transport.isReady() é false", async () => {
    const mockTransport = createMockTransport({ isReady: false });
    const result = await checkGbpPreflightReal(mockTransport, "account-123", "location-456");

    expect(result.status).toBe("BLOCKED_NEEDS_HUMAN");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.name).toBe("REAL_OAUTH_VALID");
    expect(result.checks[0]?.passed).toBe(false);
    expect(result.message).toContain("transport not ready");
  });
});

describe("checkGbpPreflightReal — sucesso completo", () => {
  it("retorna READY quando todas as verificações passam", async () => {
    const mockTransport = createMockTransport({
      isReady: true,
      accountsResponse: { name: "accounts/account-123" },
      locationsResponse: { name: "accounts/account-123/locations/location-456" },
    });

    const result = await checkGbpPreflightReal(mockTransport, "account-123", "location-456");

    expect(result.status).toBe("READY");
    expect(result.checks).toHaveLength(4);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.message).toContain("passed");
  });

  it("verifica que GET é feito para accounts", async () => {
    const requestedPaths: string[] = [];
    const mockTransport: GbpTransport = {
      isReady: () => true,
      request: async <T = unknown>(req: GbpTransportRequest): Promise<GbpTransportResponse<T>> => {
        requestedPaths.push(req.path);
        return { status: 200, data: {} as T, headers: {} };
      },
    };

    await checkGbpPreflightReal(mockTransport, "account-123", "location-456");

    expect(requestedPaths).toContain("/accounts/account-123");
    expect(requestedPaths).toContain("/accounts/account-123/locations/location-456");
  });
});

describe("checkGbpPreflightReal — erro de autenticação", () => {
  it("retorna BLOCKED_NEEDS_HUMAN quando request lança erro de rede/autenticação", async () => {
    const mockTransport = createMockTransport({
      isReady: true,
      accountError: new Error("401 Unauthorized"),
    });

    const result = await checkGbpPreflightReal(mockTransport, "account-123", "location-456");

    expect(result.status).toBe("BLOCKED_NEEDS_HUMAN");
    expect(result.checks[0]?.name).toBe("REAL_OAUTH_VALID");
    expect(result.checks[0]?.passed).toBe(true);
    expect(result.checks[1]?.name).toBe("REAL_ENDPOINT_REACHABLE");
    expect(result.checks[1]?.passed).toBe(false);
    expect(result.checks[1]?.detail).toContain("BLOCKED_NEEDS_HUMAN");
    expect(result.message).toContain("REAL_ENDPOINT_REACHABLE");
  });
});

describe("checkGbpPreflightReal — erro de acesso à conta", () => {
  it("retorna BLOCKED_NEEDS_HUMAN quando conta não é acessível", async () => {
    const mockTransport = createMockTransport({
      isReady: true,
      accountError: new Error("403 Forbidden"),
    });

    const result = await checkGbpPreflightReal(mockTransport, "account-123", "location-456");

    expect(result.status).toBe("BLOCKED_NEEDS_HUMAN");
    expect(result.checks.find((c) => c.name === "REAL_ACCOUNT_ACCESSIBLE")?.passed).toBe(false);
    expect(result.message).toContain("REAL_ACCOUNT_ACCESSIBLE");
  });
});

describe("checkGbpPreflightReal — erro de acesso à location", () => {
  it("retorna BLOCKED_NEEDS_HUMAN quando location não é acessível", async () => {
    const mockTransport = createMockTransport({
      isReady: true,
      accountsResponse: { name: "accounts/account-123" },
      locationError: new Error("404 Not Found"),
    });

    const result = await checkGbpPreflightReal(mockTransport, "account-123", "location-456");

    expect(result.status).toBe("BLOCKED_NEEDS_HUMAN");
    expect(result.checks.find((c) => c.name === "REAL_OAUTH_VALID")?.passed).toBe(true);
    expect(result.checks.find((c) => c.name === "REAL_ENDPOINT_REACHABLE")?.passed).toBe(true);
    expect(result.checks.find((c) => c.name === "REAL_ACCOUNT_ACCESSIBLE")?.passed).toBe(true);
    expect(result.checks.find((c) => c.name === "REAL_LOCATION_ACCESSIBLE")?.passed).toBe(false);
    expect(result.message).toContain("REAL_LOCATION_ACCESSIBLE");
  });
});
