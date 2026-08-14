import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketView } from "../src/model.js";
import {
  assessArcticExtent,
  assessCrs35Schedule,
  assessFederalRegisterCount,
  assessMamdaniExecutiveOrder,
  assessSilsoSunspot,
  assessTokyoObservedTemperature,
  assessTrumpNominations,
  firstSuccessfulAssessment,
  generateOfficialAssessments,
} from "../src/official-assessors.js";

afterEach(() => vi.unstubAllGlobals());

const MARKET: MarketView = {
  id: "0x1111111111111111111111111111111111111111",
  question: "Will NSIDC Arctic sea ice extent for 2026-08-12 (UTC) be below 5.88 million km²?",
  outcomes: ["Yes", "No"],
  status: "open",
  resolvesAt: "2026-08-13T08:00:00.000Z",
  prices: [0.65, 0.35],
  tradingFeePct: 0.5,
  dataSources: [],
};

describe("NSIDC empirical assessment", () => {
  it("uses only prior same-horizon changes and produces hashed authoritative evidence", () => {
    const values: Record<string, number> = {};
    const start = Date.parse("2026-07-01T00:00:00.000Z");
    for (let index = 0; index < 41; index += 1) {
      values[new Date(start + index * 86_400_000).toISOString().slice(0, 10)] = 7 - index * 0.0276;
    }
    values["2026-08-10"] = 5.896;
    const assessment = assessArcticExtent({
      market: MARKET,
      body: JSON.stringify(values),
      sourceUrl: "https://nsidc.org/official.json",
      now: Date.parse("2026-08-11T21:00:00.000Z"),
    });
    expect(assessment?.outcomeIndex).toBe(0);
    expect(assessment?.evidenceClass).toBe("forecast");
    expect(assessment?.probability).toBeGreaterThan(0.9);
    expect(assessment?.confidence).toBe("high");
    expect(assessment?.sources[0]?.valueHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses sparse history", () => {
    const body = JSON.stringify({ "2026-08-09": 6.0, "2026-08-10": 5.896 });
    expect(assessArcticExtent({ market: MARKET, body, sourceUrl: "https://nsidc.org/official.json", now: Date.parse("2026-08-11T21:00:00.000Z") })).toBeNull();
  });

  it("selects No with 0.99 probability when the exact target-date value is above the threshold", () => {
    const assessment = assessArcticExtent({
      market: MARKET,
      body: JSON.stringify({ "2026-08-12": 5.9 }),
      sourceUrl: "https://nsidc.org/official.json",
      now: Date.parse("2026-08-12T12:00:00.000Z"),
    });
    expect(assessment?.outcomeIndex).toBe(1);
    expect(assessment?.evidenceClass).toBe("published_result");
    expect(assessment?.probability).toBe(0.99);
  });
});

const SILSO_MARKET: MarketView = {
  id: "0x2222222222222222222222222222222222222222",
  question: "Will the SILSO estimated sunspot number for 2026-08-12 UTC be 40 or higher?",
  outcomes: ["Yes", "No"],
  status: "open",
  resolvesAt: "2026-08-13T00:00:00.000Z",
  prices: [0.9, 0.1],
  tradingFeePct: 0.5,
  dataSources: [],
};

describe("SILSO exact release assessment", () => {
  it("selects the resolved outcome from the official target-date row", () => {
    const body = [
      "2026, 08, 11, 2026.610, 44, 11.4, 30, 33,",
      "2026, 08, 12, 2026.612, 74, 9.2, 25, 28,",
    ].join("\n");
    const assessment = assessSilsoSunspot({
      market: SILSO_MARKET,
      body,
      sourceUrl: "https://www.sidc.be/SILSO/DATA/EISN/EISN_current.csv",
      now: Date.parse("2026-08-12T14:00:00.000Z"),
    });
    expect(assessment?.outcomeIndex).toBe(0);
    expect(assessment?.evidenceClass).toBe("published_result");
    expect(assessment?.probability).toBe(0.99);
    expect(assessment?.rationale).toContain("74");
    expect(assessment?.sources[0]?.valueHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses to infer the target value before its row is published", () => {
    const body = "2026, 08, 11, 2026.610, 44, 11.4, 30, 33,";
    expect(assessSilsoSunspot({
      market: SILSO_MARKET,
      body,
      sourceUrl: "https://www.sidc.be/SILSO/DATA/EISN/EISN_current.csv",
      now: Date.parse("2026-08-12T14:00:00.000Z"),
    })).toBeNull();
  });

  it("selects No when the exact official value is below the threshold", () => {
    const body = "2026, 08, 12, 2026.612, 39, 9.2, 25, 28,";
    const assessment = assessSilsoSunspot({
      market: SILSO_MARKET,
      body,
      sourceUrl: "https://www.sidc.be/SILSO/DATA/EISN/EISN_current.csv",
      now: Date.parse("2026-08-12T14:00:00.000Z"),
    });
    expect(assessment?.outcomeIndex).toBe(1);
    expect(assessment?.probability).toBe(0.99);
  });
});

const FEDERAL_REGISTER_MARKET: MarketView = {
  id: "0x9999999999999999999999999999999999999999",
  question: "Will the Federal Register publish 6+ Presidential documents with publication dates Aug 12-18, 2026?",
  outcomes: ["Yes", "No"],
  status: "open",
  resolvesAt: "2026-08-18T12:00:00.000Z",
  prices: [0.43, 0.57],
  tradingFeePct: 0.5,
  dataSources: [],
};

describe("Federal Register exact-count release", () => {
  const sourceUrl = "https://www.federalregister.gov/api/v1/documents.json";
  const now = Date.parse("2026-08-14T05:00:00.000Z");
  const body = (count: number, description = "Documents published from 08/12/2026 to 08/18/2026 and of type Presidential Document") =>
    JSON.stringify({ count, description });

  it("selects Yes only after the official published count reaches six", () => {
    const assessment = assessFederalRegisterCount({ market: FEDERAL_REGISTER_MARKET, body: body(6), sourceUrl, now });
    expect(assessment?.outcomeIndex).toBe(0);
    expect(assessment?.evidenceClass).toBe("published_result");
    expect(assessment?.probability).toBe(0.99);
    expect(assessment?.rationale).toContain("6 Presidential Documents");
  });

  it("refuses a forecast, malformed scope, or post-close count", () => {
    expect(assessFederalRegisterCount({ market: FEDERAL_REGISTER_MARKET, body: body(5), sourceUrl, now })).toBeNull();
    expect(assessFederalRegisterCount({ market: FEDERAL_REGISTER_MARKET, body: body(6, "different query"), sourceUrl, now })).toBeNull();
    expect(assessFederalRegisterCount({ market: FEDERAL_REGISTER_MARKET, body: body(6), sourceUrl, now: Date.parse(FEDERAL_REGISTER_MARKET.resolvesAt!) })).toBeNull();
  });
});

const TOKYO_MARKET: MarketView = {
  id: "0x8888888888888888888888888888888888888888",
  question: "Will Tokyo's highest temperature on Aug 15, 2026 (Japan Standard Time) be above 31.5 °C?",
  outcomes: ["Yes", "No"],
  status: "open",
  resolvesAt: "2026-08-15T04:00:00.000Z",
  prices: [0.27, 0.73],
  tradingFeePct: 0.5,
  dataSources: [],
};

describe("JMA Tokyo irreversible temperature crossing", () => {
  const now = Date.parse("2026-08-15T02:12:00.000Z");
  const sourceObservedAt = Date.parse("2026-08-15T02:00:00.000Z");
  const sourceUrl = "https://www.jma.go.jp/bosai/amedas/data/map/20260815020000.json";
  const body = (temperature: number, quality = 0) => JSON.stringify({ "44132": { temp: [temperature, quality] } });

  it("selects Yes after a quality-zero Tokyo reading crosses 31.5 °C", () => {
    const assessment = assessTokyoObservedTemperature({ market: TOKYO_MARKET, body: body(31.6), sourceUrl, sourceObservedAt, now });
    expect(assessment?.outcomeIndex).toBe(0);
    expect(assessment?.evidenceClass).toBe("published_result");
    expect(assessment?.probability).toBe(0.99);
    expect(assessment?.rationale).toContain("31.6 °C");
  });

  it("refuses a non-crossing, suspect, stale, pre-window, or post-close reading", () => {
    expect(assessTokyoObservedTemperature({ market: TOKYO_MARKET, body: body(31.5), sourceUrl, sourceObservedAt, now })).toBeNull();
    expect(assessTokyoObservedTemperature({ market: TOKYO_MARKET, body: body(32, 1), sourceUrl, sourceObservedAt, now })).toBeNull();
    expect(assessTokyoObservedTemperature({ market: TOKYO_MARKET, body: body(32), sourceUrl, sourceObservedAt: now - 21 * 60_000, now })).toBeNull();
    expect(assessTokyoObservedTemperature({ market: TOKYO_MARKET, body: body(32), sourceUrl, sourceObservedAt: Date.parse("2026-08-14T21:50:00.000Z"), now: Date.parse("2026-08-14T21:59:00.000Z") })).toBeNull();
    expect(assessTokyoObservedTemperature({ market: TOKYO_MARKET, body: body(32), sourceUrl, sourceObservedAt, now: Date.parse(TOKYO_MARKET.resolvesAt!) })).toBeNull();
  });
});

const CRS_MARKET: MarketView = {
  id: "0x3333333333333333333333333333333333333333",
  question: "Will SpaceX launch the Dragon CRS-35 cargo mission before 00:00 UTC on Aug 14, 2026?",
  outcomes: ["Yes", "No"],
  status: "open",
  resolvesAt: "2026-08-14T03:59:00.000Z",
  prices: [0.1, 0.9],
  tradingFeePct: 0.5,
  dataSources: [],
};

describe("NASA CRS-35 official schedule assessment", () => {
  const sourceUrl = "https://www.nasa.gov/event/nasas-spacex-crs-35/";
  const now = Date.parse("2026-08-12T14:00:00.000Z");

  it("selects No only when the official event date is after the deadline", () => {
    const body = '<h1>NASA’s SpaceX CRS-35</h1><span data-event-start-date="2026-12-31T23:59:00-05:00">No Earlier Than Fall 2026</span>';
    const assessment = assessCrs35Schedule({ market: CRS_MARKET, body, sourceUrl, now });
    expect(assessment?.outcomeIndex).toBe(1);
    expect(assessment?.evidenceClass).toBe("official_schedule");
    expect(assessment?.probability).toBe(0.99);
    expect(assessment?.sources[0]?.valueHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    '<h1>NASA’s SpaceX CRS-35</h1><span data-event-start-date="2026-12-31T23:59:00-05:00">Schedule pending</span>',
    '<h1>NASA’s SpaceX CRS-35</h1><span>No Earlier Than Fall 2026</span>',
    '<h1>NASA’s SpaceX CRS-35</h1><span data-event-start-date="2026-08-13T23:00:00Z">No Earlier Than Fall 2026</span>',
  ])("refuses missing or contradictory schedule evidence", (body) => {
    expect(assessCrs35Schedule({ market: CRS_MARKET, body, sourceUrl, now })).toBeNull();
  });

  it("isolates a failed source so another market can still be assessed", async () => {
    const body = '<h1>NASA’s SpaceX CRS-35</h1><span data-event-start-date="2026-12-31T23:59:00-05:00">No Earlier Than Fall 2026</span>';
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("sidc.be")) throw new Error("source timeout");
      return new Response(body, { status: 200 });
    }));
    const assessments = await generateOfficialAssessments([SILSO_MARKET, CRS_MARKET], now);
    expect(assessments).toHaveLength(1);
    expect(assessments[0]?.marketId).toBe(CRS_MARKET.id);
  });
});

