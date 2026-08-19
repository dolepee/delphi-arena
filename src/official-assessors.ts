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
const NOMINATIONS_WINDOW_START = Date.parse("2026-08-09T00:00:00.000Z");
const NOMINATIONS_WINDOW_END = Date.parse("2026-08-16T00:00:00.000Z");
const NOMINATIONS_FORECAST_START = Date.parse("2026-08-14T00:00:00.000Z");
const NOMINATIONS_RESULT_START = Date.parse("2026-08-16T12:00:00.000Z");
const FEDERAL_REGISTER_PATTERN = /Federal Register publish 6\+ Presidential documents with publication dates Aug 12-18, 2026/iu;
const FEDERAL_REGISTER_URL = "https://www.federalregister.gov/api/v1/documents.json?conditions%5Btype%5D%5B%5D=PRESDOCU&conditions%5Bpublication_date%5D%5Bgte%5D=2026-08-12&conditions%5Bpublication_date%5D%5Blte%5D=2026-08-18&per_page=1";
const FEDERAL_REGISTER_NO_FORECAST_START = Date.parse("2026-08-14T21:00:00.000Z");
const FEDERAL_REGISTER_CALIBRATION_URL = "https://www.federalregister.gov/api/v1/documents.json?conditions%5Btype%5D%5B%5D=PRESDOCU&conditions%5Bpublication_date%5D%5Bgte%5D=2025-11-05&conditions%5Bpublication_date%5D%5Blte%5D=2026-08-11&per_page=1000&order=newest";
// SHA-256 of the sorted `document_number|publication_date` rows returned by
// the fixed calibration query. Canonical fields keep the evidence reproducible
// even if the API later changes presentation-only metadata or result ordering.
const FEDERAL_REGISTER_CALIBRATION_HASH = "340778f74d27e93283068a0102495bc8a630c3ce78bddbf6cf998ef7c47c9943";
const MISSISSIPPI_DISCHARGE_PATTERN = /Mississippi River discharge at Baton Rouge at 12:00 UTC on Aug 16, 2026 be below 220,000 cfs/iu;
const MISSISSIPPI_DISCHARGE_URL = "https://waterservices.usgs.gov/nwis/iv/?format=json&sites=07374000&parameterCd=00060&period=P3D&siteStatus=all";
const MISSISSIPPI_FORECAST_START = Date.parse("2026-08-16T09:00:00.000Z");
const MISSISSIPPI_CALIBRATION_URL = "https://nwis.waterdata.usgs.gov/nwis/uv?cb_00060=on&format=rdb&site_no=07374000&period=&begin_date=2020-08-01&end_date=2026-08-13";
// SHA-256 of sorted `UTC timestamp|value|qualifier` rows from the fixed
// instantaneous-value query. At 09:00 UTC on 49 historical days the gauge was
// between 230k and 250k cfs and its preceding two-day change was at least -5%;
// none was below 220k at the contract-matching 12:00 UTC horizon three hours
// later. Laplace smoothing gives P(NO)=50/51 rather than a certainty claim.
const MISSISSIPPI_CALIBRATION_HASH = "5fa025c5d50acbeed43ee9293b0ad169073cdd964e1c2ab1657599d4219dd686";
const TOKYO_TEMPERATURE_PATTERN = /Tokyo's highest temperature on Aug 15, 2026.*above 31\.5 °C/iu;
const TOKYO_AMEDAS_STATION = "44132";
const TOKYO_OBSERVATION_START = Date.parse("2026-08-14T22:00:00.000Z");

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
  nominationCount: number | null;
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
    const content = /<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/u.exec(item)?.[1];
    let nominationCount: number | null = null;
    if (content !== undefined) {
      const header = /<p(?:\s[^>]*)?>\s*NOMINATIONS? SENT TO THE SENATE:\s*<\/p>/iu.exec(content);
      if (header) {
        const afterHeader = content.slice(header.index + header[0].length);
        const end = /<p(?:\s[^>]*)?>\s*(?:WITHDRAWALS?|APPOINTMENTS?)\b|<p(?:\s[^>]*)?>\s*The post\b/iu.exec(afterHeader)?.index ?? afterHeader.length;
        const nominationSection = afterHeader.slice(0, end);
        const entries = [...nominationSection.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/giu)]
          .map((entry) => xmlText(entry[1] ?? ""))
          // The White House's current feed uses one paragraph per nominee in
          // the stable form "Name, of Jurisdiction, to be Office". Ignore
          // explanatory/category prose; an unfamiliar nominee shape therefore
          // undercounts and fails closed rather than creating a false YES.
          .filter((entry) => /,\s+of\b[\s\S]*?,\s+to be\b/iu.test(entry));
        nominationCount = entries.length > 0 ? entries.length : null;
      }
    }
    return [{ publishedAt, title, nominationCount }];
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
  feedUrl: string;
  now: number;
}): Assessment | null {
  if (
    !TRUMP_NOMINATIONS_PATTERN.test(input.market.question) ||
    input.now < NOMINATIONS_FORECAST_START ||
    input.now >= Date.parse(input.market.resolvesAt ?? "1970-01-01")
  ) return null;

  const items = nominationFeedItems(input.feedBody);
  const latest = items.at(-1);
  if (!latest) return null;
  const inWindow = items.filter((item) =>
    item.publishedAt >= NOMINATIONS_WINDOW_START && item.publishedAt < NOMINATIONS_WINDOW_END
  );
  if (inWindow.some((item) => item.nominationCount === null)) return null;
  const inWindowCount = inWindow.reduce((total, item) => total + (item.nominationCount ?? 0), 0);
  if (inWindowCount >= 5) {
    const observedAt = new Date(input.now).toISOString();
    const expiry = Math.min(input.now + 10 * 60_000, Date.parse(input.market.resolvesAt!));
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
      rationale: `The White House official feed contains ${inWindowCount} individually enumerated nominations sent to the Senate during Aug 9-15, meeting the contract threshold.`,
      sources: [{
        url: input.feedUrl,
        kind: "authoritative",
        observedAt,
        valueHash: createHash("sha256").update(input.feedBody).digest("hex"),
      }],
    };
  }
  if (inWindow.length > 0 || latest.publishedAt !== Date.parse("2026-08-07T15:09:20.000Z")) return null;

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
      ? "The Aug 9-15 transmission window closed 12 hours ago and the White House official nominations feed still contains no in-window transmission."
      : `The White House official nominations feed has no transmission after Aug 7. Only Friday/Saturday remain; ${activeWindows} of ${windows} historical Friday/Saturday windows in the same feed contained any nomination release, giving a conservative Laplace-smoothed No probability of ${(probability * 100).toFixed(1)}%.`,
    sources: [{
      url: input.feedUrl,
      kind: "authoritative",
      observedAt,
      valueHash: createHash("sha256").update(input.feedBody).digest("hex"),
    }],
  };
}

