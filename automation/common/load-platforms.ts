import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PlatformDefinition } from "./types.js";

export type LoadMode = "operational" | "diagnostic";

export function loadPlatforms(
  countryCode: string,
  mode: LoadMode = "operational",
  rootDir?: string,
): PlatformDefinition[] {
  const root = rootDir ?? resolve(process.cwd());

  const globalPath = resolve(root, "data", "platforms", "global", "platforms.json");
  const marketPath = resolve(root, "data", "platforms", countryCode, "platforms.json");

  const globalPlatforms = readPlatformFile(globalPath);
  const marketPlatforms = readPlatformFile(marketPath);

  const allPlatforms = [...globalPlatforms, ...marketPlatforms];

  // Detect duplicate IDs
  const seen = new Map<string, string>();
  for (const p of allPlatforms) {
    const existing = seen.get(p.id);
    if (existing) {
      throw new Error(
        `Duplicate platform ID "${p.id}" found in: ${existing} and ${p.id.startsWith("example") ? marketPath : globalPath}`,
      );
    }
    seen.set(p.id, p.id.startsWith("example") ? "global" : "market");
  }

  // Determine source for each platform
  const globalIds = new Set(globalPlatforms.map((p) => p.id));
  const marketIds = new Set(marketPlatforms.map((p) => p.id));

  const result: PlatformDefinition[] = [];
  for (const p of allPlatforms) {
    const inGlobal = globalIds.has(p.id);
    const inMarket = marketIds.has(p.id);

    // Skip disabled in operational mode
    if (mode === "operational" && !p.enabled) {
      continue;
    }

    result.push(p);
  }

  return result;
}

function readPlatformFile(filePath: string): PlatformDefinition[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in platform file: ${filePath}`);
  }

  if (!Array.isArray(data)) {
    throw new Error(`Platform file must contain an array: ${filePath}`);
  }

  return data as PlatformDefinition[];
}
