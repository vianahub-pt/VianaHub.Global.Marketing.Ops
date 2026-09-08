import { existsSync, readFileSync } from "node:fs";
import { loadBrand } from "./common/load-brand.js";
import { loadMarket } from "./common/load-market.js";
import { loadPlatforms } from "./common/load-platforms.js";
import { validateBrandId, validateMarket, safeResolve } from "./common/path-security.js";
import { TargetsFileSchema } from "./common/schemas.js";

interface ValidationError {
  path: string;
  message: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: string[];
  brandId: string;
  market: string;
  stats: {
    platforms: number;
    listings: number;
    globalPlatforms: number;
    marketPlatforms: number;
    listingsByStatus: Record<string, number>;
  };
}

function log(message: string): void {
  console.log(message);
}

function logError(message: string): void {
  console.error(`ERROR: ${message}`);
}

function logWarning(message: string): void {
  console.warn(`WARNING: ${message}`);
}

export function validateRepository(
  brandId: string,
  market: string,
  rootDir?: string,
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: string[] = [];
  const root = rootDir ?? process.cwd();

  validateBrandId(brandId);
  validateMarket(market);

  // 1. Validate brand profile
  log(`Validating brand profile for "${brandId}"...`);
  try {
    loadBrand(brandId, root);
  } catch (err) {
    errors.push({
      path: `brands/${brandId}/business-profile/master-data.json`,
      message: (err as Error).message,
    });
  }

  // 2. Validate targets.json
  log(`Validating targets for "${brandId}"...`);
  const targetsPath = safeResolve(root, "brands", brandId, "markets", "targets.json");
  if (!existsSync(targetsPath)) {
    errors.push({
      path: `brands/${brandId}/markets/targets.json`,
      message: "targets.json not found",
    });
  } else {
    try {
      const raw = readFileSync(targetsPath, "utf-8");
      const data = JSON.parse(raw);

      TargetsFileSchema.parse(data);
    } catch (err) {
      errors.push({
        path: `brands/${brandId}/markets/targets.json`,
        message: (err as Error).message,
      });
    }
  }

  // 3. Validate market CSV
  log(`Validating market CSV for "${market}"...`);
  let marketData;
  try {
    marketData = loadMarket(brandId, market, root);
  } catch (err) {
    errors.push({
      path: `brands/${brandId}/markets/${market}.csv`,
      message: (err as Error).message,
    });
  }

  // 4. Validate platform catalogs
  log("Validating platform catalogs...");
  let globalPlatforms: ReturnType<typeof loadPlatforms> = [];
  let marketPlatforms: ReturnType<typeof loadPlatforms> = [];

  const globalPath = safeResolve(root, "data", "platforms", "global", "platforms.json");
  if (existsSync(globalPath)) {
    try {
      globalPlatforms = loadPlatforms(market, "operational", root);
    } catch (err) {
      errors.push({
        path: "data/platforms/global/platforms.json",
        message: (err as Error).message,
      });
    }
  }

  const marketPlatPath = safeResolve(root, "data", "platforms", market, "platforms.json");
  if (existsSync(marketPlatPath)) {
    try {
      marketPlatforms = loadPlatforms(market, "operational", root);
    } catch (err) {
      errors.push({
        path: `data/platforms/${market}/platforms.json`,
        message: (err as Error).message,
      });
    }
  }

  // 5. Cross-validate listings against platform catalogs
  log("Cross-validating listings against platforms...");
  if (marketData && globalPlatforms.length > 0) {
    for (const listing of marketData.listings) {
      const globalPlatform = globalPlatforms.find((p) => p.id === listing.platform_id);
      if (globalPlatform && listing.enabled === false && globalPlatform.enabled) {
        warnings.push(
          `Listing "${listing.platform_id}" is disabled but global platform is enabled`,
        );
      }
    }
  }

  if (marketData && marketPlatforms.length > 0) {
    for (const listing of marketData.listings) {
      const marketPlatform = marketPlatforms.find((p) => p.id === listing.platform_id);
      if (!marketPlatform && !globalPlatforms.some((p) => p.id === listing.platform_id)) {
        errors.push({
          path: `brands/${brandId}/markets/${market}.csv`,
          message: `Listing references unknown platform: "${listing.platform_id}"`,
        });
      }
    }
  }

  // 6. Validate description file
  const descPath = safeResolve(
    root,
    "brands",
    brandId,
    "business-profile",
    "descriptions",
    `${market.toLowerCase().slice(0, 2)}-${market}.md`,
  );
  if (!existsSync(descPath)) {
    warnings.push(`Description file not found: ${descPath}`);
  }

  // 7. Build stats
  const listingsByStatus: Record<string, number> = {};
  if (marketData) {
    for (const l of marketData.listings) {
      listingsByStatus[l.status] = (listingsByStatus[l.status] ?? 0) + 1;
    }
  }

  const result: ValidationResult = {
    valid: errors.length === 0,
    errors,
    warnings,
    brandId,
    market,
    stats: {
      platforms: globalPlatforms.length + marketPlatforms.length,
      listings: marketData?.listings.length ?? 0,
      globalPlatforms: globalPlatforms.length,
      marketPlatforms: marketPlatforms.length,
      listingsByStatus,
    },
  };

  return result;
}

function main(): void {
  const brandId = process.argv[2] ?? "best-fluency";
  const market = process.argv[3] ?? "PT";

  console.log("=".repeat(60));
  console.log("VianaHub Marketing Ops - Repository Validation");
  console.log("=".repeat(60));
  console.log(`Brand: ${brandId}`);
  console.log(`Market: ${market}`);
  console.log("=".repeat(60));

  const result = validateRepository(brandId, market);

  console.log("\n--- Stats ---");
  console.log(`Platforms: ${result.stats.platforms}`);
  console.log(`  Global: ${result.stats.globalPlatforms}`);
  console.log(`  Market: ${result.stats.marketPlatforms}`);
  console.log(`Listings: ${result.stats.listings}`);
  console.log(`Status distribution:`, result.stats.listingsByStatus);

  if (result.warnings.length > 0) {
    console.log(`\n--- Warnings (${result.warnings.length}) ---`);
    for (const w of result.warnings) {
      logWarning(w);
    }
  }

  if (result.errors.length > 0) {
    console.log(`\n--- Errors (${result.errors.length}) ---`);
    for (const e of result.errors) {
      logError(`[${e.path}] ${e.message}`);
    }
    console.log(`\nValidation FAILED`);
    process.exit(1);
  } else {
    console.log(`\nValidation PASSED`);
  }
}

main();
