import { createHash } from "node:crypto";
import type { Assessment, MarketView } from "./model.js";

const ARCTIC_PATTERN = /NSIDC Arctic sea ice extent for (\d{4}-\d{2}-\d{2}).*below ([0-9.]+) million km²/iu;
const SILSO_PATTERN = /SILSO estimated sunspot number for (\d{4}-\d{2}-\d{2}) UTC be ([0-9.]+) or higher/iu;

function utcDay(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`) / 86_400_000;
}

export function assessArcticExtent(input: {
  market: MarketView;
  body: string;
  sourceUrl: string;
  now: number;
}): Assessment | null {
  const match = ARCTIC_PATTERN.exec(input.market.question);
  if (!match) return null;
  const targetDate = match[1]!;
  const threshold = Number(match[2]);
  const parsed = JSON.parse(input.body) as Record<string, number>;
  const rows = Object.entries(parsed)
    .filter(([date, value]) => /^\d{4}-\d{2}-\d{2}$/u.test(date) && Number.isFinite(value) && date <= targetDate)
    .sort(([left], [right]) => left.localeCompare(right));
  const latest = rows.at(-1);
  if (!latest || input.now >= Date.parse(input.market.resolvesAt ?? "1970-01-01")) return null;

  const horizonDays = utcDay(targetDate) - utcDay(latest[0]);
  if (horizonDays < 0 || horizonDays > 7) return null;
  let probability: number;
  let rationale: string;
  if (horizonDays === 0) {
    probability = latest[1] < threshold ? 0.99 : 0.01;
    rationale = `NSIDC now reports ${latest[1]} million km² for ${targetDate}; the contract threshold is ${threshold}.`;
  } else {
    const window = rows.slice(-46);
    const outcomes: boolean[] = [];
    for (let index = horizonDays; index < window.length; index += 1) {
      const historicalDelta = window[index]![1] - window[index - horizonDays]![1];
      outcomes.push(latest[1] + historicalDelta < threshold);
    }
    if (outcomes.length < 20) return null;
    const successes = outcomes.filter(Boolean).length;
    probability = Math.min(0.97, Math.max(0.03, (successes + 1) / (outcomes.length + 2)));
    rationale = `NSIDC reports ${latest[1]} million km² on ${latest[0]}. Applying ${outcomes.length} trailing ${horizonDays}-day changes puts ${successes} below the ${threshold} target; Laplace-smoothed probability is ${(probability * 100).toFixed(1)}%.`;
  }
  const observedAt = new Date(input.now).toISOString();
  const expiry = Math.min(input.now + 10 * 60_000, Date.parse(input.market.resolvesAt!));
  if (expiry <= input.now) return null;
  return {
    marketId: input.market.id,
    outcomeIndex: 0,
    evidenceClass: horizonDays === 0 ? "published_result" : "forecast",
    probability,
    confidence: probability >= 0.85 || probability <= 0.15 ? "high" : "medium",
    status: "actionable",
    observedAt,
    expiresAt: new Date(expiry).toISOString(),
    rationale,
    sources: [{
      url: input.sourceUrl,
      kind: "authoritative",
      observedAt,
      valueHash: createHash("sha256").update(input.body).digest("hex"),
    }],
  };
}

export function assessSilsoSunspot(input: {
  market: MarketView;
  body: string;
  sourceUrl: string;
  now: number;
}): Assessment | null {
  const match = SILSO_PATTERN.exec(input.market.question);
  if (!match || input.now >= Date.parse(input.market.resolvesAt ?? "1970-01-01")) return null;
  const targetDate = match[1]!;
  const threshold = Number(match[2]);
  const targetParts = targetDate.split("-").map(Number);
  const row = input.body.split(/\r?\n/u).map((line) => line.split(",").map((part) => part.trim()))
    .find((parts) =>
      Number(parts[0]) === targetParts[0] &&
      Number(parts[1]) === targetParts[1] &&
      Number(parts[2]) === targetParts[2]
    );
  const value = Number(row?.[4]);
  if (!row || !Number.isFinite(value)) return null;

  const conditionMet = value >= threshold;
  const observedAt = new Date(input.now).toISOString();
  const expiry = Math.min(input.now + 10 * 60_000, Date.parse(input.market.resolvesAt!));
  if (expiry <= input.now) return null;
  return {
    marketId: input.market.id,
    outcomeIndex: conditionMet ? 0 : 1,
    evidenceClass: "published_result",
    probability: 0.99,
    confidence: "high",
    status: "actionable",
    observedAt,
    expiresAt: new Date(expiry).toISOString(),
    rationale: `SILSO now reports an estimated sunspot number of ${value} for ${targetDate}; the contract threshold is ${threshold} or higher.`,
    sources: [{
      url: input.sourceUrl,
      kind: "authoritative",
      observedAt,
      valueHash: createHash("sha256").update(input.body).digest("hex"),
    }],
  };
}

export async function generateOfficialAssessments(markets: MarketView[], now = Date.now()): Promise<Assessment[]> {
  const assessments: Assessment[] = [];
  for (const market of markets) {
    let sourceUrl: string;
    let assessor: (input: { market: MarketView; body: string; sourceUrl: string; now: number }) => Assessment | null;
    if (ARCTIC_PATTERN.test(market.question)) {
      sourceUrl = "https://nsidc.org/api/seaiceservice/extent/north/filled_averaged_data/2026?smoothing_window=0";
      assessor = assessArcticExtent;
    } else if (SILSO_PATTERN.test(market.question)) {
      sourceUrl = "https://www.sidc.be/SILSO/DATA/EISN/EISN_current.csv";
      assessor = assessSilsoSunspot;
    } else {
      continue;
    }
    const response = await fetch(sourceUrl, {
      headers: { "user-agent": "Conviction-Delphi-Arena/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) continue;
    const assessment = assessor({ market, body: await response.text(), sourceUrl, now });
    if (assessment) assessments.push(assessment);
  }
  return assessments;
}
