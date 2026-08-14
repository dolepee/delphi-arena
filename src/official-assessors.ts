import { createHash } from "node:crypto";
import { PDFParse } from "pdf-parse";
import type { Assessment, MarketView } from "./model.js";

const ARCTIC_PATTERN = /NSIDC Arctic sea ice extent for (\d{4}-\d{2}-\d{2}).*below ([0-9.]+) million km²/iu;
const SILSO_PATTERN = /SILSO estimated sunspot number for (\d{4}-\d{2}-\d{2}) UTC be ([0-9.]+) or higher/iu;
const CRS_35_PATTERN = /SpaceX launch the Dragon CRS-35 cargo mission before ([0-9:]+) UTC on ([A-Z][a-z]{2}) ([0-9]{1,2}), (\d{4})/u;
const NASA_CRS_35_URL = "https://www.nasa.gov/event/nasas-spacex-crs-35/";
const MAMDANI_EXECUTIVE_ORDER_PATTERN = /Mamdani non-emergency NYC executive order dated Aug 9-15, 2026/iu;
const NYC_EXECUTIVE_ORDER_SEARCH_URL = "https://www.nyc.gov/bin/nyc/articlesearch.json?pageSize=100&currentPage=1&types=executive-orders&fromDate=2026-08-09&toDate=2026-08-15";
const NYC_EXECUTIVE_ORDER_DATE_PATTERN = /August (?:9|10|11|12|13|14|15), 2026/u;
const TRUMP_NOMINATIONS_PATTERN = /Trump send at least 5 nominations to the US Senate during Aug 9-15, 2026/iu;
const WHITE_HOUSE_NOMINATIONS_FEED_URL = "https://www.whitehouse.gov/presidential-actions/nominations-appointments/feed/";
const CONGRESS_NOMINATIONS_WINDOW_URL = "https://api.congress.gov/v3/nomination/119?fromDateTime=2026-08-09T00%3A00%3A00Z&toDateTime=2026-08-15T23%3A59%3A59Z&limit=250&format=json&api_key=DEMO_KEY";
const NOMINATIONS_WINDOW_START = Date.parse("2026-08-09T00:00:00.000Z");
const NOMINATIONS_WINDOW_END = Date.parse("2026-08-16T00:00:00.000Z");
const NOMINATIONS_FORECAST_START = Date.parse("2026-08-14T00:00:00.000Z");
const NOMINATIONS_RESULT_START = Date.parse("2026-08-16T12:00:00.000Z");

interface NycExecutiveOrderResult {
  link?: unknown;
  title?: unknown;
  articleDate?: unknown;
}

interface NycExecutiveOrderSearch {
  results?: unknown;
}

interface NominationFeedItem {
  publishedAt: number;
  title: string;
}

function xmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/&#8211;/gu, "–")
    .replace(/&amp;/gu, "&")
    .replace(/<[^>]+>/gu, "")
    .trim();
}

function nominationFeedItems(body: string): NominationFeedItem[] {
  return [...body.matchAll(/<item>([\s\S]*?)<\/item>/gu)].flatMap((match) => {
    const item = match[1] ?? "";
    const title = xmlText(/<title>([\s\S]*?)<\/title>/u.exec(item)?.[1] ?? "");
    const publishedAt = Date.parse(xmlText(/<pubDate>([\s\S]*?)<\/pubDate>/u.exec(item)?.[1] ?? ""));
    if (!Number.isFinite(publishedAt) || !/Nominations?.*Sent to the Senate/iu.test(title)) return [];
    return [{ publishedAt, title }];
  }).sort((left, right) => left.publishedAt - right.publishedAt);
}

function fridaySaturdayWindows(start: number, end: number): number {
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getUTCDay() !== 5) cursor.setUTCDate(cursor.getUTCDate() + 1);
  let count = 0;
  while (cursor.getTime() < end) {
    count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return count;
}

