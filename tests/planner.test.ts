import { describe, expect, it } from "vitest";
import type { Assessment, MarketView, Policy, PositionView } from "../src/model.js";
import { orderBudget, selectCandidates, validateQuote } from "../src/planner.js";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const POLICY: Policy = {
  competitionEndsAt: "2026-08-24T13:00:00.000Z",
  minimumStartingTst: 1000,
  minimumGasEth: 0.001,
  minimumNetEdge: 0.08,
  maximumMarketAllocationPct: 35,
  maximumPortfolioAllocationPct: 90,
  maximumOrderTst: 250,
  maximumPriceImpact: 0.04,
  slippagePct: 2,
  maximumNewTradesPerCycle: 1,
  minimumEvidenceSources: 1,
  maximumAssessmentAgeMinutes: 30,
  canaryMaximumTst: 1,
  qualificationFallback: "none",
};
const MARKET: MarketView = {
  id: "0x1111111111111111111111111111111111111111",
  question: "Will the official value exceed the threshold?",
  outcomes: ["Yes", "No"],
  status: "open",
  resolvesAt: "2026-08-13T00:00:00.000Z",
  prices: [0.6, 0.4],
  tradingFeePct: 0.5,
  dataSources: [],
};
const ASSESSMENT: Assessment = {
  marketId: MARKET.id,
  outcomeIndex: 0,
  probability: 0.85,
  confidence: "high",
  status: "actionable",
  observedAt: "2026-08-12T11:50:00.000Z",
  expiresAt: "2026-08-12T12:20:00.000Z",
  rationale: "The named primary source published a value above the threshold.",
  sources: [{
    url: "https://example.com/official.csv",
    kind: "authoritative",
    observedAt: "2026-08-12T11:49:00.000Z",
    valueHash: "a".repeat(64),
  }],
};

describe("source-first candidate selection", () => {
  it("selects a fresh authoritative edge", () => {
    const candidates = selectCandidates({ now: NOW, policy: POLICY, markets: [MARKET], positions: [], assessments: [ASSESSMENT] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.rawEdge).toBeCloseTo(0.25);
  });

  it.each([
    [{ ...ASSESSMENT, status: "watch" as const }],
    [{ ...ASSESSMENT, confidence: "low" as const }],
    [{ ...ASSESSMENT, expiresAt: "2026-08-12T11:59:00.000Z" }],
    [{ ...ASSESSMENT, observedAt: "2026-08-12T10:00:00.000Z" }],
    [{ ...ASSESSMENT, sources: [{ ...ASSESSMENT.sources[0]!, kind: "secondary" as const }] }],
  ])("refuses non-actionable, weak, stale, expired, or non-authoritative evidence", (assessment) => {
    expect(selectCandidates({ now: NOW, policy: POLICY, markets: [MARKET], positions: [], assessments: [assessment] })).toHaveLength(0);
  });

  it("refuses an opposing position in the same market", () => {
    const positions: PositionView[] = [{ marketId: MARKET.id, outcomeIndex: 1, shares: 10, markPrice: 0.4 }];
    expect(selectCandidates({ now: NOW, policy: POLICY, markets: [MARKET], positions, assessments: [ASSESSMENT] })).toHaveLength(0);
  });
});

describe("LMSR quote and allocation controls", () => {
  const candidate = selectCandidates({ now: NOW, policy: POLICY, markets: [MARKET], positions: [], assessments: [ASSESSMENT] })[0]!;

  it("accepts a quote only when net edge, impact, slippage, and budget survive", () => {
    const plan = validateQuote({ candidate, policy: POLICY, shares: 10, quotedCostTst: 6.2, budgetTst: 7, mode: "canary" });
    expect(plan?.netEdge).toBeGreaterThan(POLICY.minimumNetEdge);
    expect(plan?.maximumCostTst).toBeLessThanOrEqual(7);
  });

  it("rejects a quote whose average execution destroys the edge", () => {
    expect(validateQuote({ candidate, policy: POLICY, shares: 10, quotedCostTst: 7.8, budgetTst: 10, mode: "full" })).toBeNull();
  });

  it("caps the canary and full allocation independently", () => {
    expect(orderBudget({ policy: POLICY, totalEquityTst: 1000, availableTst: 1000, deployedValueTst: 0, existingMarketValueTst: 0, mode: "canary" })).toBe(1);
    expect(orderBudget({ policy: POLICY, totalEquityTst: 1000, availableTst: 1000, deployedValueTst: 0, existingMarketValueTst: 0, mode: "full" })).toBe(250);
    expect(orderBudget({ policy: POLICY, totalEquityTst: 1000, availableTst: 1000, deployedValueTst: 890, existingMarketValueTst: 0, mode: "full" })).toBe(10);
  });
});