export function assessFederalRegisterCount(input: {
  market: MarketView;
  body: string;
  sourceUrl: string;
  now: number;
}): Assessment | null {
  if (
    !FEDERAL_REGISTER_PATTERN.test(input.market.question) ||
    input.now >= Date.parse(input.market.resolvesAt ?? "1970-01-01")
  ) return null;

  let response: { count?: unknown; description?: unknown };
  try {
    response = JSON.parse(input.body) as typeof response;
  } catch {
    return null;
  }
  if (
    !Number.isInteger(response.count) ||
    (response.count as number) < 0 ||
    typeof response.description !== "string" ||
    !/Documents published from 08\/12\/2026 to 08\/18\/2026 and of type Presidential Document/u.test(response.description)
  ) return null;

  const observedAt = new Date(input.now).toISOString();
  const expiry = Math.min(input.now + 10 * 60_000, Date.parse(input.market.resolvesAt!));
  if (expiry <= input.now) return null;
  if ((response.count as number) < 6) {
    if (input.now < FEDERAL_REGISTER_NO_FORECAST_START || (response.count as number) > 2) return null;
    // Frozen before promotion: among the 40 preceding Wednesday-Tuesday
    // windows in the official API, 12 had no more than two documents by the
    // end of Friday and two of those later reached six. Laplace smoothing
    // gives P(YES)=3/14 and P(NO)=11/14. The fixed query and response hash make
    // this calibration independently reproducible without repeatedly fetching
    // a large historical response in production.
    const probability = 11 / 14;
    return {
      marketId: input.market.id,
      outcomeIndex: 1,
      evidenceClass: "forecast",
      probability,
      confidence: "medium",
      status: "actionable",
      observedAt,
      expiresAt: new Date(expiry).toISOString(),
      rationale: `The official API contains ${response.count as number} Presidential Documents after the Wednesday-Friday portion of the window. In the frozen 40-window calibration, 2 of 12 comparable weeks later reached six; Laplace-smoothed No probability is ${(probability * 100).toFixed(1)}%.`,
      sources: [{
        url: input.sourceUrl,
        kind: "authoritative",
        observedAt,
        valueHash: createHash("sha256").update(input.body).digest("hex"),
      }, {
        url: FEDERAL_REGISTER_CALIBRATION_URL,
        kind: "authoritative",
        observedAt: "2026-08-14T06:07:00.000Z",
        valueHash: FEDERAL_REGISTER_CALIBRATION_HASH,
      }],
    };
  }
  return {
    marketId: input.market.id,
    outcomeIndex: 0,
    evidenceClass: "published_result",
    probability: 0.99,
    confidence: "high",
    status: "actionable",
    observedAt,
    expiresAt: new Date(expiry).toISOString(),
    rationale: `The Federal Register official API already contains ${response.count as number} Presidential Documents with publication dates in the contract window, meeting the threshold before trading closes.`,
    sources: [{
      url: input.sourceUrl,
      kind: "authoritative",
      observedAt,
      valueHash: createHash("sha256").update(input.body).digest("hex"),
    }],
  };
}