export function assessTrumpNominations(input: {
  market: MarketView;
  feedBody: string;
  congressBody: string;
  feedUrl: string;
  congressUrl: string;
  now: number;
}): Assessment | null {
  if (
    !TRUMP_NOMINATIONS_PATTERN.test(input.market.question) ||
    input.now < NOMINATIONS_FORECAST_START ||
    input.now >= Date.parse(input.market.resolvesAt ?? "1970-01-01")
  ) return null;

  const items = nominationFeedItems(input.feedBody);
  const latest = items.at(-1);
  if (!latest || latest.publishedAt !== Date.parse("2026-08-07T15:09:20.000Z")) return null;
  if (items.some((item) => item.publishedAt >= NOMINATIONS_WINDOW_START)) return null;

  let congress: { nominations?: unknown; pagination?: { count?: unknown } };
  try {
    congress = JSON.parse(input.congressBody) as typeof congress;
  } catch {
    return null;
  }
  if (!Array.isArray(congress.nominations) || congress.nominations.length !== 0 || congress.pagination?.count !== 0) return null;

  const historical = items.filter((item) => item.publishedAt < NOMINATIONS_WINDOW_START);
  const earliest = historical.at(0)?.publishedAt;
  if (earliest === undefined) return null;
  const windows = fridaySaturdayWindows(earliest, NOMINATIONS_WINDOW_START);
  const activeWindows = new Set(historical.flatMap((item) => {
    const date = new Date(item.publishedAt);
    const day = date.getUTCDay();
    if (day !== 5 && day !== 6) return [];
    if (day === 6) date.setUTCDate(date.getUTCDate() - 1);
    return [date.toISOString().slice(0, 10)];
  })).size;
  if (windows < 30) return null;

  // Any Friday/Saturday nomination release is a conservative superset of a
  // release containing five or more nominations. Laplace smoothing avoids a
  // zero-frequency claim while keeping the inference reproducible.
  const anyReleaseProbability = (activeWindows + 1) / (windows + 2);
  const resultKnown = input.now >= NOMINATIONS_RESULT_START;
  if (input.now >= NOMINATIONS_WINDOW_END && !resultKnown) return null;
  const probability = resultKnown ? 0.99 : Math.min(0.97, Math.max(0.85, 1 - anyReleaseProbability));
  const observedAt = new Date(input.now).toISOString();
  const expiry = Math.min(input.now + 10 * 60_000, Date.parse(input.market.resolvesAt!));
  if (expiry <= input.now) return null;
  return {
    marketId: input.market.id,
    outcomeIndex: 1,
    evidenceClass: resultKnown ? "published_result" : "forecast",
    probability,
    confidence: "high",
    status: "actionable",
    observedAt,
    expiresAt: new Date(expiry).toISOString(),
    rationale: resultKnown
      ? "The Aug 9-15 received-date window closed 12 hours ago. The White House official feed has no in-window transmission and Congress.gov still reports zero nomination records updated in the entire contract window."
      : `The White House feed has no nomination transmission after Aug 7 and Congress.gov reports zero nomination records updated in the Aug 9-15 window. Only Friday/Saturday remain; ${activeWindows} of ${windows} historical Friday/Saturday windows in the official feed contained any nomination release, giving a conservative Laplace-smoothed No probability of ${(probability * 100).toFixed(1)}%.`,
    sources: [{
      url: input.feedUrl,
      kind: "authoritative",
      observedAt,
      valueHash: createHash("sha256").update(input.feedBody).digest("hex"),
    }, {
      url: input.congressUrl,
      kind: "authoritative",
      observedAt,
      valueHash: createHash("sha256").update(input.congressBody).digest("hex"),
    }],
  };
}

export async function firstSuccessfulAssessment<T>(
  items: T[],
  evaluate: (item: T) => Promise<Assessment | null>,
): Promise<Assessment | null> {
  for (const item of items) {
    try {
      const assessment = await evaluate(item);
      if (assessment) return assessment;
    } catch {
      continue;
    }
  }
  return null;
}

function exactNycExecutiveOrders(results: unknown): NycExecutiveOrderResult[] {
  if (!Array.isArray(results)) return [];
  return results.filter((value): value is NycExecutiveOrderResult => {
    if (!value || typeof value !== "object") return false;
    const result = value as NycExecutiveOrderResult;
    return typeof result.title === "string" &&
      /^Executive Order No\. \d+$/u.test(result.title) &&
      !/Emergency/iu.test(result.title) &&
      typeof result.articleDate === "string" &&
      NYC_EXECUTIVE_ORDER_DATE_PATTERN.test(result.articleDate) &&
      typeof result.link === "string" &&
      /^\/mayors-office\/news\/2026\/08\/executive-order-[a-z0-9.-]+\.html$/u.test(result.link);
  }).sort((left, right) => String(left.title).localeCompare(String(right.title)));
}

