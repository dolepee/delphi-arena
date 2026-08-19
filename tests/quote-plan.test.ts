import { describe, expect, it } from "vitest";
import type { Candidate, Policy } from "../src/model.js";
import { findQuotedPlan } from "../src/quote-plan.js";

const policy: Policy = {
  competitionEndsAt: "2026-08-24T13:00:00.000Z", minimumStartingTst: 1000, minimumGasEth: 0.001,
  minimumNetEdge: 0.08, minimumPublishedResultNetEdge: 0.02, minimumOfficialScheduleNetEdge: 0.04, maximumMarketAllocationPct: 35, maximumPortfolioAllocationPct: 90,
  maximumOrderTst: 250, maximumPublishedResultMarketAllocationPct: 85, maximumPublishedResultPortfolioAllocationPct: 95,
  maximumPublishedResultOrderTst: 850, minimumFullOrderTst: 5, maximumPriceImpact: 0.04,
  maximumPublishedResultPriceImpact: 0.2, slippagePct: 2, maximumNewTradesPerCycle: 1,
  minimumEvidenceSources: 1, maximumAssessmentAgeMinutes: 30, canaryMaximumTst: 1, qualificationFallback: "none",
};
const candidate = {
  spotPrice: 0.6, rawEdge: 0.3, existingMarketValue: 0, existingMarketShares: 0, existingPortfolioValue: 0, existingPortfolioShares: 0,
  market: { id: "0x1111111111111111111111111111111111111111", question: "q", outcomes: ["Yes", "No"], status: "open", resolvesAt: "2026-08-13T00:00:00.000Z", prices: [0.6, 0.4], tradingFeePct: 0.5, dataSources: [] },
  assessment: { marketId: "0x1111111111111111111111111111111111111111", outcomeIndex: 0, evidenceClass: "forecast", probability: 0.9, confidence: "high", status: "actionable", observedAt: "2026-08-12T11:50:00.000Z", expiresAt: "2026-08-12T12:20:00.000Z", rationale: "Official evidence creates a measurable edge.", sources: [{ url: "https://example.com", kind: "authoritative", observedAt: "2026-08-12T11:50:00.000Z", valueHash: "a".repeat(64) }] },
} satisfies Candidate;

describe("binary LMSR quote search", () => {
  it("finds the largest cent-sized plan under the slippage-adjusted budget", async () => {
    const client = { quoteBuy: async ({ sharesOut }: { sharesOut: bigint }) => ({ tokensIn: BigInt(Math.ceil(Number(sharesOut) / 1e18 * 0.6 * 1e6)) }) };
    const quotedAt = Date.parse("2026-08-12T12:00:00.000Z");
    const plan = await findQuotedPlan({
      client: client as never,
      candidate,
      policy,
      budgetTst: 10,
      mode: "full",
      totalEquityTst: 1000,
      now: () => quotedAt,
    });
    expect(plan).not.toBeNull();
    expect(plan!.maximumCostTst).toBeLessThanOrEqual(10);
    expect(plan!.maximumCostTst).toBeGreaterThan(9.98);
    expect(plan!.quotedAt).toBe(new Date(quotedAt).toISOString());
  });

  it("never quotes above the supplied share-allocation room", async () => {
    const client = { quoteBuy: async ({ sharesOut }: { sharesOut: bigint }) => ({ tokensIn: BigInt(Math.ceil(Number(sharesOut) / 1e18 * 0.6 * 1e6)) }) };
    const plan = await findQuotedPlan({
      client: client as never,
      candidate,
      policy,
      budgetTst: 100,
      mode: "full",
      totalEquityTst: 1000,
      maximumShares: 12.34,
    });
    expect(plan?.shares).toBeLessThanOrEqual(12.34);
    expect(plan?.shares).toBeGreaterThan(12.3);
  });

  it("rejects a final full-mode plan trimmed below the minimum order", async () => {
    const client = { quoteBuy: async ({ sharesOut }: { sharesOut: bigint }) => ({ tokensIn: BigInt(Math.ceil(Number(sharesOut) / 1e18 * 0.6 * 1e6)) }) };
    const plan = await findQuotedPlan({
      client: client as never,
      candidate,
      policy,
      budgetTst: 250,
      mode: "full",
      totalEquityTst: 1106,
      maximumShares: 1.65,
    });
    expect(plan).toBeNull();
  });

  it("can consume the live cash budget for a deterministic result despite high share count", async () => {
    const resultCandidate = {
      ...candidate,
      spotPrice: 0.5,
      rawEdge: 0.49,
      existingPortfolioValue: 630.28785528,
      existingPortfolioShares: 822.18,
      market: { ...candidate.market, prices: [0.5, 0.5] },
      assessment: {
        ...candidate.assessment,
        evidenceClass: "published_result" as const,
        probability: 0.99,
      },
    } satisfies Candidate;
    const client = {
      quoteBuy: async ({ sharesOut }: { sharesOut: bigint }) => ({
        tokensIn: BigInt(Math.ceil(Number(sharesOut) / 1e18 * 0.5 * 1e6)),
      }),
    };
    const plan = await findQuotedPlan({
      client: client as never,
      candidate: resultCandidate,
      policy,
      budgetTst: 485.523893836,
      mode: "full",
      totalEquityTst: 1174.53868328,
      maximumShares: Number.POSITIVE_INFINITY,
    });
    expect(plan).not.toBeNull();
    expect(plan!.shares).toBeGreaterThan(900);
    expect(plan!.maximumCostTst).toBeLessThanOrEqual(485.523893836);
    expect(plan!.maximumCostTst).toBeGreaterThan(485.5);
  });
});
