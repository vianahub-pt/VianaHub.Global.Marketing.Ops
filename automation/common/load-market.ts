import { readFileSync } from "node:fs";
import type { MarketTarget, ListingEntry } from "./types.js";
import { parseCsv } from "./csv-parser.js";
import { validateBrandId, validateMarket, safeResolve } from "./path-security.js";
import { TargetsFileSchema, validateListing } from "./schemas.js";

export interface MarketData {
  target: MarketTarget;
  listings: ListingEntry[];
}

export function loadMarket(brandId: string, countryCode: string, rootDir?: string): MarketData {
  validateBrandId(brandId);
  validateMarket(countryCode);

  const root = rootDir ?? process.cwd();

  // Load targets.json
  const targetsPath = safeResolve(root, "brands", brandId, "markets", "targets.json");
  let rawTargets: string;
  try {
    rawTargets = readFileSync(targetsPath, "utf-8");
  } catch {
    throw new Error(`Targets file not found: ${targetsPath}`);
  }

  let targetsFile: unknown;
  try {
    targetsFile = JSON.parse(rawTargets);
  } catch {
    throw new Error(`Invalid JSON in targets file: ${targetsPath}`);
  }

  const validatedTargets = TargetsFileSchema.safeParse(targetsFile);
  if (!validatedTargets.success) {
    const issues = validatedTargets.error.issues.map((i) => i.message).join("; ");
    throw new Error(`Invalid targets file: ${issues}`);
  }

  if (validatedTargets.data.brandId !== brandId) {
    throw new Error(
      `brandId mismatch: expected "${brandId}", got "${validatedTargets.data.brandId}"`,
    );
  }

  const target = validatedTargets.data.markets.find((m) => m.country === countryCode);
  if (!target) {
    throw new Error(`Market "${countryCode}" not found in ${targetsPath}`);
  }
  if (!target.enabled) {
    throw new Error(`Market "${countryCode}" is disabled in ${targetsPath}`);
  }

  // Load CSV
  const csvPath = safeResolve(root, "brands", brandId, "markets", `${countryCode}.csv`);
  let rawCsv: string;
  try {
    rawCsv = readFileSync(csvPath, "utf-8");
  } catch {
    throw new Error(`Market CSV not found: ${csvPath}`);
  }

  const csvResult = parseCsv(rawCsv);
  const listings = csvResult.rows.map((row) => validateListing(row));

  return { target, listings };
}
