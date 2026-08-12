import { describe, expect, it } from "vitest";
import type { MarketView } from "../src/model.js";
import { assessArcticExtent, assessSilsoSunspot } from "../src/official-assessors.js";

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
