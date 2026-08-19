import { describe, expect, it, vi } from "vitest";
import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { readFileSync } from "node:fs";
import type { Assessment, Candidate, MarketView, Policy, QuotedPlan } from "../src/model.js";
import type { OpportunityDefinition } from "../src/opportunity-policy.js";
import type { Book } from "../src/runtime.js";
import { runEventCycle, type EventCycleDependencies } from "../src/event-cycle.js";
import { assessFederalRegisterCount } from "../src/official-assessors.js";

const NOW = Date.parse("2026-08-16T21:00:00.000Z");
const MARKET_ID = "0x9999999999999999999999999999999999999999" as const;
const OTHER_ID = "0x8888888888888888888888888888888888888888" as const;

const market: MarketView = {
  id: MARKET_ID,
  question: "Will the Federal Register publish 6+ Presidential documents with publication dates Aug 12-18, 2026?",
  outcomes: ["Yes", "No"],
  status: "open",
  resolvesAt: "2026-08-18T12:00:00.000Z",
  prices: [0.4, 0.6],
  tradingFeePct: 0.5,
  dataSources: [],
};
const otherMarket: MarketView = {
  ...market,
  id: OTHER_ID,
  question: "Another event market",
};
const federalRegisterFixture = readFileSync(
  new URL("./fixtures/federal-register-count-6.json", import.meta.url),
  "utf8",
);
const assessment = assessFederalRegisterCount({
  market,
  body: federalRegisterFixture,
  sourceUrl: "https://www.federalregister.gov/api/v1/documents.json",
  now: NOW,
}) as Assessment;
const policy: Policy = {
  competitionEndsAt: "2026-08-23T23:59:00.000Z", minimumStartingTst: 1000, minimumGasEth: 0.001,
  minimumNetEdge: 0.08, minimumPublishedResultNetEdge: 0.02, minimumOfficialScheduleNetEdge: 0.04,
  maximumMarketAllocationPct: 35, maximumPortfolioAllocationPct: 90, maximumOrderTst: 250,
  maximumPublishedResultMarketAllocationPct: 85, maximumPublishedResultPortfolioAllocationPct: 95,
  maximumPublishedResultOrderTst: 850, minimumFullOrderTst: 5, maximumPriceImpact: 0.04,
  maximumPublishedResultPriceImpact: 0.2, slippagePct: 2, exitSlippagePct: 2,
  minimumProfitTakeReturnPct: 3, maximumHoldEdgeForProfitTake: 0.02,
  maximumNewTradesPerCycle: 1, minimumEvidenceSources: 1, maximumAssessmentAgeMinutes: 30,
  canaryMaximumTst: 1, qualificationFallback: "none",
};
const opportunity: OpportunityDefinition = {
  marketId: MARKET_ID,
  classification: "result_capable",
  resultCapableOutcomes: [0],
  earliestDecisiveAt: "2026-08-16T20:00:00.000Z",
  rationale: "The official count can cross the threshold before this market stops trading.",
};

function book(input: Partial<Book> = {}): Book {
  return {
    rawMarkets: [], rawPositions: [], markets: [market, otherMarket], positions: [],
    availableTst: 100, gasEth: 1, deployedValueTst: 900, totalEquityTst: 1000,
    ...input,
  };
}

function quotedPlan(): QuotedPlan {
  const candidate: Candidate = {
    assessment, market, spotPrice: 0.4, rawEdge: 0.59,
    existingMarketValue: 0, existingMarketShares: 0,
    existingPortfolioValue: 0, existingPortfolioShares: 0,
  };
  return {
    ...candidate,
    quotedAt: "2026-08-13T11:59:55.000Z",
    shares: 100, quotedCostTst: 40, maximumCostTst: 40.8, maximumCostAtomic: 40_800_000n,
    averagePrice: 0.4, maximumAveragePrice: 0.408, netEdge: 0.582, priceImpact: 0.008,
    worstCaseExpectedProfitTst: 58.2, mode: "full", decisionId: "b".repeat(64),
  };
}

