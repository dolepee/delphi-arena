import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const OFFICIAL_COMPETITION_URL = "https://competition.delphi.fyi/";

const rankingSchema = z.object({
  rank: z.number().int().positive(),
  rankChange: z.number().finite().optional(),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
  name: z.string().nullable().optional(),
  accountValue: z.number().finite().nonnegative(),
  cash: z.number().finite().nonnegative(),
  pnl: z.number().finite(),
  tradesVolume: z.number().finite().nonnegative(),
  tradesCount: z.number().int().nonnegative(),
});

const podiumSnapshotSchema = z.object({
  version: z.literal(1),
  observedAt: z.string().datetime(),
  sourceUrl: z.literal(OFFICIAL_COMPETITION_URL),
  third: rankingSchema.refine((row) => row.rank === 3, "third-place row must have rank 3"),
  conviction: rankingSchema,
  thirdPlacePnlTst: z.number().finite(),
  convictionPnlTst: z.number().finite(),
  gapToThirdPnlTst: z.number().finite().nonnegative(),
}).superRefine((snapshot, context) => {
  if (snapshot.thirdPlacePnlTst !== snapshot.third.pnl) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["thirdPlacePnlTst"],
      message: "third-place PnL must match the official ranking row",
    });
  }
  if (snapshot.convictionPnlTst !== snapshot.conviction.pnl) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["convictionPnlTst"],
      message: "Conviction PnL must match the official ranking row",
    });
  }
  const expectedGap = Math.max(0, snapshot.third.pnl - snapshot.conviction.pnl);
  if (Math.abs(snapshot.gapToThirdPnlTst - expectedGap) > 1e-9) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["gapToThirdPnlTst"],
      message: "podium gap must match the official ranking rows",
    });
  }
});

export type OfficialRanking = z.infer<typeof rankingSchema>;
export type PodiumSnapshot = z.infer<typeof podiumSnapshotSchema>;

function extractJsonArray(source: string, start: number): string | null {
  if (source[start] !== "[") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function nextFlightPayloads(html: string): string[] {
  const prefix = "self.__next_f.push(";
  const suffix = ")</script>";
  const payloads: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf(prefix, cursor);
    if (start === -1) break;
    const argumentStart = start + prefix.length;
    const end = html.indexOf(suffix, argumentStart);
    if (end === -1) break;
    cursor = end + suffix.length;
    try {
      const value = JSON.parse(html.slice(argumentStart, end)) as unknown;
      if (Array.isArray(value) && typeof value[1] === "string") payloads.push(value[1]);
    } catch {
      // Ignore unrelated or malformed flight chunks. The required rankings
      // chunk is still mandatory below.
    }
  }
  return payloads;
}

export function parseOfficialRankings(html: string): OfficialRanking[] {
  const marker = '"rankings":';
  const matches: OfficialRanking[][] = [];
  for (const payload of nextFlightPayloads(html)) {
    const markerIndex = payload.indexOf(marker);
    if (markerIndex === -1) continue;
    const arrayStart = payload.indexOf("[", markerIndex + marker.length);
    if (arrayStart === -1) continue;
    const encoded = extractJsonArray(payload, arrayStart);
    if (!encoded) continue;
    const parsed = z.array(rankingSchema).min(3).parse(JSON.parse(encoded));
    matches.push(parsed);
  }
  if (matches.length !== 1) throw new Error(`expected one official rankings payload, found ${matches.length}`);
  const rankings = matches[0]!;
  const ranks = new Set(rankings.map((row) => row.rank));
  const addresses = new Set(rankings.map((row) => row.address.toLowerCase()));
  if (ranks.size !== rankings.length || addresses.size !== rankings.length) {
    throw new Error("official rankings contain duplicate rank or wallet");
  }
  if (!rankings.some((row) => row.rank === 3)) throw new Error("official rankings lack third place");
  return rankings;
}

export function buildPodiumSnapshot(input: {
  rankings: OfficialRanking[];
  convictionWallet: string;
  observedAt: string;
}): PodiumSnapshot {
  const third = input.rankings.find((row) => row.rank === 3);
  const conviction = input.rankings.find((row) =>
    row.address.toLowerCase() === input.convictionWallet.toLowerCase()
  );
  if (!third) throw new Error("official rankings lack third place");
  if (!conviction) throw new Error("registered Conviction wallet is absent from official rankings");
  return podiumSnapshotSchema.parse({
    version: 1,
    observedAt: input.observedAt,
    sourceUrl: OFFICIAL_COMPETITION_URL,
    third,
    conviction,
    thirdPlacePnlTst: third.pnl,
    convictionPnlTst: conviction.pnl,
    gapToThirdPnlTst: Math.max(0, third.pnl - conviction.pnl),
  });
}

export async function savePodiumSnapshot(path: string, snapshot: PodiumSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function loadFreshPodiumSnapshot(
  path: string,
  now: number,
  maximumAgeMs: number,
  expectedWallet: string,
): Promise<PodiumSnapshot> {
  const snapshot = podiumSnapshotSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (snapshot.conviction.address.toLowerCase() !== expectedWallet.toLowerCase()) {
    throw new Error("official podium snapshot belongs to the wrong wallet");
  }
  const observedAt = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > maximumAgeMs) {
    throw new Error("official podium snapshot is stale");
  }
  return snapshot;
}
