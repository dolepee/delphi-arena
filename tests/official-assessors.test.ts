import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketView } from "../src/model.js";
import {
  assessArcticExtent,
  assessCrs35Schedule,
  assessMamdaniExecutiveOrder,
  assessSilsoSunspot,
  assessTyphoonDolphin,
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

const DOLPHIN_MARKET: MarketView = {
  id: "0x5555555555555555555555555555555555555555",
  question: "Will Typhoon Dolphin hit Japan as a Very Strong Typhoon (85-104 kt, JMA 10-min mean) by Aug 16, 2026 09:00 UTC?",
  outcomes: ["Yes", "No"],
  status: "open",
  resolvesAt: "2026-08-15T23:59:00.000Z",
  prices: [0.31, 0.69],
  tradingFeePct: 0.5,
  dataSources: [],
};

describe("JMA Dolphin completed-track assessment", () => {
  const pdfUrl = "https://www.data.jma.go.jp/typhoon/data/T2613.pdf";
  const gsiUrl = "https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=26.7100&lon=128.0100";
  const pdfText = "2026年台風第13号 DOLPHIN (2613) 位 置 表 8 7 07 27.3 N 129.4 E 950 40 08 27.2 129.2 950 40 15 26.7 128.0 935 45 NE: 330 SW: 185 16 26.8 128.1 935 45 NE: 330 SW: 185";
  const gsiBody = JSON.stringify({ results: { muniCd: "47306", lv01Nm: "字古宇利" } });
  const now = Date.parse("2026-08-13T20:00:00.000Z");

  it("selects Yes when the official track crosses Kouri inside the required wind band", () => {
    const assessment = assessTyphoonDolphin({
      market: DOLPHIN_MARKET,
      pdfBody: new TextEncoder().encode(pdfText),
      pdfText,
      pdfUrl,
      gsiBody,
      gsiUrl,
      now,
    });
    expect(assessment?.outcomeIndex).toBe(0);
    expect(assessment?.evidenceClass).toBe("published_result");
    expect(assessment?.probability).toBe(0.99);
    expect(assessment?.sources).toHaveLength(2);
    expect(assessment?.sources[1]?.valueHash).not.toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("refuses a non-crossing track or a coordinate outside the official locality", () => {
    const base = { market: DOLPHIN_MARKET, pdfBody: new TextEncoder().encode(pdfText), pdfText, pdfUrl, gsiBody, gsiUrl, now };
    expect(assessTyphoonDolphin({ ...base, pdfText: "2026年台風第13号 DOLPHIN (2613) 位 置 表 8 7 07 27.3 N 129.4 E 950 40 15 26.7 128.0 935 40 16 26.8 128.1 935 40" })).toBeNull();
    expect(assessTyphoonDolphin({ ...base, pdfText: "2026年台風第13号 DOLPHIN (2613) 位 置 表 8 17 07 27.3 N 129.4 E 950 40 15 26.7 128.0 935 45 16 26.8 128.1 935 45" })).toBeNull();
    expect(assessTyphoonDolphin({ ...base, gsiBody: JSON.stringify({ results: { muniCd: "47301", lv01Nm: "別の場所" } }) })).toBeNull();
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