function dependencies(overrides: Partial<EventCycleDependencies> = {}) {
  const quoteSell = vi.fn(async () => ({ tokensOut: 100_000_000n }));
  const ensureTokenApproval = vi.fn();
  const buyShares = vi.fn();
  const sellShares = vi.fn();
  const client = { quoteSell, ensureTokenApproval, buyShares, sellShares } as unknown as DelphiClient;
  const candidate: Candidate = {
    assessment, market, spotPrice: 0.4, rawEdge: 0.59,
    existingMarketValue: 0, existingMarketShares: 0,
    existingPortfolioValue: 0, existingPortfolioShares: 0,
  };
  const value: EventCycleDependencies = {
    client,
    now: () => NOW,
    readBook: vi.fn(async () => book()),
    generateOfficialAssessments: vi.fn(async () => [assessment]),
    selectEventAssessments: (items) => items,
    loadOpportunityDefinitions: vi.fn(async () => [opportunity]),
    executionEnabled: () => true,
    assertNoPendingIntents: vi.fn(async () => undefined),
    loadPolicy: vi.fn(async () => policy),
    selectCandidates: vi.fn(() => [candidate]),
    quoteCandidates: vi.fn(async () => ({ plans: [quotedPlan()], quoteFailures: [] })),
    preflightTournamentPlans: vi.fn(async ({ plans }) => ({ plans, failures: [] })),
    saveAssessments: vi.fn(async () => undefined),
    managePositions: vi.fn(async () => ({ status: "NO_EXIT" })),
    trade: vi.fn(async () => ({ status: "TRADED" })),
    ...overrides,
  };
  return { value, quoteSell, ensureTokenApproval, buyShares, sellShares };
}

