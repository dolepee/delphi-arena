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
  spotPrice: 0.6, rawEdge: 0.3, existingMarketValue: 0, existingMarketShares: 0, existingPortfolioShares: 0,
  market: { id: "0x1111111111111111111111111111111111111111", question: "q", outcomes: ["Yes", "No"], status: "open", resolvesAt: "2026-08-13T00:00:00.000Z", prices: [0.6, 0.4], tradingFeePct: 0.5, dataSources: [] },
  assessment: { marketId: "0x1111111111111111111111111111111111111111", outcomeIndex: 0, evidenceClass: "forecast", probability: 0.9, confidence: "high", status: "actionable", observedAt: "2026-08-12T11:50:00.000Z", expiresAt: "2026-08-12T12:20:00.000Z", rationale: "Official evidence creates a measurable edge.", sources: [{ url: "https://example.com", kind: "authoritative", observedAt: "2026-08-12T11:50:00.000Z", valueHash: "a".repeat(64) }] },
} satisfies Candidate;

describe("binary LMSR quote search", () => {
  it("finds the largest cent-sized plan under the slippage-adjusted budget", async () => {
    const client = { quoteBuy: async ({ sharesOut }: { sharesOut: bigint }) => ({ tokensIn: BigInt(Math.ceil(Number(sharesOut) / 1e18 * 0.6 * 1e6)) }) };
    const plan = await findQuotedPlan({ client: client as never, candidate, policy, budgetTst: 10, mode: "full", totalEquityTst: 1000 });
    expect(plan).not.toBeNull();
    expect(plan!.maximumCostTst).toBeLessThanOrEqual(10);
    expect(plan!.maximumCostTst).toBeGreaterThan(9.98);
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
});
