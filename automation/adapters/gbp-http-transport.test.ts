/* eslint-disable no-undef -- Response is a Node.js 18+ global */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { GbpTransportConfig, GbpTransportRequest } from "./gbp-http-transport.js";
import { HttpGbpTransport, createGbpTransport } from "./gbp-http-transport.js";

// ─── Mock fetch ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const validConfig: GbpTransportConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  refreshToken: "test-refresh-token",
  baseUrl: "https://mybusiness.googleapis.com/v4",
};

const mockTokenResponse = {
  access_token: "test-access-token-123",
  token_type: "Bearer",
  expires_in: 3600,
};

function createMockResponse(
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
    headers: new Map(Object.entries(headers)),
  } as unknown as Response;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("HttpGbpTransport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("creates transport with valid config", () => {
      const transport = new HttpGbpTransport(validConfig);
      expect(transport).toBeDefined();
    });

    it("creates transport with default base URL", () => {
      const configWithoutBaseUrl = {
        clientId: validConfig.clientId,
        clientSecret: validConfig.clientSecret,
        refreshToken: validConfig.refreshToken,
      };

      const transport = new HttpGbpTransport(configWithoutBaseUrl);
      expect(transport).toBeDefined();
    });

    it("uses My Business API v4 as default base URL for Local Posts", async () => {
      const configWithoutBaseUrl = {
        clientId: validConfig.clientId,
        clientSecret: validConfig.clientSecret,
        refreshToken: validConfig.refreshToken,
      };

      mockFetch
        .mockResolvedValueOnce(createMockResponse(200, mockTokenResponse))
        .mockResolvedValueOnce(createMockResponse(200, { id: "123" }));

      const transport = new HttpGbpTransport(configWithoutBaseUrl);
      await transport.request({ method: "GET", path: "/accounts/acc1/locations/loc1/localPosts" });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://mybusiness.googleapis.com/v4/accounts/acc1/locations/loc1/localPosts",
        expect.anything(),
      );
    });
  });

  describe("isReady", () => {
    it("returns true when all credentials are present", () => {
      const transport = new HttpGbpTransport(validConfig);
      expect(transport.isReady()).toBe(true);
    });

    it("returns false when clientId is empty", () => {
      const config = { ...validConfig, clientId: "" };
      const transport = new HttpGbpTransport(config);
      expect(transport.isReady()).toBe(false);
    });

    it("returns false when clientSecret is empty", () => {
      const config = { ...validConfig, clientSecret: "" };
      const transport = new HttpGbpTransport(config);
      expect(transport.isReady()).toBe(false);
    });

    it("returns false when refreshToken is empty", () => {
      const config = { ...validConfig, refreshToken: "" };
      const transport = new HttpGbpTransport(config);
      expect(transport.isReady()).toBe(false);
    });
  });

  describe("request", () => {
    it("sends request with correct headers and body", async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(200, mockTokenResponse))
        .mockResolvedValueOnce(createMockResponse(200, { id: "123", name: "Test Post" }));

      const transport = new HttpGbpTransport(validConfig);
      const request: GbpTransportRequest = {
        method: "POST",
        path: "/localPosts",
        body: { summary: "Test post" },
      };

      const response = await transport.request(request);

      expect(response.status).toBe(200);
      expect(response.data).toEqual({ id: "123", name: "Test Post" });

      // Verify token fetch
      expect(mockFetch).toHaveBeenCalledWith(
        "https://oauth2.googleapis.com/token",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }),
      );

      // Verify actual request
      expect(mockFetch).toHaveBeenCalledWith(
        "https://mybusiness.googleapis.com/v4/localPosts",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-access-token-123",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ summary: "Test post" }),
        }),
      );
    });

    it("appends query parameters to URL", async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(200, mockTokenResponse))
        .mockResolvedValueOnce(createMockResponse(200, { items: [] }));

      const transport = new HttpGbpTransport(validConfig);
      const request: GbpTransportRequest = {
        method: "GET",
        path: "/localPosts",
        query: { pageSize: "10", pageToken: "next" },
      };

      await transport.request(request);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://mybusiness.googleapis.com/v4/localPosts?pageSize=10&pageToken=next",
        expect.anything(),
      );
    });

    it("reuses cached token on subsequent requests", async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(200, mockTokenResponse))
        .mockResolvedValueOnce(createMockResponse(200, { id: "1" }))
        .mockResolvedValueOnce(createMockResponse(200, { id: "2" }));

      const transport = new HttpGbpTransport(validConfig);

      await transport.request({ method: "GET", path: "/posts/1" });
      await transport.request({ method: "GET", path: "/posts/2" });

      // Total calls: 1 token fetch + 2 requests = 3
      expect(mockFetch).toHaveBeenCalledTimes(3);
      // Token should only be fetched once
      expect(mockFetch).toHaveBeenCalledWith(
        "https://oauth2.googleapis.com/token",
        expect.anything(),
      );
    });

    it("throws error on HTTP failure", async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(200, mockTokenResponse))
        .mockResolvedValueOnce(createMockResponse(403, { error: "Forbidden" }));

      const transport = new HttpGbpTransport(validConfig);

      await expect(transport.request({ method: "GET", path: "/posts" })).rejects.toThrow(
        "HTTP 403: Error",
      );
    });

    it("marks 5xx errors as retryable", async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(200, mockTokenResponse))
        .mockResolvedValueOnce(createMockResponse(500, { error: "Server Error" }));

      const transport = new HttpGbpTransport(validConfig);

      try {
        await transport.request({ method: "GET", path: "/posts" });
      } catch (error) {
        expect(error).toHaveProperty("retryable", true);
        expect(error).toHaveProperty("status", 500);
      }
    });

    it("marks 429 as retryable", async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(200, mockTokenResponse))
        .mockResolvedValueOnce(createMockResponse(429, { error: "Rate Limited" }));

      const transport = new HttpGbpTransport(validConfig);

      try {
        await transport.request({ method: "GET", path: "/posts" });
      } catch (error) {
        expect(error).toHaveProperty("retryable", true);
      }
    });

    it("marks 400 as not retryable", async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(200, mockTokenResponse))
        .mockResolvedValueOnce(createMockResponse(400, { error: "Bad Request" }));

      const transport = new HttpGbpTransport(validConfig);

      try {
        await transport.request({ method: "GET", path: "/posts" });
      } catch (error) {
        expect(error).toHaveProperty("retryable", false);
      }
    });

    it("handles network errors as retryable", async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(200, mockTokenResponse))
        .mockRejectedValueOnce(new Error("Network failure"));

      const transport = new HttpGbpTransport(validConfig);

      try {
        await transport.request({ method: "GET", path: "/posts" });
      } catch (error) {
        expect(error).toHaveProperty("retryable", true);
        expect(error).toHaveProperty("code", "NETWORK_ERROR");
      }
    });

    it("returns response headers", async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(200, mockTokenResponse))
        .mockResolvedValueOnce(createMockResponse(200, { id: "1" }, { "x-request-id": "req-123" }));

      const transport = new HttpGbpTransport(validConfig);
      const response = await transport.request({ method: "GET", path: "/posts/1" });

      expect(response.headers).toHaveProperty("x-request-id", "req-123");
    });
  });

  describe("OAuth token handling", () => {
    it("refreshes token when expired", async () => {
      const expiredTokenResponse = {
        ...mockTokenResponse,
        expires_in: 0,
      };

      mockFetch
        .mockResolvedValueOnce(createMockResponse(200, expiredTokenResponse))
        .mockResolvedValueOnce(createMockResponse(200, { id: "1" }))
        .mockResolvedValueOnce(createMockResponse(200, mockTokenResponse))
        .mockResolvedValueOnce(createMockResponse(200, { id: "2" }));

      const transport = new HttpGbpTransport(validConfig);

      await transport.request({ method: "GET", path: "/posts/1" });
      await transport.request({ method: "GET", path: "/posts/2" });

      // Total calls: 2 token fetches (initial + refresh) + 2 requests = 4
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("throws error on token fetch failure", async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(401, { error: "Unauthorized" }));

      const transport = new HttpGbpTransport(validConfig);

      await expect(transport.request({ method: "GET", path: "/posts" })).rejects.toThrow(
        "Failed to obtain access token",
      );
    });

    it("marks token errors as retryable on 5xx", async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(503, { error: "Service Unavailable" }));

      const transport = new HttpGbpTransport(validConfig);

      try {
        await transport.request({ method: "GET", path: "/posts" });
      } catch (error) {
        expect(error).toHaveProperty("retryable", true);
        expect(error).toHaveProperty("code", "TOKEN_ERROR");
      }
    });

    it("marks token errors as not retryable on 401", async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(401, { error: "Unauthorized" }));

      const transport = new HttpGbpTransport(validConfig);

      try {
        await transport.request({ method: "GET", path: "/posts" });
      } catch (error) {
        expect(error).toHaveProperty("retryable", false);
      }
    });
  });

  describe("path handling", () => {
    it("normalizes paths with leading slash", async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(200, mockTokenResponse))
        .mockResolvedValueOnce(createMockResponse(200, {}));

      const transport = new HttpGbpTransport(validConfig);
      await transport.request({ method: "GET", path: "/posts" });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://mybusiness.googleapis.com/v4/posts",
        expect.anything(),
      );
    });

    it("normalizes paths without leading slash", async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(200, mockTokenResponse))
        .mockResolvedValueOnce(createMockResponse(200, {}));

      const transport = new HttpGbpTransport(validConfig);
      await transport.request({ method: "GET", path: "posts" });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://mybusiness.googleapis.com/v4/posts",
        expect.anything(),
      );
    });
  });
});