export function assessTokyoObservedTemperature(input: {
  market: MarketView;
  body: string;
  sourceUrl: string;
  sourceObservedAt: number;
  now: number;
}): Assessment | null {
  const closeAt = Date.parse(input.market.resolvesAt ?? "1970-01-01");
  if (
    !TOKYO_TEMPERATURE_PATTERN.test(input.market.question) ||
    input.now < TOKYO_OBSERVATION_START ||
    input.now >= closeAt ||
    input.sourceObservedAt < TOKYO_OBSERVATION_START ||
    input.sourceObservedAt > input.now ||
    input.now - input.sourceObservedAt > 20 * 60_000
  ) return null;

  let map: Record<string, unknown>;
  try {
    map = JSON.parse(input.body) as Record<string, unknown>;
  } catch {
    return null;
  }
  const station = map[TOKYO_AMEDAS_STATION];
  if (!station || typeof station !== "object") return null;
  const temp = (station as { temp?: unknown }).temp;
  if (
    !Array.isArray(temp) ||
    temp.length !== 2 ||
    typeof temp[0] !== "number" ||
    !Number.isFinite(temp[0]) ||
    temp[1] !== 0 ||
    temp[0] <= 31.5
  ) return null;

  const observedAt = new Date(input.now).toISOString();
  const expiry = Math.min(input.now + 10 * 60_000, closeAt);
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
    rationale: `JMA's official AMeDAS observation for Tokyo station ${TOKYO_AMEDAS_STATION} reports ${temp[0]} °C on Aug 15 JST. Crossing 31.5 °C makes the contract's daily-high YES condition irreversible before trading closes.`,
    sources: [{
      url: input.sourceUrl,
      kind: "authoritative",
      observedAt: new Date(input.sourceObservedAt).toISOString(),
      valueHash: createHash("sha256").update(input.body).digest("hex"),
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

export function assessMississippiDischarge(input: {
  market: MarketView;
  body: string;
  sourceUrl: string;
  now: number;
}): Assessment | null {
  if (
    !MISSISSIPPI_DISCHARGE_PATTERN.test(input.market.question) ||
    input.now < MISSISSIPPI_FORECAST_START ||
    input.now >= Date.parse(input.market.resolvesAt ?? "1970-01-01")
  ) return null;

  let response: unknown;
  try {
    response = JSON.parse(input.body) as unknown;
  } catch {
    return null;
  }
  if (!response || typeof response !== "object") return null;
  const value = (response as { value?: unknown }).value;
  if (!value || typeof value !== "object") return null;
  const timeSeries = (value as { timeSeries?: unknown }).timeSeries;
  if (!Array.isArray(timeSeries) || timeSeries.length !== 1) return null;
  const series = timeSeries[0];
  if (!series || typeof series !== "object") return null;
  const sourceInfo = (series as { sourceInfo?: unknown }).sourceInfo;
  const variable = (series as { variable?: unknown }).variable;
  const groups = (series as { values?: unknown }).values;
  if (!sourceInfo || typeof sourceInfo !== "object" || !variable || typeof variable !== "object" || !Array.isArray(groups)) return null;
  const siteCode = (sourceInfo as { siteCode?: unknown }).siteCode;
  const variableCode = (variable as { variableCode?: unknown }).variableCode;
  if (
    !Array.isArray(siteCode) || siteCode.length !== 1 ||
    !siteCode[0] || typeof siteCode[0] !== "object" ||
    (siteCode[0] as { value?: unknown }).value !== "07374000" ||
    !Array.isArray(variableCode) || variableCode.length !== 1 ||
    !variableCode[0] || typeof variableCode[0] !== "object" ||
    (variableCode[0] as { value?: unknown }).value !== "00060"
  ) return null;

  const observations = groups.flatMap((group) => {
    if (!group || typeof group !== "object") return [];
    const rows = (group as { value?: unknown }).value;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const dateTime = (row as { dateTime?: unknown }).dateTime;
      const rawValue = (row as { value?: unknown }).value;
      const qualifiers = (row as { qualifiers?: unknown }).qualifiers;
      const timestamp = typeof dateTime === "string" ? Date.parse(dateTime) : Number.NaN;
      const discharge = typeof rawValue === "string" ? Number(rawValue) : Number.NaN;
      if (
        !Number.isFinite(timestamp) || timestamp > input.now ||
        !Number.isFinite(discharge) || discharge < 0 ||
        !Array.isArray(qualifiers) || !qualifiers.every((entry) => entry === "P" || entry === "A")
      ) return [];
      return [{ timestamp, discharge }];
    });
  }).sort((left, right) => left.timestamp - right.timestamp);
  const sourceLatest = observations.at(-1);
  if (!sourceLatest || input.now - sourceLatest.timestamp > 30 * 60_000) return null;
  const observationTimestamp = Date.parse("2026-08-16T09:00:00.000Z");
  const baselineTimestamp = observationTimestamp - 48 * 60 * 60_000;
  const matching = observations.filter((observation) => observation.timestamp === observationTimestamp);
  const baselines = observations.filter((observation) => observation.timestamp === baselineTimestamp);
  if (matching.length !== 1 || baselines.length !== 1) return null;
  const observation = matching[0]!;
  const baseline = baselines[0]!;
  const twoDayChange = observation.discharge / baseline.discharge - 1;
  const postObservationChange = sourceLatest.discharge / observation.discharge - 1;
  if (
    observation.discharge < 230_000 || observation.discharge > 250_000 ||
    twoDayChange < -0.05 || sourceLatest.discharge < 230_000 || postObservationChange < -0.02
  ) return null;

  const probability = 50 / 51;
  const observedAt = new Date(input.now).toISOString();
  const expiry = Math.min(input.now + 10 * 60_000, Date.parse(input.market.resolvesAt!));
  if (expiry <= input.now) return null;
  return {
    marketId: input.market.id,
    outcomeIndex: 1,
    evidenceClass: "forecast",
    probability,
    confidence: "high",
    status: "actionable",
    observedAt,
    expiresAt: new Date(expiry).toISOString(),
    rationale: `The USGS Baton Rouge gauge reports ${observation.discharge.toLocaleString("en-US")} cfs at 09:00 UTC with a two-day change of ${(twoDayChange * 100).toFixed(1)}%, inside the frozen comparable regime. All 49 matching historical 09:00 UTC states remained at or above 220,000 cfs at 12:00 UTC; Laplace-smoothed No probability is ${(probability * 100).toFixed(1)}%.`,
    sources: [{
      url: input.sourceUrl,
      kind: "authoritative",
      observedAt,
      valueHash: createHash("sha256").update(input.body).digest("hex"),
    }, {
      url: MISSISSIPPI_CALIBRATION_URL,
      kind: "authoritative",
      observedAt: "2026-08-14T06:30:00.000Z",
      valueHash: MISSISSIPPI_CALIBRATION_HASH,
    }],
  };
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
    if (MISSISSIPPI_DISCHARGE_PATTERN.test(market.question)) {
      try {
        if (now < MISSISSIPPI_FORECAST_START || now >= Date.parse(market.resolvesAt ?? "1970-01-01")) continue;
        const response = await fetch(MISSISSIPPI_DISCHARGE_URL, {
          headers: { "user-agent": "Conviction-Delphi-Arena/1.0" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) continue;
        const assessment = assessMississippiDischarge({
          market,
          body: await response.text(),
          sourceUrl: MISSISSIPPI_DISCHARGE_URL,
          now,
        });
        if (assessment) assessments.push(assessment);
      } catch {
        continue;
      }
      continue;
    }
    if (TOKYO_TEMPERATURE_PATTERN.test(market.question)) {
      try {
        if (now < TOKYO_OBSERVATION_START || now >= Date.parse(market.resolvesAt ?? "1970-01-01")) continue;
        const sourceObservedAt = Math.floor((now - 10 * 60_000) / (10 * 60_000)) * 10 * 60_000;
        const stamp = new Date(sourceObservedAt).toISOString().replace(/[-:T]/gu, "").slice(0, 14);
        const sourceUrl = `https://www.jma.go.jp/bosai/amedas/data/map/${stamp}.json`;
        const response = await fetch(sourceUrl, {
          headers: { "user-agent": "Conviction-Delphi-Arena/1.0" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) continue;
        const assessment = assessTokyoObservedTemperature({
          market,
          body: await response.text(),
          sourceUrl,
          sourceObservedAt,
          now,
        });
        if (assessment) assessments.push(assessment);
      } catch {
        continue;
      }
      continue;
    }
    if (FEDERAL_REGISTER_PATTERN.test(market.question)) {
      try {
        const response = await fetch(FEDERAL_REGISTER_URL, {
          headers: { "user-agent": "Conviction-Delphi-Arena/1.0" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) continue;
        const assessment = assessFederalRegisterCount({
          market,
          body: await response.text(),
          sourceUrl: FEDERAL_REGISTER_URL,
          now,
        });
        if (assessment) assessments.push(assessment);
      } catch {
        continue;
      }
      continue;
    }
    if (TRUMP_NOMINATIONS_PATTERN.test(market.question)) {
      try {
        const feedResponse = await fetch(WHITE_HOUSE_NOMINATIONS_FEED_URL, {
          headers: { "user-agent": "Conviction-Delphi-Arena/1.0" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!feedResponse.ok) continue;
        const assessment = assessTrumpNominations({
          market,
          feedBody: await feedResponse.text(),
          feedUrl: WHITE_HOUSE_NOMINATIONS_FEED_URL,
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
