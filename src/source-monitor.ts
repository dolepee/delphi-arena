import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { MarketView } from "./model.js";

export interface SourceObservation {
  marketId: string;
  url: string;
  observedAt: string;
  ok: boolean;
  status: number | null;
  contentType: string | null;
  valueHash: string | null;
  bytes: number | null;
  error: string | null;
}

const CONCURRENCY = 4;

export function sourceUrls(value: unknown): string[] {
  if (typeof value === "string" && /^https?:\/\//u.test(value)) return [value];
  if (typeof value === "string") {
    try {
      return sourceUrls(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(sourceUrls);
  if (value && typeof value === "object") return Object.values(value).flatMap(sourceUrls);
  return [];
}

export async function observeSources(markets: MarketView[], outputDirectory: string) {
  const observedAt = new Date().toISOString();
  const probes = markets.flatMap((market) =>
    [...new Set(sourceUrls(market.dataSources))].map((url) => ({ marketId: market.id, url })),
  );
  const observations: SourceObservation[] = [];
  for (let offset = 0; offset < probes.length; offset += CONCURRENCY) {
    const batch = probes.slice(offset, offset + CONCURRENCY);
    const results = await Promise.all(batch.map(async ({ marketId, url }): Promise<SourceObservation> => {
      try {
        const response = await fetch(url, {
          headers: { "user-agent": "Conviction-Delphi-Arena/1.0" },
          signal: AbortSignal.timeout(15_000),
        });
        const body = new Uint8Array(await response.arrayBuffer());
        return {
          marketId,
          url,
          observedAt,
          ok: response.ok,
          status: response.status,
          contentType: response.headers.get("content-type"),
          valueHash: createHash("sha256").update(body).digest("hex"),
          bytes: body.byteLength,
          error: null,
        };
      } catch (error) {
        return {
          marketId,
          url,
          observedAt,
          ok: false,
          status: null,
          contentType: null,
          valueHash: null,
          bytes: null,
          error: String(error),
        };
      }
    }));
    observations.push(...results);
  }
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const path = resolve(outputDirectory, "latest-source-observations.json");
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, observedAt, observations }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return observations;
}
