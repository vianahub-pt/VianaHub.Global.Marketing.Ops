import { readFileSync } from "node:fs";
import type { PlatformDefinition, PlatformWithSource, PlatformSource } from "./types.js";
import { validateMarket, safeResolve } from "./path-security.js";
import { PlatformDefinitionSchema } from "./schemas.js";

export type LoadMode = "operational" | "diagnostic";

interface LoadedPlatform {
  platform: PlatformDefinition;
  source: PlatformSource;
  filePath: string;
}

export function loadPlatforms(
  countryCode: string,
  mode: LoadMode = "operational",
  rootDir?: string,
): PlatformWithSource[] {
  validateMarket(countryCode);

  const root = rootDir ?? process.cwd();

  const globalPath = safeResolve(root, "data", "platforms", "global", "platforms.json");
  const marketPath = safeResolve(root, "data", "platforms", countryCode, "platforms.json");

  const globalPlatforms = readPlatformFile(globalPath).map((p) => ({
    platform: p,
    source: "global" as PlatformSource,
    filePath: globalPath,
  }));

  const marketPlatforms = readPlatformFile(marketPath).map((p) => ({
    platform: p,
    source: "market" as PlatformSource,
    filePath: marketPath,
  }));

  const allLoaded = [...globalPlatforms, ...marketPlatforms];

  // Detect duplicate IDs across global and market
  const seen = new Map<string, LoadedPlatform>();
  for (const item of allLoaded) {
    const existing = seen.get(item.platform.id);
    if (existing) {
      throw new Error(
        `Duplicate platform ID "${item.platform.id}" found in:\n${existing.filePath}\n${item.filePath}`,
      );
    }
    seen.set(item.platform.id, item);
  }

  // Filter based on mode
  const result: PlatformWithSource[] = [];
  for (const item of allLoaded) {
    if (mode === "operational" && !item.platform.enabled) {
      continue;
    }

    result.push({
      ...item.platform,
      source: item.source,
    });
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

  const platforms: PlatformDefinition[] = [];
  for (let i = 0; i < data.length; i++) {
    const validated = PlatformDefinitionSchema.safeParse(data[i]);
    if (!validated.success) {
      const issues = validated.error.issues.map((j) => j.message).join("; ");
      throw new Error(`Platform file ${filePath}, entry ${i}: ${issues}`);
    }
    platforms.push(validated.data as PlatformDefinition);
  }

  return platforms;
}
