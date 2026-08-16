import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MarketView } from "./model.js";
import type { OpportunityDefinition } from "./opportunity-audit.js";

export function unclassifiedMarkets(
  markets: MarketView[],
  definitions: OpportunityDefinition[],
): MarketView[] {
  const classified = new Set(definitions.map((definition) => definition.marketId.toLowerCase()));
  return markets.filter((market) =>
    market.status === "open" && !classified.has(market.id.toLowerCase())
  );
}

export async function loadPreviouslyUnclassified(path: string): Promise<Set<string>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { marketIds?: unknown };
    return new Set(Array.isArray(value.marketIds)
      ? value.marketIds.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase())
      : []);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

export async function saveUnclassified(path: string, marketIds: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    version: 1,
    observedAt: new Date().toISOString(),
    marketIds: marketIds.map((item) => item.toLowerCase()).sort(),
  }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