export async function assessMamdaniExecutiveOrder(input: {
  market: MarketView;
  searchBody: string;
  detailBody: string;
  pdfBody: Uint8Array;
  pdfText: string;
  sourceUrl: string;
  detailUrl: string;
  pdfUrl: string;
  now: number;
}): Promise<Assessment | null> {
  if (
    !MAMDANI_EXECUTIVE_ORDER_PATTERN.test(input.market.question) ||
    input.now >= Date.parse(input.market.resolvesAt ?? "1970-01-01")
  ) return null;
  let search: NycExecutiveOrderSearch;
  try {
    search = JSON.parse(input.searchBody) as NycExecutiveOrderSearch;
  } catch {
    return null;
  }
  const result = exactNycExecutiveOrders(search.results).find((candidate) =>
    input.detailUrl === new URL(String(candidate.link), "https://www.nyc.gov").toString()
  );
  if (!result || typeof result.title !== "string") return null;
  const escapedTitle = result.title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`<h1[^>]*>\\s*${escapedTitle}\\s*</h1>`, "iu").test(input.detailBody)) return null;
  const number = /No\. (\d+)$/u.exec(result.title)?.[1];
  if (!number) return null;
  const pdfPath = `/content/dam/nycgov/mayors-office/downloads/pdf/executive-orders/2026/eo-${number}.pdf`;
  if (!input.detailBody.includes(`href="${pdfPath}"`) || !input.pdfUrl.endsWith(pdfPath)) return null;

  const pdfText = input.pdfText.replace(/\s+/gu, " ");
  if (
    !new RegExp(`EXECUTIVE ORDER No\\. ${number}\\s+${NYC_EXECUTIVE_ORDER_DATE_PATTERN.source}`, "u").test(pdfText) ||
    !/Z(?:o|a)hran Kwame Mamdani\s+Mayor/iu.test(pdfText)
  ) return null;

  const observedAt = new Date(input.now).toISOString();
  const expiry = Math.min(input.now + 2 * 60_000, Date.parse(input.market.resolvesAt!));
  if (expiry <= input.now) return null;
  return {
    marketId: input.market.id,
    outcomeIndex: 0,
    evidenceClass: "published_result",
    probability: 0.99,
    confidence: "high",
    status: "actionable",
    observedAt,
    expiresAt: new Date(expiry).toISOString(),
    rationale: `${result.title}, dated ${String(result.articleDate)}, is published in NYC's official executive-order index and its same-number official PDF carries the date and Mayor Mamdani signature.`,
    sources: [{
      url: input.sourceUrl,
      kind: "authoritative",
      observedAt,
      valueHash: createHash("sha256").update(input.searchBody).update(input.detailBody).update(input.pdfBody).digest("hex"),
    }],
  };
}