const MAMDANI_MARKET: MarketView = {
  id: "0x4444444444444444444444444444444444444444",
  question: "Will a Mamdani non-emergency NYC executive order dated Aug 9-15, 2026 be publicly posted by settlement?",
  outcomes: ["Yes", "No"],
  status: "open",
  resolvesAt: "2026-08-16T13:59:00.000Z",
  prices: [0.31, 0.69],
  tradingFeePct: 0.5,
  dataSources: [],
};

describe("NYC non-emergency executive-order release", () => {
  const now = Date.parse("2026-08-13T12:00:00.000Z");
  const sourceUrl = "https://www.nyc.gov/bin/nyc/articlesearch.json?pageSize=100&currentPage=1&types=executive-orders&fromDate=2026-08-09&toDate=2026-08-15";
  const detailUrl = "https://www.nyc.gov/mayors-office/news/2026/08/executive-order-no--20.html";
  const pdfUrl = "https://www.nyc.gov/content/dam/nycgov/mayors-office/downloads/pdf/executive-orders/2026/eo-20.pdf";
  const pdfText = "THE CITY OF NEW YORK OFFICE OF THE MAYOR EXECUTIVE ORDER No. 20 August 13, 2026 A BOUNDED ORDER Zahran Kwame Mamdani Mayor";

  it("requires the index, matching detail page, and same-number signed official PDF", async () => {
    const pdfBody = new TextEncoder().encode(pdfText);
    const assessment = await assessMamdaniExecutiveOrder({
      market: MAMDANI_MARKET,
      searchBody: JSON.stringify({ results: [{
        link: "/mayors-office/news/2026/08/executive-order-no--20.html",
        title: "Executive Order No. 20",
        articleDate: "August 13, 2026",
      }] }),
      detailBody: '<h1 class="headline">Executive Order No. 20</h1><a href="/content/dam/nycgov/mayors-office/downloads/pdf/executive-orders/2026/eo-20.pdf">Download</a>',
      pdfBody,
      pdfText,
      sourceUrl,
      detailUrl,
      pdfUrl,
      now,
    });
    expect(assessment?.outcomeIndex).toBe(0);
    expect(assessment?.evidenceClass).toBe("published_result");
    expect(assessment?.probability).toBe(0.99);
  });

  it("refuses absence, emergency orders, and a mismatched PDF", async () => {
    const pdfBody = new TextEncoder().encode(pdfText);
    const base = {
      market: MAMDANI_MARKET,
      detailBody: '<h1>Executive Order No. 20</h1><a href="/content/dam/nycgov/mayors-office/downloads/pdf/executive-orders/2026/eo-20.pdf">Download</a>',
      pdfBody,
      pdfText,
      sourceUrl,
      detailUrl,
      pdfUrl,
      now,
    };
    expect(await assessMamdaniExecutiveOrder({ ...base, searchBody: JSON.stringify({ results: [] }) })).toBeNull();
    expect(await assessMamdaniExecutiveOrder({ ...base, searchBody: JSON.stringify({ results: [{ link: "/mayors-office/news/2026/08/emergency-executive-order-no--1-44.html", title: "Emergency Executive Order No. 1.44", articleDate: "August 13, 2026" }] }) })).toBeNull();
    const match = { link: "/mayors-office/news/2026/08/executive-order-no--20.html", title: "Executive Order No. 20", articleDate: "August 13, 2026" };
    expect(await assessMamdaniExecutiveOrder({ ...base, pdfText: "EXECUTIVE ORDER No. 19 July 23, 2026 Zahran Kwame Mamdani Mayor", searchBody: JSON.stringify({ results: [match] }) })).toBeNull();
  });

  it("accepts the matching official order when the city publishes more than one in the window", async () => {
    const match = { link: "/mayors-office/news/2026/08/executive-order-no--20.html", title: "Executive Order No. 20", articleDate: "August 13, 2026" };
    const other = { link: "/mayors-office/news/2026/08/executive-order-no--21.html", title: "Executive Order No. 21", articleDate: "August 14, 2026" };
    expect(await assessMamdaniExecutiveOrder({
      market: MAMDANI_MARKET,
      searchBody: JSON.stringify({ results: [other, match] }),
      detailBody: '<h1>Executive Order No. 20</h1><a href="/content/dam/nycgov/mayors-office/downloads/pdf/executive-orders/2026/eo-20.pdf">Download</a>',
      pdfBody: new TextEncoder().encode(pdfText),
      pdfText,
      sourceUrl,
      detailUrl,
      pdfUrl,
      now,
    })).not.toBeNull();
  });
});