describe("createGbpTransport", () => {
  it("creates transport from environment variables", () => {
    const env = {
      GBP_OAUTH_CLIENT_ID: "env-client-id",
      GBP_OAUTH_CLIENT_SECRET: "env-client-secret",
      GBP_OAUTH_REFRESH_TOKEN: "env-refresh-token",
    };

    const transport = createGbpTransport(env);
    expect(transport).toBeDefined();
    expect(transport.isReady()).toBe(true);
  });

  it("throws when required env vars are missing", () => {
    const env = {};

    expect(() => createGbpTransport(env)).toThrow("Missing GBP transport configuration");
  });

  it("creates transport with custom base URL", () => {
    const env = {
      GBP_OAUTH_CLIENT_ID: "env-client-id",
      GBP_OAUTH_CLIENT_SECRET: "env-client-secret",
      GBP_OAUTH_REFRESH_TOKEN: "env-refresh-token",
      GBP_API_BASE_URL: "https://mybusinessbusinessinformation.googleapis.com/v2",
    };

    const transport = createGbpTransport(env);
    expect(transport).toBeDefined();
  });
});

describe("SEC-002: baseUrl domain validation", () => {
  it("rejects non-Google domains in baseUrl", () => {
    const env = {
      GBP_OAUTH_CLIENT_ID: "env-client-id",
      GBP_OAUTH_CLIENT_SECRET: "env-client-secret",
      GBP_OAUTH_REFRESH_TOKEN: "env-refresh-token",
      GBP_API_BASE_URL: "https://evil.example.com/v1",
    };

    expect(() => createGbpTransport(env)).toThrow("Invalid baseUrl domain");
  });

  it("rejects IP addresses in baseUrl", () => {
    const env = {
      GBP_OAUTH_CLIENT_ID: "env-client-id",
      GBP_OAUTH_CLIENT_SECRET: "env-client-secret",
      GBP_OAUTH_REFRESH_TOKEN: "env-refresh-token",
      GBP_API_BASE_URL: "http://127.0.0.1:8080/v1",
    };

    expect(() => createGbpTransport(env)).toThrow();
  });

  it("allows googleapis.com domains", () => {
    const env = {
      GBP_OAUTH_CLIENT_ID: "env-client-id",
      GBP_OAUTH_CLIENT_SECRET: "env-client-secret",
      GBP_OAUTH_REFRESH_TOKEN: "env-refresh-token",
      GBP_API_BASE_URL: "https://mybusinessaccountmanagement.googleapis.com/v1",
    };

    expect(() => createGbpTransport(env)).not.toThrow();
  });

  it("rejects subdomain attacks on googleapis.com", () => {
    const env = {
      GBP_OAUTH_CLIENT_ID: "env-client-id",
      GBP_OAUTH_CLIENT_SECRET: "env-client-secret",
      GBP_OAUTH_REFRESH_TOKEN: "env-refresh-token",
      GBP_API_BASE_URL: "https://evil.googleapis.com.attacker.com/v1",
    };

    expect(() => createGbpTransport(env)).toThrow("Invalid baseUrl domain");
  });
});
