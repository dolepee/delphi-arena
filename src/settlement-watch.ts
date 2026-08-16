import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const SETTLEMENT_ALERT_GRACE_MS = 60 * 60_000;

function metadataRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    return metadataRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

export function settlementStartsAt(metadata: unknown): number | null {
  const value = metadataRecord(metadata)?.settlement_starts;
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function awaitingSettlementIsOverdue(input: {
  chainStatus: string;
  settlementStartsAt: number | null;
  now: number;
  graceMs?: number;
}): boolean {
  if (input.chainStatus !== "awaiting_settlement" || input.settlementStartsAt === null) return false;
  const graceMs = input.graceMs ?? SETTLEMENT_ALERT_GRACE_MS;
  return input.now > input.settlementStartsAt + graceMs;
}

export async function loadAlertedSettlementMarkets(path: string): Promise<Set<string>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { marketIds?: unknown };
    return new Set(Array.isArray(value.marketIds)
      ? value.marketIds
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.toLowerCase())
      : []);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

export async function saveAlertedSettlementMarkets(path: string, marketIds: Iterable<string>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    version: 1,
    observedAt: new Date().toISOString(),
    marketIds: [...marketIds].map((item) => item.toLowerCase()).sort(),
  }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