describe("official-result fault isolation", () => {
  it("continues after one official record fails and returns the next valid assessment", async () => {
    const expected = { marketId: MAMDANI_MARKET.id } as never;
    const assessment = await firstSuccessfulAssessment(["broken", "valid"], async (item) => {
      if (item === "broken") throw new Error("malformed PDF");
      return expected;
    });
    expect(assessment).toBe(expected);
  });
});

const NOMINATIONS_MARKET: MarketView = {
  id: "0x5555555555555555555555555555555555555555",
  question: "Will Trump send at least 5 nominations to the US Senate during Aug 9-15, 2026?",
  outcomes: ["Yes", "No"],
  status: "open",
  resolvesAt: "2026-08-16T14:00:00.000Z",
  prices: [0.26, 0.74],
  tradingFeePct: 0.5,
  dataSources: [],
};

function nominationsFeed(extra = ""): string {
  const items: string[] = [];
  const start = Date.parse("2025-04-01T15:00:00.000Z");
  for (let index = 0; index < 70; index += 1) {
    const date = new Date(start + index * 7 * 86_400_000);
    items.push(`<item><title>Nominations Sent to the Senate</title><pubDate>${date.toUTCString()}</pubDate></item>`);
  }
  items.push('<item><title>Nominations Sent to the Senate</title><pubDate>Fri, 07 Aug 2026 15:09:20 +0000</pubDate></item>');
  return `<rss><channel>${items.join("")}${extra}</channel></rss>`;
}

