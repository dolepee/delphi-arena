import { describe, expect, it } from "vitest";
import type { Candidate, Policy } from "../src/model.js";
import { isPlanExecutableAt, isPlanWithinBookLimits, quoteCandidates } from "../src/engine.js";

const policy: Policy = {
  competitionEndsAt: "2026-08-23T23:59:00.000Z", minimumStartingTst: 1000, minimumGasEth: 0.001,
  minimumNetEdge: 0.08, minimumPublishedResultNetEdge: 0.02, minimumOfficialScheduleNetEdge: 0.04,
  maximumMarketAllocationPct: 35, maximumPortfolioAllocationPct: 90, maximumOrderTst: 250,
  maximumPublishedResultMarketAllocationPct: 85, maximumPublishedResultPortfolioAllocationPct: 95,
  maximumPublishedResultOrderTst: 850, minimumFullOrderTst: 5, maximumPriceImpact: 0.04,
  maximumPublishedResultPriceImpact: 0.2, slippagePct: 2, maximumNewTradesPerCycle: 1,
  minimumEvidenceSources: 1, maximumAssessmentAgeMinutes: 30, canaryMaximumTst: 1, qualificationFallback: "none",
};

function candidate(id: string, probability: number, spotPrice: number): Candidate {
  const marketId = `0x${id.repeat(40)}` as `0x${string}`;
  return {
    spotPrice,
    rawEdge: probability - spotPrice,
    existingMarketValue: 0,
    existingMarketShares: 0,
    existingPortfolioShares: 0,
    market: { id: marketId, question: id, outcomes: ["Yes", "No"], status: "open", resolvesAt: "2026-08-14T00:00:00Z", prices: [spotPrice, 1 - spotPrice], tradingFeePct: 0.5, dataSources: [] },
    assessment: { marketId, outcomeIndex: 0, evidenceClass: "forecast", probability, confidence: "high", status: "actionable", observedAt: "2026-08-13T11:00:00Z", expiresAt: "2026-08-13T12:30:00Z", rationale: "Authoritative evidence supports this bounded forecast.", sources: [{ url: "https://example.com", kind: "authoritative", observedAt: "2026-08-13T11:00:00Z", valueHash: id.repeat(64) }] },
  };
}

describe("candidate quote isolation", () => {
  it("keeps a valid candidate when other quotes fail validation or throw", async () => {
    const small = candidate("a", 0.95, 0.6);
    const large = candidate("b", 0.82, 0.65);
    const failed = candidate("c", 0.95, 0.6);
    const client = { quoteBuy: async ({ marketAddress, sharesOut }: { marketAddress: string; sharesOut: bigint }) => {
      if (marketAddress === failed.market.id) throw new Error("upstream quote failed");
      const shares = Number(sharesOut) / 1e18;
      const price = marketAddress === small.market.id ? 0.7 : 0.675;
      return { tokensIn: BigInt(Math.ceil(shares * price * 1e6)) };
    } };
    const result = await quoteCandidates({
      client: client as never,
      candidates: [small, large, failed],
      policy,
      book: { totalEquityTst: 1000, availableTst: 250, deployedValueTst: 0 } as never,
      mode: "full",
    });
    expect(result.quoteFailures).toHaveLength(1);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]?.market.id).toBe(large.market.id);
  });
});

describe("pre-write freshness", () => {
  const plan = {
    assessment: {
      observedAt: "2026-08-13T11:32:00.000Z",
      expiresAt: "2026-08-13T12:02:00.000Z",
    },
    market: { resolvesAt: "2026-08-14T00:00:00.000Z" },
  };

  it("refuses a quoted plan once its evidence or the competition has expired", () => {
    expect(isPlanExecutableAt(plan, "2026-08-23T23:59:00.000Z", 30, Date.parse("2026-08-13T12:01:59.999Z"))).toBe(true);
    expect(isPlanExecutableAt(plan, "2026-08-23T23:59:00.000Z", 30, Date.parse("2026-08-13T12:02:00.001Z"))).toBe(false);
    expect(isPlanExecutableAt(plan, "2026-08-13T12:01:00.000Z", 30, Date.parse("2026-08-13T12:01:00.000Z"))).toBe(false);
  });

  it("refuses evidence after the configured maximum age even if expiresAt is later", () => {
    const longExpiry = {
      assessment: {
        observedAt: "2026-08-13T11:30:00.000Z",
        expiresAt: "2026-08-13T14:00:00.000Z",
      },
      market: { resolvesAt: "2026-08-14T00:00:00.000Z" },
    };
    expect(isPlanExecutableAt(longExpiry, "2026-08-23T23:59:00.000Z", 30, Date.parse("2026-08-13T12:00:00.000Z"))).toBe(true);
    expect(isPlanExecutableAt(longExpiry, "2026-08-23T23:59:00.000Z", 30, Date.parse("2026-08-13T12:00:00.001Z"))).toBe(false);
  });

  it("refuses a plan at the market resolution boundary even if evidence remains fresh", () => {
    const closing = {
      assessment: {
        observedAt: "2026-08-13T11:59:00.000Z",
        expiresAt: "2026-08-13T12:10:00.000Z",
      },
      market: { resolvesAt: "2026-08-13T12:00:00.000Z" },
    };
    expect(isPlanExecutableAt(closing, "2026-08-23T23:59:00.000Z", 30, Date.parse("2026-08-13T11:59:59.999Z"))).toBe(true);
    expect(isPlanExecutableAt(closing, "2026-08-23T23:59:00.000Z", 30, Date.parse("2026-08-13T12:00:00.000Z"))).toBe(false);
  });
});

describe("fresh-book allocation", () => {
  const published = {
    ...candidate("d", 0.99, 0.7),
    assessment: {
      ...candidate("d", 0.99, 0.7).assessment,
      evidenceClass: "published_result" as const,
      probability: 0.99,
    },
  };
  const plan = {
    ...published,
    shares: 50,
    quotedCostTst: 35,
    maximumCostTst: 35.7,
    averagePrice: 0.7,
    maximumAveragePrice: 0.714,
    netEdge: 0.276,
    priceImpact: 0.014,
    worstCaseExpectedProfitTst: 13.8,
    mode: "full" as const,
    decisionId: "e".repeat(64),
  };
  const book = {
    rawMarkets: [],
    rawPositions: [],
    markets: [published.market],
    totalEquityTst: 1000,
    availableTst: 100,
    deployedValueTst: 560,
    gasEth: 1,
    positions: [{ marketId: published.market.id, outcomeIndex: 0, shares: 800, markPrice: 0.7 }],
  };

  it("rechecks cash and face-value exposure against the latest book", () => {
    expect(isPlanWithinBookLimits({ plan, policy, book })).toBe(true);
    expect(isPlanWithinBookLimits({ plan, policy, book: { ...book, totalEquityTst: 999 } })).toBe(false);
    expect(isPlanWithinBookLimits({ plan, policy, book: { ...book, availableTst: 35 } })).toBe(false);
    expect(isPlanWithinBookLimits({
      plan,
      policy,
      book: { ...book, markets: [{ ...published.market, prices: [0.51, 0.49] }] },
    })).toBe(false);
    expect(isPlanWithinBookLimits({
      plan,
      policy,
      book: { ...book, markets: [{ ...published.market, status: "closed" }] },
    })).toBe(false);
  });
});
