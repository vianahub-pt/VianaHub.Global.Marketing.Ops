/* eslint-disable no-undef -- fetch, Response, URLSearchParams are Node.js 18+ globals */
import { z } from "zod";

// ─── Transport Configuration ─────────────────────────────────────────────────

export interface GbpTransportConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly baseUrl?: string;
}

// ─── Transport Request/Response ──────────────────────────────────────────────

export interface GbpTransportRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly query?: Record<string, string>;
}

export interface GbpTransportResponse<T = unknown> {
  readonly status: number;
  readonly data: T;
  readonly headers: Record<string, string>;
}

// ─── Transport Error ─────────────────────────────────────────────────────────

export interface GbpTransportError {
  readonly message: string;
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
}

// ─── GbpTransport Interface ──────────────────────────────────────────────────

/**
 * Transport layer interface for Google Business Profile HTTP calls.
 *
 * This interface abstracts HTTP communication, allowing:
 * - Dependency injection for testability
 * - Mock implementations for unit testing
 * - OAuth 2.0 token management
 *
 * Security:
 * - Tokens are injected automatically, never exposed in method signatures
 * - All errors are transformed to GbpTransportError without leaking secrets
 */
export interface GbpTransport {
  /**
   * Executes an HTTP request to the GBP API.
   *
   * @param request - The request configuration
   * @returns Promise resolving to the response data
   * @throws GbpTransportError on failure
   */
  request<T = unknown>(request: GbpTransportRequest): Promise<GbpTransportResponse<T>>;

  /**
   * Checks if the transport is configured and ready.
   *
   * @returns true if valid credentials are available
   */
  isReady(): boolean;
}

// ─── Token Cache ─────────────────────────────────────────────────────────────

interface TokenCache {
  readonly accessToken: string;
  readonly expiresAt: number;
}

// ─── OAuth Token Response Schema ─────────────────────────────────────────────

const oauthTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
});

type OAuthTokenResponse = z.infer<typeof oauthTokenResponseSchema>;

// ─── HttpGbpTransport Implementation ─────────────────────────────────────────

/**
 * Default base URL for Google Business Profile Local Posts API.
 *
 * The `accounts.locations.localPosts.create` operation uses the
 * My Business API service at `mybusiness.googleapis.com/v4`.
 *
 * @see https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts/create
 */
const DEFAULT_BASE_URL = "https://mybusiness.googleapis.com/v4";

/**
 * HTTP transport implementation for Google Business Profile API.
 *
 * Handles:
 * - OAuth 2.0 token acquisition and caching
 * - Automatic token refresh
 * - Request execution with proper headers
 * - Error transformation and sanitization
 *
 * Security:
 * - SG-01: Credentials only in memory, never logged or serialized
 * - SG-02: All errors sanitized via GbpTransportError
 * - SG-03: Tokens never appear in method parameters or return values
 */
export class HttpGbpTransport implements GbpTransport {
  private config: GbpTransportConfig;
  private tokenCache: TokenCache | null = null;
  private baseUrl: string;

  /**
   * Allowed domains for baseUrl validation (SEC-002).
   * Only Google APIs domains are permitted to prevent SSRF attacks.
   */
  private static readonly ALLOWED_DOMAINS = [
    "googleapis.com",
    "mybusiness.googleapis.com",
    "mybusinessaccountmanagement.googleapis.com",
    "mybusinessbusinessinformation.googleapis.com",
    "mybusinessverifications.googleapis.com",
    "mybusinessnotifications.googleapis.com",
    "mybusinesslodging.googleapis.com",
    "mybusinesscalls.googleapis.com",
    "mybusinessqanda.googleapis.com",
  ];

  constructor(config: GbpTransportConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.validateBaseUrl(this.baseUrl);
  }

  /**
   * Validates that the baseUrl is from an allowed domain (SEC-002).
   * Prevents SSRF by restricting to Google APIs domains only.
   */
  private validateBaseUrl(url: string): void {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      const isAllowed = HttpGbpTransport.ALLOWED_DOMAINS.some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
      );

