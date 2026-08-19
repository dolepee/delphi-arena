import { describe, expect, it } from "vitest";
import type { Assessment, MarketView, Policy, PositionView } from "../src/model.js";
import type { OpportunityDefinition } from "../src/opportunity-policy.js";
import { isAssessmentEvidenceValid, maximumAdditionalShares, orderBudget, rankQuotedPlans, selectCandidates, validateQuote } from "../src/planner.js";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const POLICY: Policy = {
  competitionEndsAt: "2026-08-24T13:00:00.000Z",
  minimumStartingTst: 1000,
  minimumGasEth: 0.001,
  minimumNetEdge: 0.08,
  minimumPublishedResultNetEdge: 0.02,
  minimumOfficialScheduleNetEdge: 0.04,
  maximumMarketAllocationPct: 35,
  maximumPortfolioAllocationPct: 90,
  maximumOrderTst: 250,
  maximumPublishedResultMarketAllocationPct: 85,
  maximumPublishedResultPortfolioAllocationPct: 95,
  maximumPublishedResultOrderTst: 850,
  minimumFullOrderTst: 5,
  maximumPriceImpact: 0.04,
  maximumPublishedResultPriceImpact: 0.2,
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
  evidenceClass: "forecast",
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
const OPPORTUNITIES: OpportunityDefinition[] = [{
  marketId: MARKET.id,
  classification: "result_capable",
  resultCapableOutcomes: [0],
  earliestDecisiveAt: "2026-08-12T11:00:00.000Z",
  rationale: "The official source can publish a decisive value before trading closes.",
}];

describe("source-first candidate selection", () => {
  it("selects a fresh authoritative edge", () => {
    const candidates = selectCandidates({ now: NOW, policy: POLICY, markets: [MARKET], positions: [], assessments: [ASSESSMENT], opportunities: OPPORTUNITIES });
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
    expect(selectCandidates({ now: NOW, policy: POLICY, markets: [MARKET], positions: [], assessments: [assessment], opportunities: OPPORTUNITIES })).toHaveLength(0);
  });

  it("refuses an opposing position in the same market", () => {
    const positions: PositionView[] = [{ marketId: MARKET.id, outcomeIndex: 1, shares: 10, markPrice: 0.4 }];
    expect(selectCandidates({ now: NOW, policy: POLICY, markets: [MARKET], positions, assessments: [ASSESSMENT], opportunities: OPPORTUNITIES })).toHaveLength(0);
  });

  it("fails closed for an unclassified or abstained market", () => {
    expect(selectCandidates({
      now: NOW,
      policy: POLICY,
      markets: [MARKET],
      positions: [],
      assessments: [ASSESSMENT],
      opportunities: [],
    })).toHaveLength(0);
    expect(selectCandidates({
      now: NOW,
      policy: POLICY,
      markets: [MARKET],
      positions: [],
      assessments: [ASSESSMENT],
      opportunities: [{ ...OPPORTUNITIES[0]!, classification: "abstain", resultCapableOutcomes: [] }],
    })).toHaveLength(0);
  });
});

describe("LMSR quote and allocation controls", () => {
  const candidate = selectCandidates({ now: NOW, policy: POLICY, markets: [MARKET], positions: [], assessments: [ASSESSMENT], opportunities: OPPORTUNITIES })[0]!;

  it("accepts a quote only when net edge, impact, slippage, and budget survive", () => {
    const plan = validateQuote({ candidate, policy: POLICY, shares: 10, quotedCostTst: 6.2, budgetTst: 7, mode: "canary", totalEquityTst: 1000 });
    expect(plan?.netEdge).toBeGreaterThan(POLICY.minimumNetEdge);
    expect(plan?.maximumCostTst).toBeLessThanOrEqual(7);
  });

  it("rejects a quote whose average execution destroys the edge", () => {
    expect(validateQuote({ candidate, policy: POLICY, shares: 10, quotedCostTst: 7.8, budgetTst: 10, mode: "full", totalEquityTst: 1000 })).toBeNull();
  });

  it("uses the tighter published-result floor only for exact official releases", () => {
    const released = { ...ASSESSMENT, evidenceClass: "published_result" as const, probability: 0.99 };
    const [releasedCandidate] = selectCandidates({
      now: NOW,
      policy: POLICY,
      markets: [{ ...MARKET, prices: [0.95, 0.05] }],
      positions: [],
      assessments: [released],
      opportunities: OPPORTUNITIES,
    });
    expect(releasedCandidate).toBeDefined();
    expect(validateQuote({
      candidate: releasedCandidate!,
      policy: POLICY,
      shares: 10,
      quotedCostTst: 9.55,
      budgetTst: 10,
      mode: "full",
      totalEquityTst: 1000,
    })).toBeNull();
    expect(validateQuote({
      candidate: releasedCandidate!,
      policy: POLICY,
      shares: 10,
      quotedCostTst: 9.5,
      budgetTst: 10,
      mode: "full",
      totalEquityTst: 1000,
    })).not.toBeNull();
    expect(selectCandidates({
      now: NOW,
      policy: POLICY,
      markets: [{ ...MARKET, prices: [0.95, 0.05] }],
      positions: [],
      assessments: [{ ...released, evidenceClass: "forecast" }],
      opportunities: OPPORTUNITIES,
    })).toHaveLength(0);
  });

  it.each([
    { ...ASSESSMENT, evidenceClass: "published_result" as const, confidence: "medium" as const, probability: 0.99 },
    { ...ASSESSMENT, evidenceClass: "published_result" as const, confidence: "high" as const, probability: 0.98 },
  ])("rejects a published-result label without exact high-confidence evidence", (assessment) => {
    expect(selectCandidates({
      now: NOW,
      policy: POLICY,
      markets: [MARKET],
      positions: [],
      assessments: [assessment],
      opportunities: OPPORTUNITIES,
    })).toHaveLength(0);
  });

  it("counts the SDK total-cash quote fee only once and gates slippage before edge", () => {
    const feeSensitiveCandidate = {
      ...candidate,
      assessment: { ...candidate.assessment, probability: 0.694 },
      rawEdge: 0.094,
    };
    const accepted = validateQuote({
      candidate: feeSensitiveCandidate,
      policy: POLICY,
      shares: 10,
      quotedCostTst: 6,
      budgetTst: 7,
      mode: "full",
      totalEquityTst: 1000,
    });
    expect(accepted?.maximumAveragePrice).toBeCloseTo(0.612);
    expect(accepted?.netEdge).toBeCloseTo(0.082);
  });

  it("rejects a quote whose slippage-authorized fill breaches the impact ceiling", () => {
    expect(validateQuote({
      candidate: {
        ...candidate,
        spotPrice: 0.6,
        assessment: { ...candidate.assessment, probability: 0.9 },
      },
      policy: POLICY,
      shares: 10,
      quotedCostTst: 6.39,
      budgetTst: 7,
      mode: "full",
      totalEquityTst: 1000,
    })).toBeNull();
  });

  it("retains the exact atomic max-cost ceiling without a float round-trip", () => {
    const precise = validateQuote({
      candidate: {
        ...candidate,
        spotPrice: 0.6,
        assessment: {
          ...candidate.assessment,
          evidenceClass: "published_result" as const,
          probability: 0.99,
        },
      },
      policy: POLICY,
      shares: 100,
      quotedCostTst: 63.897165,
      budgetTst: 70,
      mode: "full",
      totalEquityTst: 1000,
    });
    expect(precise?.maximumCostAtomic).toBe(65_175_109n);
    expect(precise?.maximumCostTst).toBe(65.175109);
  });

  it("uses an intermediate floor for decisive official schedules", () => {
    const scheduled = { ...ASSESSMENT, evidenceClass: "official_schedule" as const, probability: 0.99 };
    const [candidate] = selectCandidates({
      now: NOW,
      policy: POLICY,
      markets: [{ ...MARKET, prices: [0.94, 0.06] }],
      positions: [],
      assessments: [scheduled],
      opportunities: OPPORTUNITIES,
    });
    expect(candidate).toBeDefined();
    expect(validateQuote({
      candidate: candidate!,
      policy: POLICY,
      shares: 10,
      quotedCostTst: 9.3,
      budgetTst: 10,
      mode: "full",
      totalEquityTst: 1000,
    })).not.toBeNull();
  });

  it("caps the canary and full allocation independently", () => {
    expect(orderBudget({ policy: POLICY, assessment: ASSESSMENT, totalEquityTst: 1000, availableTst: 1000, deployedValueTst: 0, existingMarketValueTst: 0, mode: "canary" })).toBe(1);
    expect(orderBudget({ policy: POLICY, assessment: ASSESSMENT, totalEquityTst: 1000, availableTst: 1000, deployedValueTst: 0, existingMarketValueTst: 0, mode: "full" })).toBe(250);
    expect(orderBudget({ policy: POLICY, assessment: ASSESSMENT, totalEquityTst: 1000, availableTst: 1000, deployedValueTst: 890, existingMarketValueTst: 0, mode: "full" })).toBe(10);
  });

  it("raises limits only for an exact published result", () => {
    const published = { ...ASSESSMENT, evidenceClass: "published_result" as const, confidence: "high" as const, probability: 0.99 };
    const scheduled = { ...ASSESSMENT, evidenceClass: "official_schedule" as const, confidence: "high" as const, probability: 0.99 };
    expect(orderBudget({ policy: POLICY, assessment: published, totalEquityTst: 1000, availableTst: 1000, deployedValueTst: 0, existingMarketValueTst: 0, mode: "full" })).toBe(850);
    expect(orderBudget({ policy: POLICY, assessment: published, totalEquityTst: 1000, availableTst: 1000, deployedValueTst: 0, existingMarketValueTst: 0, mode: "canary" })).toBe(1);
    expect(orderBudget({ policy: POLICY, assessment: scheduled, totalEquityTst: 1000, availableTst: 1000, deployedValueTst: 0, existingMarketValueTst: 0, mode: "full" })).toBe(250);
  });

  it("uses the isolated 1350/95% tournament profile only for a deterministic full result", () => {
    const tournamentPolicy: Policy = {
      ...POLICY,
      maximumTournamentExactResultOrderTst: 1350,
      maximumTournamentEquityAllocationPct: 95,
      minimumTournamentPodiumBufferTst: 300,
      maximumTournamentLeaderboardAgeSeconds: 45,
      maximumTournamentQuoteAgeSeconds: 15,
    };
    const published = {
      ...ASSESSMENT,
      evidenceClass: "published_result" as const,
      confidence: "high" as const,
      probability: 0.99,
    };
    const scheduled = {
      ...ASSESSMENT,
      evidenceClass: "official_schedule" as const,
      confidence: "high" as const,
      probability: 0.99,
    };
    expect(orderBudget({
      policy: tournamentPolicy,
      assessment: published,
      totalEquityTst: 1422.528949,
      availableTst: 1422.528949,
      deployedValueTst: 0,
      existingMarketValueTst: 0,
      mode: "full",
    })).toBe(1350);
    expect(orderBudget({
      policy: tournamentPolicy,
      assessment: published,
      totalEquityTst: 1422.528949,
      availableTst: 1422.528949,
      deployedValueTst: 0,
      existingMarketValueTst: 0,
      mode: "canary",
    })).toBe(1);
    expect(orderBudget({
      policy: tournamentPolicy,
      assessment: scheduled,
      totalEquityTst: 1422.528949,
      availableTst: 1422.528949,
      deployedValueTst: 0,
      existingMarketValueTst: 0,
      mode: "full",
    })).toBe(250);

    const exactCandidate = {
      ...candidate,
      spotPrice: 0.13,
      market: { ...candidate.market, prices: [0.13, 0.87] },
      assessment: published,
      rawEdge: 0.86,
    };
    const accepted = validateQuote({
      candidate: exactCandidate,
      policy: tournamentPolicy,
      shares: 5_000,
      quotedCostTst: 1_323,
      budgetTst: 1_350,
      mode: "full",
      totalEquityTst: 1422.528949,
    });
    expect(accepted?.maximumCostTst).toBe(1349.46);
    expect(accepted).not.toBeNull();
  });

  it("caps deterministic result orders by worst-case cash exposure", () => {
    const published = { ...ASSESSMENT, evidenceClass: "published_result" as const, probability: 0.99 };
    const positions: PositionView[] = [{
      marketId: MARKET.id,
      outcomeIndex: 0,
      shares: 800,
      markPrice: 0.6,
    }];
    const [positioned] = selectCandidates({
      now: NOW,
      policy: POLICY,
      markets: [MARKET],
      positions,
      assessments: [published],
      opportunities: OPPORTUNITIES,
    });
    expect(positioned?.existingMarketShares).toBe(800);
    expect(positioned?.existingPortfolioShares).toBe(800);
    expect(positioned?.existingMarketValue).toBe(480);
    expect(positioned?.existingPortfolioValue).toBe(480);
    expect(validateQuote({
      candidate: positioned!,
      policy: POLICY,
      shares: 500,
      quotedCostTst: 370,
      budgetTst: 400,
      mode: "full",
      totalEquityTst: 1000,
    })).toBeNull();
    expect(validateQuote({
      candidate: positioned!,
      policy: POLICY,
      shares: 500,
      quotedCostTst: 350,
      budgetTst: 400,
      mode: "full",
      totalEquityTst: 1000,
    })).not.toBeNull();
  });

  it("blocks full-live dust while preserving the bounded canary", () => {
    expect(orderBudget({ policy: POLICY, assessment: ASSESSMENT, totalEquityTst: 1000, availableTst: 4.99, deployedValueTst: 0, existingMarketValueTst: 0, mode: "full" })).toBe(0);
    expect(orderBudget({ policy: POLICY, assessment: ASSESSMENT, totalEquityTst: 1000, availableTst: 1, deployedValueTst: 0, existingMarketValueTst: 0, mode: "canary" })).toBe(1);
  });

  it("removes the share ceiling only for deterministic result quotes", () => {
    const published = { ...ASSESSMENT, evidenceClass: "published_result" as const, probability: 0.99 };
    expect(maximumAdditionalShares({
      policy: POLICY,
      assessment: published,
      totalEquityTst: 1000,
      positions: [{
        marketId: "0x2222222222222222222222222222222222222222",
        outcomeIndex: 0,
        shares: 400,
        markPrice: 0.9,
      }],
      marketId: MARKET.id,
      mode: "full",
    })).toBe(Number.POSITIVE_INFINITY);
    expect(maximumAdditionalShares({
      policy: POLICY,
      assessment: ASSESSMENT,
      totalEquityTst: 1000,
      positions: [{
        marketId: "0x2222222222222222222222222222222222222222",
        outcomeIndex: 0,
        shares: 400,
        markPrice: 0.9,
      }],
      marketId: MARKET.id,
      mode: "full",
    })).toBe(350);
  });

  it("preserves the live published-result cash room instead of applying a second share cap", () => {
    const published = { ...ASSESSMENT, evidenceClass: "published_result" as const, probability: 0.99 };
    const budget = orderBudget({
      policy: POLICY,
      assessment: published,
      totalEquityTst: 1174.53868328,
      availableTst: 544.250828,
      deployedValueTst: 630.28785528,
      existingMarketValueTst: 0,
      mode: "full",
    });
    expect(budget).toBeCloseTo(485.523893836, 9);
    expect(maximumAdditionalShares({
      policy: POLICY,
      assessment: published,
      totalEquityTst: 1174.53868328,
      positions: [
        { marketId: "0x2222222222222222222222222222222222222222", outcomeIndex: 0, shares: 406.38, markPrice: 0.712386 },
        { marketId: "0x3333333333333333333333333333333333333333", outcomeIndex: 0, shares: 415.8, markPrice: 0.819597 },
      ],
      marketId: MARKET.id,
      mode: "full",
    })).toBe(Number.POSITIVE_INFINITY);
  });

  it("ranks by worst-case expected TST profit before percentage edge", () => {
    const smallHighEdge = validateQuote({
      candidate,
      policy: POLICY,
      shares: 5,
      quotedCostTst: 3,
      budgetTst: 100,
      mode: "full",
      totalEquityTst: 1000,
    })!;
    const largeLowerEdge = validateQuote({
      candidate: {
        ...candidate,
        spotPrice: 0.65,
        market: { ...candidate.market, prices: [0.65, 0.35] },
        assessment: { ...candidate.assessment, probability: 0.82 },
        rawEdge: 0.17,
      },
      policy: POLICY,
      shares: 100,
      quotedCostTst: 67.5,
      budgetTst: 100,
      mode: "full",
      totalEquityTst: 1000,
    })!;
    expect(smallHighEdge.netEdge).toBeGreaterThan(largeLowerEdge.netEdge);
    expect(rankQuotedPlans([smallHighEdge, largeLowerEdge])[0]).toBe(largeLowerEdge);
  });
});

describe("assessment evidence authorization", () => {
  it("rejects stale or source-less published results before they can authorize writes", () => {
    const published = {
      ...ASSESSMENT,
      evidenceClass: "published_result" as const,
      probability: 0.99,
      confidence: "high" as const,
    };
    expect(isAssessmentEvidenceValid({ assessment: published, policy: POLICY, now: NOW })).toBe(true);
    expect(isAssessmentEvidenceValid({
      assessment: { ...published, sources: [] },
      policy: POLICY,
      now: NOW,
    })).toBe(false);
    expect(isAssessmentEvidenceValid({
      assessment: { ...published, observedAt: "2026-08-12T10:00:00.000Z", expiresAt: "2026-08-12T15:00:00.000Z" },
      policy: POLICY,
      now: NOW,
    })).toBe(false);
    expect(isAssessmentEvidenceValid({
      assessment: { ...published, observedAt: "2026-08-12T12:01:00.000Z" },
      policy: POLICY,
      now: NOW,
    })).toBe(false);
  });
});
