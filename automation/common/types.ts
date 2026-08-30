/**
 * Base adapter interface for platform integrations.
 *
 * Each platform adapter implements this interface so that
 * automation workflows remain brand-agnostic.
 *
 * The adapter receives three dimensions of configuration:
 * - brand: which company's data to use
 * - market: which country/region to target
 * - platform: which external platform to interact with
 */

export interface AdapterConfig {
  brand: string;
  market: string;
  platform: string;
}

export interface RegistrationResult {
  success: boolean;
  listingUrl?: string;
  error?: string;
  requiresManualAction?: boolean;
}

export interface PlatformAdapter {
  readonly platformId: string;

  /**
   * Prepare the adapter with brand, market, and platform configuration.
   *
   * Example:
   *   configure({ brand: "best-fluency", market: "PT", platform: "cylex-pt" })
   */
  configure(config: AdapterConfig): Promise<void>;

  /**
   * Check if the platform is accessible and ready.
   */
  healthCheck(): Promise<boolean>;

  /**
   * Execute the registration or update flow.
   * Returns a result indicating success, failure, or need for manual action.
   */
  register(): Promise<RegistrationResult>;

  /**
   * Clean up browser state if needed.
   */
  dispose(): Promise<void>;
}
