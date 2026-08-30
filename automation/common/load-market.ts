import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MarketTarget, ListingEntry, TargetsFile, ListingPriority, ListingStatus } from "./types.js";

export interface MarketData {
  target: MarketTarget;
  listings: ListingEntry[];
}

export function loadMarket(brandId: string, countryCode: string, rootDir?: string): MarketData {
  const root = rootDir ?? resolve(process.cwd());

  // Load targets.json
  const targetsPath = resolve(root, "brands", brandId, "markets", "targets.json");
  let rawTargets: string;
  try {
    rawTargets = readFileSync(targetsPath, "utf-8");
  } catch {
    throw new Error(`Targets file not found: ${targetsPath}`);
  }

  let targetsFile: TargetsFile;
  try {
    targetsFile = JSON.parse(rawTargets);
  } catch {
    throw new Error(`Invalid JSON in targets file: ${targetsPath}`);
  }

  const target = targetsFile.markets.find((m) => m.country === countryCode);
  if (!target) {
    throw new Error(`Market "${countryCode}" not found in ${targetsPath}`);
  }
  if (!target.enabled) {
    throw new Error(`Market "${countryCode}" is disabled in ${targetsPath}`);
  }

  // Load CSV
  const csvPath = resolve(root, "brands", brandId, "markets", `${countryCode}.csv`);
  let rawCsv: string;
  try {
    rawCsv = readFileSync(csvPath, "utf-8");
  } catch {
    throw new Error(`Market CSV not found: ${csvPath}`);
  }

  const listings = parseCsv(rawCsv);

  return { target, listings };
}

function parseCsv(raw: string): ListingEntry[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];

  const header = lines[0].split(",").map((h) => h.trim());
  const entries: ListingEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = values[j] ?? "";
    }

    entries.push({
      platform_id: row.platform_id ?? "",
      listing_name: row.listing_name || undefined,
      enabled: row.enabled === "true",
      priority: (row.priority as ListingPriority) ?? "medium",
      status: (row.status as ListingStatus) ?? "pending",
      listing_url: row.listing_url || undefined,
      last_checked: row.last_checked || undefined,
      notes: row.notes || undefined,
    });
  }

  return entries;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}