describe("production-shaped event cycle", () => {
  it("performs no assessment or SDK write when there is no exact result", async () => {
    const fixture = dependencies({ generateOfficialAssessments: vi.fn(async () => []) });
    await expect(runEventCycle(fixture.value)).resolves.toMatchObject({ status: "NO_EVENT" });
    expect(fixture.value.readBook).toHaveBeenCalledTimes(1);
    expect(fixture.value.assertNoPendingIntents).not.toHaveBeenCalled();
    expect(fixture.value.saveAssessments).not.toHaveBeenCalled();
    expect(fixture.value.managePositions).not.toHaveBeenCalled();
    expect(fixture.value.trade).not.toHaveBeenCalled();
    expect(fixture.quoteSell).not.toHaveBeenCalled();
  });

  it("reports a dry run without writes while event activation is false", async () => {
    const fixture = dependencies({ executionEnabled: () => false });
    await expect(runEventCycle(fixture.value)).resolves.toMatchObject({ status: "EVENT_DETECTED_DRY_RUN" });
    expect(fixture.value.readBook).toHaveBeenCalledTimes(1);
    expect(fixture.value.assertNoPendingIntents).not.toHaveBeenCalled();
    expect(fixture.value.saveAssessments).not.toHaveBeenCalled();
    expect(fixture.value.managePositions).not.toHaveBeenCalled();
    expect(fixture.value.trade).not.toHaveBeenCalled();
  });

  it("rejects a disallowed event before projecting or executing an opposing exit", async () => {
    const heldNo = { marketId: MARKET_ID, outcomeIndex: 1, shares: 100, markPrice: 0.6 };
    const forecastOnly: OpportunityDefinition = {
      ...opportunity,
      classification: "forecast_only",
      resultCapableOutcomes: [],
      earliestDecisiveAt: null,
    };
    const fixture = dependencies({
      readBook: vi.fn(async () => book({ positions: [heldNo] })),
      loadOpportunityDefinitions: vi.fn(async () => [forecastOnly]),
    });
    await expect(runEventCycle(fixture.value)).resolves.toMatchObject({ status: "NO_EVENT" });
    expect(fixture.value.readBook).toHaveBeenCalledOnce();
    expect(fixture.quoteSell).not.toHaveBeenCalled();
    expect(fixture.value.selectCandidates).not.toHaveBeenCalled();
    expect(fixture.value.saveAssessments).not.toHaveBeenCalled();
    expect(fixture.value.managePositions).not.toHaveBeenCalled();
    expect(fixture.value.trade).not.toHaveBeenCalled();
  });

  it("fails closed before assessment generation when classifications cannot load", async () => {
    const fixture = dependencies({
      loadOpportunityDefinitions: vi.fn(async () => {
        throw new Error("malformed opportunity definitions");
      }),
    });
    await expect(runEventCycle(fixture.value)).rejects.toThrow("malformed opportunity definitions");
    expect(fixture.value.generateOfficialAssessments).not.toHaveBeenCalled();
    expect(fixture.quoteSell).not.toHaveBeenCalled();
    expect(fixture.value.saveAssessments).not.toHaveBeenCalled();
    expect(fixture.value.managePositions).not.toHaveBeenCalled();
    expect(fixture.value.trade).not.toHaveBeenCalled();
  });

  it("does not treat a mapped but nonexistent live outcome as an opposing-exit signal", async () => {
    const invalidOutcome = { ...assessment, outcomeIndex: 2 };
    const heldNo = { marketId: MARKET_ID, outcomeIndex: 1, shares: 100, markPrice: 0.6 };
    const fixture = dependencies({
      readBook: vi.fn(async () => book({ positions: [heldNo] })),
      generateOfficialAssessments: vi.fn(async () => [invalidOutcome]),
      loadOpportunityDefinitions: vi.fn(async () => [{
        ...opportunity,
        resultCapableOutcomes: [2],
      }]),
    });
    await expect(runEventCycle(fixture.value)).resolves.toMatchObject({
      status: "EVENT_STALE_BEFORE_QUOTE",
    });
    expect(fixture.quoteSell).not.toHaveBeenCalled();
    expect(fixture.value.selectCandidates).not.toHaveBeenCalled();
    expect(fixture.value.saveAssessments).not.toHaveBeenCalled();
    expect(fixture.value.managePositions).not.toHaveBeenCalled();
    expect(fixture.value.trade).not.toHaveBeenCalled();
  });

  it("quotes and closes one opposing exit, then defers entry until the next flat cycle", async () => {
    const heldNo = { marketId: MARKET_ID, outcomeIndex: 1, shares: 100, markPrice: 0.6 };
    const freshBook = book({ positions: [heldNo] });
    const fixture = dependencies({
      readBook: vi.fn().mockResolvedValueOnce(book()).mockResolvedValueOnce(freshBook),
    });
    await expect(runEventCycle(fixture.value)).resolves.toMatchObject({ status: "EVENT_POSITION_EXIT_ONLY" });
    expect(fixture.quoteSell).toHaveBeenCalledOnce();
    expect(fixture.quoteSell).toHaveBeenCalledWith({
      marketAddress: MARKET_ID,
      outcomeIdx: 1,
      sharesIn: 100n * 10n ** 18n,
    });
    const quoteInput = vi.mocked(fixture.value.quoteCandidates).mock.calls[0]?.[0];
    expect(quoteInput?.book.availableTst).toBe(198);
    expect(quoteInput?.book.positions).toEqual([]);
    expect(vi.mocked(fixture.value.saveAssessments).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(fixture.value.managePositions).mock.invocationCallOrder[0]!);
    expect(fixture.value.preflightTournamentPlans).not.toHaveBeenCalled();
    expect(fixture.value.trade).not.toHaveBeenCalled();
  });

  it("closes a contradicted position without buying when no entry quote clears", async () => {
    const heldNo = { marketId: MARKET_ID, outcomeIndex: 1, shares: 100, markPrice: 0.6 };
    const fixture = dependencies({
      readBook: vi.fn().mockResolvedValueOnce(book()).mockResolvedValueOnce(book({ positions: [heldNo] })),
      quoteCandidates: vi.fn(async () => ({ plans: [], quoteFailures: ["no executable edge"] })),
      managePositions: vi.fn(async () => ({ status: "SOLD" })),
    });
    await expect(runEventCycle(fixture.value)).resolves.toMatchObject({
      status: "EVENT_POSITION_EXIT_ONLY",
      management: { status: "SOLD" },
    });
    expect(fixture.value.managePositions).toHaveBeenCalledOnce();
    expect(fixture.value.trade).not.toHaveBeenCalled();
  });

  it("never rotates unrelated inventory inside the exact-result entry cycle", async () => {
    const profitable = { marketId: OTHER_ID, outcomeIndex: 0, shares: 50, markPrice: 0.9 };
    const fixture = dependencies({
      readBook: vi.fn().mockResolvedValueOnce(book()).mockResolvedValueOnce(book({ positions: [profitable] })),
    });
    await runEventCycle(fixture.value);
    expect(fixture.quoteSell).not.toHaveBeenCalled();
    expect(fixture.value.quoteCandidates).toHaveBeenCalledOnce();
    expect(fixture.value.preflightTournamentPlans).toHaveBeenCalledOnce();
    expect(fixture.value.managePositions).not.toHaveBeenCalled();
    expect(fixture.value.trade).toHaveBeenCalledOnce();
  });

  it("performs no save, management, or trade when the podium preflight rejects capacity", async () => {
    const fixture = dependencies({
      preflightTournamentPlans: vi.fn(async () => ({
        plans: [],
        failures: [`${MARKET_ID}:podium_target_not_cleared`],
      })),
    });
    await expect(runEventCycle(fixture.value)).resolves.toMatchObject({
      status: "EVENT_BLOCKED_BY_TOURNAMENT_GUARD",
      quoteFailures: [`${MARKET_ID}:podium_target_not_cleared`],
    });
    expect(fixture.value.saveAssessments).not.toHaveBeenCalled();
    expect(fixture.value.managePositions).not.toHaveBeenCalled();
    expect(fixture.value.trade).not.toHaveBeenCalled();
  });

  it("relies on the ledger-backed trade cycle to make a repeated source fact exactly once", async () => {
    const fixture = dependencies();
    let executed = false;
    fixture.value.trade = vi.fn(async () => {
      if (executed) return { status: "NO_TRADE", reason: "already executed" };
      executed = true;
      await fixture.buyShares({});
      return { status: "TRADED" };
    });
    await runEventCycle(fixture.value);
    await runEventCycle(fixture.value);
    expect(fixture.buyShares).toHaveBeenCalledOnce();
  });

  it("blocks assessment and SDK writes when an intent is unresolved", async () => {
    const fixture = dependencies({
      assertNoPendingIntents: vi.fn(async () => { throw new Error("unresolved trade intent"); }),
    });
    await expect(runEventCycle(fixture.value)).rejects.toThrow("unresolved trade intent");
    expect(fixture.value.saveAssessments).not.toHaveBeenCalled();
    expect(fixture.value.managePositions).not.toHaveBeenCalled();
    expect(fixture.value.trade).not.toHaveBeenCalled();
    expect(fixture.ensureTokenApproval).not.toHaveBeenCalled();
    expect(fixture.buyShares).not.toHaveBeenCalled();
    expect(fixture.sellShares).not.toHaveBeenCalled();
  });

  it("blocks every write when the market closes between source fetch and the fresh book", async () => {
    const closed = { ...market, status: "awaiting_settlement" };
    const fixture = dependencies({
      readBook: vi.fn()
        .mockResolvedValueOnce(book())
        .mockResolvedValueOnce(book({ markets: [closed, otherMarket] })),
    });
    await expect(runEventCycle(fixture.value)).resolves.toMatchObject({ status: "EVENT_STALE_BEFORE_QUOTE" });
    expect(fixture.value.selectCandidates).not.toHaveBeenCalled();
    expect(fixture.value.quoteCandidates).not.toHaveBeenCalled();
    expect(fixture.value.saveAssessments).not.toHaveBeenCalled();
    expect(fixture.value.managePositions).not.toHaveBeenCalled();
    expect(fixture.value.trade).not.toHaveBeenCalled();
  });
});