      if (!isAllowed) {
        throw new Error(
          `Invalid baseUrl domain: ${hostname}. Only Google APIs domains are allowed.`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Invalid baseUrl domain")) {
        throw error;
      }
      throw new Error(`Invalid baseUrl format: ${url}`);
    }
  }

  /**
   * Executes an HTTP request to the GBP API.
   */
  async request<T = unknown>(request: GbpTransportRequest): Promise<GbpTransportResponse<T>> {
    const accessToken = await this.getAccessToken();

    const url = this.buildUrl(request.path, request.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...request.headers,
    };

    try {
      const response = await fetch(url, {
        method: request.method,
        headers,
        body: request.body ? JSON.stringify(request.body) : undefined,
      });

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      if (!response.ok) {
        const _errorBody = await this.safeReadBody(response);
        throw this.createTransportError(
          `HTTP ${response.status}: ${response.statusText}`,
          "HTTP_ERROR",
          response.status,
          response.status >= 500 || response.status === 429,
        );
      }

      const data = (await response.json()) as T;

      return {
        status: response.status,
        data,
        headers: responseHeaders,
      };
    } catch (error) {
      if (this.isTransportError(error)) {
        throw error;
      }

      throw this.createTransportError(
        `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        "NETWORK_ERROR",
        undefined,
        true,
      );
    }
  }

  /**
   * Checks if the transport is configured and ready.
   */
  isReady(): boolean {
    return (
      typeof this.config.clientId === "string" &&
      this.config.clientId.length > 0 &&
      typeof this.config.clientSecret === "string" &&
      this.config.clientSecret.length > 0 &&
      typeof this.config.refreshToken === "string" &&
      this.config.refreshToken.length > 0
    );
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Gets a valid access token, refreshing if necessary.
   */
  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.accessToken;
    }

    const tokenResponse = await this.fetchAccessToken();
    this.tokenCache = {
      accessToken: tokenResponse.access_token,
      expiresAt: Date.now() + (tokenResponse.expires_in - 60) * 1000,
    };

    return this.tokenCache.accessToken;
  }

  /**
   * Fetches a new access token using the refresh token.
   */
  private async fetchAccessToken(): Promise<OAuthTokenResponse> {
    const url = "https://oauth2.googleapis.com/token";
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: "refresh_token",
    });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });

      if (!response.ok) {
        throw this.createTransportError(
          "Failed to obtain access token",
          "TOKEN_ERROR",
          response.status,
          response.status >= 500 || response.status === 429,
        );
      }

      const data = await response.json();
      const parsed = oauthTokenResponseSchema.safeParse(data);

      if (!parsed.success) {
        throw this.createTransportError(
          "Invalid token response format",
          "TOKEN_ERROR",
          undefined,
          false,
        );
      }

      return parsed.data;
    } catch (error) {
      if (this.isTransportError(error)) {
        throw error;
      }

      throw this.createTransportError(
        `Token fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        "TOKEN_ERROR",
        undefined,
        true,
      );
    }
  }

  /**
   * Builds the full URL with optional query parameters.
   */
  private buildUrl(path: string, query?: Record<string, string>): string {
    const base = this.baseUrl.replace(/\/$/, "");
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    let url = `${base}${cleanPath}`;

    if (query && Object.keys(query).length > 0) {
      const searchParams = new URLSearchParams(query);
      url += `?${searchParams.toString()}`;
    }

    return url;
  }

  /**
   * Safely reads the response body as text.
   */
  private async safeReadBody(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return "<unable to read response body>";
    }
  }

  /**
   * Creates a transport error.
   */
  private createTransportError(
    message: string,
    code: string,
    status?: number,
    retryable = false,
  ): GbpTransportError {
    return {
      message,
      code,
      status,
      retryable,
    };
  }

  /**
   * Type guard for GbpTransportError.
   */
  private isTransportError(error: unknown): error is GbpTransportError {
    return (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      "code" in error &&
      "retryable" in error
    );
  }
}

// ─── Transport Configuration Schema ──────────────────────────────────────────

export const gbpTransportConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

/**
 * Creates a configured GbpTransport instance from environment variables.
 *
 * @param env - Environment variables (defaults to process.env)
 * @returns Configured transport instance
 * @throws Error if required environment variables are missing
 */
export function createGbpTransport(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): GbpTransport {
  const config = {
    clientId: env.GBP_OAUTH_CLIENT_ID ?? "",
    clientSecret: env.GBP_OAUTH_CLIENT_SECRET ?? "",
    refreshToken: env.GBP_OAUTH_REFRESH_TOKEN ?? "",
    baseUrl: env.GBP_API_BASE_URL,
  };

  const validation = gbpTransportConfigSchema.safeParse(config);
  if (!validation.success) {
    const missing = validation.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing GBP transport configuration: ${missing}`);
  }

  return new HttpGbpTransport(validation.data);
}
