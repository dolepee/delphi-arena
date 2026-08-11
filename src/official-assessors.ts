import { createHash } from "node:crypto";
import type { Assessment, MarketView } from "./model.js";

const ARCTIC_PATTERN = /NSIDC Arctic sea ice extent for (\d{4}-\d{2}-\d{2}).*below ([0-9.]+) million km²/iu;

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

export async function generateOfficialAssessments(markets: MarketView[], now = Date.now()): Promise<Assessment[]> {
  const assessments: Assessment[] = [];
  for (const market of markets) {
    if (!ARCTIC_PATTERN.test(market.question)) continue;
    const sourceUrl = "https://nsidc.org/api/seaiceservice/extent/north/filled_averaged_data/2026?smoothing_window=0";
    const response = await fetch(sourceUrl, {
      headers: { "user-agent": "Conviction-Delphi-Arena/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) continue;
    const assessment = assessArcticExtent({ market, body: await response.text(), sourceUrl, now });
    if (assessment) assessments.push(assessment);
  }
  return assessments;
}