function nominationRelease(input: { publishedAt: string; names: string[] }): string {
  return `<item><title>Nominations Sent to the Senate</title><pubDate>${new Date(input.publishedAt).toUTCString()}</pubDate><content:encoded><![CDATA[
    <p class="has-text-align-left">NOMINATIONS SENT TO THE SENATE:</p>
    ${input.names.map((name) => `<p>${name}, of Virginia, to be an Assistant Secretary.</p>`).join("")}
    <p>The post <a href="https://www.whitehouse.gov/">Nominations Sent to the Senate</a> appeared first on The White House.</p>
  ]]></content:encoded></item>`;
}

describe("White House/Senate nominations forecast", () => {
  const base = {
    market: NOMINATIONS_MARKET,
    feedUrl: "https://www.whitehouse.gov/feed/",
    now: Date.parse("2026-08-14T05:00:00.000Z"),
  };

  it("selects No from the current and historical authoritative White House feed", () => {
    const assessment = assessTrumpNominations({ ...base, feedBody: nominationsFeed() });
    expect(assessment?.outcomeIndex).toBe(1);
    expect(assessment?.evidenceClass).toBe("forecast");
    expect(assessment?.probability).toBeGreaterThan(0.9);
    expect(assessment?.sources).toHaveLength(1);
  });

  it("refuses a new in-window White House release below the threshold", () => {
    const extra = nominationRelease({
      publishedAt: "2026-08-14T15:00:00.000Z",
      names: ["Alice One", "Bob Two", "Carol Three", "David Four"],
    });
    expect(assessTrumpNominations({ ...base, feedBody: nominationsFeed(extra) })).toBeNull();
  });

  it("selects Yes as a published result after five enumerated in-window nominations", () => {
    const extra = nominationRelease({
      publishedAt: "2026-08-14T15:00:00.000Z",
      names: ["Alice One", "Bob Two", "Carol Three", "David Four", "Eve Five"],
    });
    const assessment = assessTrumpNominations({ ...base, feedBody: nominationsFeed(extra) });
    expect(assessment?.outcomeIndex).toBe(0);
    expect(assessment?.evidenceClass).toBe("published_result");
    expect(assessment?.probability).toBe(0.99);
    expect(assessment?.rationale).toContain("5 individually enumerated nominations");
  });

  it("adds nominations across multiple in-window releases", () => {
    const extra = [
      nominationRelease({ publishedAt: "2026-08-14T15:00:00.000Z", names: ["Alice One", "Bob Two"] }),
      nominationRelease({ publishedAt: "2026-08-15T15:00:00.000Z", names: ["Carol Three", "David Four", "Eve Five"] }),
    ].join("");
    const assessment = assessTrumpNominations({ ...base, feedBody: nominationsFeed(extra) });
    expect(assessment?.outcomeIndex).toBe(0);
    expect(assessment?.evidenceClass).toBe("published_result");
  });

  it("fails closed when an in-window release cannot be enumerated", () => {
    const extra = '<item><title>Nominations Sent to the Senate</title><pubDate>Fri, 14 Aug 2026 15:00:00 +0000</pubDate></item>';
    expect(assessTrumpNominations({ ...base, feedBody: nominationsFeed(extra) })).toBeNull();
  });

  it("refuses before the final Friday/Saturday window", () => {
    expect(assessTrumpNominations({ ...base, feedBody: nominationsFeed(), now: Date.parse("2026-08-13T23:59:59.000Z") })).toBeNull();
  });

  it("pauses for ingestion after the window, then promotes the official absence to a published result", () => {
    expect(assessTrumpNominations({
      ...base,
      feedBody: nominationsFeed(),
      now: Date.parse("2026-08-16T11:59:59.000Z"),
    })).toBeNull();
    const result = assessTrumpNominations({
      ...base,
      feedBody: nominationsFeed(),
      now: Date.parse("2026-08-16T12:00:00.000Z"),
    });
    expect(result?.evidenceClass).toBe("published_result");
    expect(result?.probability).toBe(0.99);
    expect(result?.outcomeIndex).toBe(1);
  });
});