async function extractPdfText(pdfBody: Uint8Array): Promise<string> {
  // pdf.js may transfer/detach the supplied buffer. Parse a copy so the
  // original bytes remain available for the evidence hash.
  const parser = new PDFParse({ data: pdfBody.slice() });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

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
  let outcomeIndex = 0;
  let rationale: string;
  if (horizonDays === 0) {
    outcomeIndex = latest[1] < threshold ? 0 : 1;
    probability = 0.99;
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
    outcomeIndex,
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

function monthNumber(month: string): number | null {
  const index = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(month);
  return index === -1 ? null : index + 1;
}

export function assessCrs35Schedule(input: {
  market: MarketView;
  body: string;
  sourceUrl: string;
  now: number;
}): Assessment | null {
  const match = CRS_35_PATTERN.exec(input.market.question);
  if (!match || input.now >= Date.parse(input.market.resolvesAt ?? "1970-01-01")) return null;
  const month = monthNumber(match[2]!);
  if (month === null) return null;
  const deadline = Date.parse(`${match[4]}-${String(month).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}T${match[1]}:00.000Z`);
  if (!Number.isFinite(deadline)) return null;

  const normalized = input.body.replace(/&(?:#0*39|apos);/giu, "'").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  if (!/NASA(?:'|’)?s SpaceX CRS-35/iu.test(normalized)) return null;
  if (!/No Earlier Than Fall 2026/iu.test(normalized)) return null;
  const timestamp = /data-event-start-date=["']([^"']+)["']/iu.exec(input.body)?.[1];
  const earliestScheduledAt = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(earliestScheduledAt) || earliestScheduledAt <= deadline) return null;

  const observedAt = new Date(input.now).toISOString();
  const expiry = Math.min(input.now + 10 * 60_000, Date.parse(input.market.resolvesAt!));
  if (expiry <= input.now) return null;
  return {
    marketId: input.market.id,
    outcomeIndex: 1,
    evidenceClass: "official_schedule",
    probability: 0.99,
    confidence: "high",
    status: "actionable",
    observedAt,
    expiresAt: new Date(expiry).toISOString(),
    rationale: `NASA's official CRS-35 event page says "No Earlier Than Fall 2026" and exposes an earliest event date after the ${new Date(deadline).toISOString()} contract deadline.`,
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
    if (TRUMP_NOMINATIONS_PATTERN.test(market.question)) {
      try {
        const [feedResponse, congressResponse] = await Promise.all([
          fetch(WHITE_HOUSE_NOMINATIONS_FEED_URL, {
            headers: { "user-agent": "Conviction-Delphi-Arena/1.0" },
            signal: AbortSignal.timeout(15_000),
          }),
          fetch(CONGRESS_NOMINATIONS_WINDOW_URL, {
            headers: { "user-agent": "Conviction-Delphi-Arena/1.0" },
            signal: AbortSignal.timeout(15_000),
          }),
        ]);
        if (!feedResponse.ok || !congressResponse.ok) continue;
        const assessment = assessTrumpNominations({
          market,
          feedBody: await feedResponse.text(),
          congressBody: await congressResponse.text(),
          feedUrl: WHITE_HOUSE_NOMINATIONS_FEED_URL,
          congressUrl: CONGRESS_NOMINATIONS_WINDOW_URL,
          now,
        });
        if (assessment) assessments.push(assessment);
      } catch {
        continue;
      }
      continue;
    }
    if (MAMDANI_EXECUTIVE_ORDER_PATTERN.test(market.question)) {
      try {
        const searchResponse = await fetch(NYC_EXECUTIVE_ORDER_SEARCH_URL, {
          headers: { "user-agent": "Conviction-Delphi-Arena/1.0" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!searchResponse.ok) continue;
        const searchBody = await searchResponse.text();
        const search = JSON.parse(searchBody) as NycExecutiveOrderSearch;
        const results = exactNycExecutiveOrders(search.results);
        const assessment = await firstSuccessfulAssessment(results, async (result) => {
            if (typeof result.link !== "string" || typeof result.title !== "string") return null;
            const number = /No\. (\d+)$/u.exec(result.title)?.[1];
            if (!number) return null;
            const detailUrl = new URL(result.link, "https://www.nyc.gov").toString();
            const pdfUrl = `https://www.nyc.gov/content/dam/nycgov/mayors-office/downloads/pdf/executive-orders/2026/eo-${number}.pdf`;
            const [detailResponse, pdfResponse] = await Promise.all([
              fetch(detailUrl, { headers: { "user-agent": "Conviction-Delphi-Arena/1.0" }, signal: AbortSignal.timeout(15_000) }),
              fetch(pdfUrl, { headers: { "user-agent": "Conviction-Delphi-Arena/1.0" }, signal: AbortSignal.timeout(15_000) }),
            ]);
            if (!detailResponse.ok || !pdfResponse.ok) return null;
            const pdfBody = new Uint8Array(await pdfResponse.arrayBuffer());
            return assessMamdaniExecutiveOrder({
              market,
              searchBody,
              detailBody: await detailResponse.text(),
              pdfBody,
              pdfText: await extractPdfText(pdfBody),
              sourceUrl: NYC_EXECUTIVE_ORDER_SEARCH_URL,
              detailUrl,
              pdfUrl,
              now,
            });
          });
        if (assessment) assessments.push(assessment);
      } catch {
        continue;
      }
      continue;
    }
    let sourceUrl: string;
    let assessor: (input: { market: MarketView; body: string; sourceUrl: string; now: number }) => Assessment | null;
    if (ARCTIC_PATTERN.test(market.question)) {
      sourceUrl = "https://nsidc.org/api/seaiceservice/extent/north/filled_averaged_data/2026?smoothing_window=0";
      assessor = assessArcticExtent;
    } else if (SILSO_PATTERN.test(market.question)) {
      sourceUrl = "https://www.sidc.be/SILSO/DATA/EISN/EISN_current.csv";
      assessor = assessSilsoSunspot;
    } else if (CRS_35_PATTERN.test(market.question)) {
      sourceUrl = NASA_CRS_35_URL;
      assessor = assessCrs35Schedule;
    } else {
      continue;
    }
    try {
      const response = await fetch(sourceUrl, {
        headers: { "user-agent": "Conviction-Delphi-Arena/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;
      const assessment = assessor({ market, body: await response.text(), sourceUrl, now });
      if (assessment) assessments.push(assessment);
    } catch {
      continue;
    }
  }
  return assessments;
}
