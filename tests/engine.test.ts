import { describe, expect, it, vi } from "vitest";
import type { Candidate, Policy, QuotedPlan } from "../src/model.js";
import {
  executeQuotedPlan,
  hasConfirmedExactResultExecution,
  isPlanExecutableAt,
  isPlanWithinBookLimits,
  preflightTournamentExactPlan,
  quoteCandidates,
  type TournamentPreflightResult,
} from "../src/engine.js";
import type { PodiumSnapshot } from "../src/podium-monitor.js";

const policy: Policy = {
  competitionEndsAt: "2026-08-23T23:59:00.000Z", minimumStartingTst: 1000, minimumGasEth: 0.001,
  minimumNetEdge: 0.08, minimumPublishedResultNetEdge: 0.02, minimumOfficialScheduleNetEdge: 0.04,
  maximumMarketAllocationPct: 35, maximumPortfolioAllocationPct: 90, maximumOrderTst: 250,
  maximumPublishedResultMarketAllocationPct: 85, maximumPublishedResultPortfolioAllocationPct: 95,
  maximumPublishedResultOrderTst: 850, minimumFullOrderTst: 5, maximumPriceImpact: 0.04,
  maximumPublishedResultPriceImpact: 0.2, slippagePct: 2, maximumNewTradesPerCycle: 1,
  minimumEvidenceSources: 1, maximumAssessmentAgeMinutes: 30, canaryMaximumTst: 1, qualificationFallback: "none",
};

const tournamentPolicy: Policy = {
  ...policy,
  maximumTournamentExactResultOrderTst: 1350,
  maximumTournamentEquityAllocationPct: 95,
  minimumTournamentPodiumBufferTst: 300,
  maximumTournamentLeaderboardAgeSeconds: 45,
  maximumTournamentQuoteAgeSeconds: 15,
};

function candidate(id: string, probability: number, spotPrice: number): Candidate {
  const marketId = `0x${id.repeat(40)}` as `0x${string}`;
  return {
    spotPrice,
    rawEdge: probability - spotPrice,
    existingMarketValue: 0,
    existingMarketShares: 0,
    existingPortfolioValue: 0,
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
    quotedAt: "2026-08-13T11:59:55.000Z",
    shares: 50,
    quotedCostTst: 35,
    maximumCostTst: 35.7,
    maximumCostAtomic: 35_700_000n,
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

  it("rechecks deterministic-result cash exposure against the latest book", () => {
    expect(isPlanWithinBookLimits({ plan, policy, book })).toBe(true);
    expect(isPlanWithinBookLimits({ plan, policy, book: { ...book, totalEquityTst: 625 } })).toBe(false);
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

describe("guarded tournament execution", () => {
  const published = {
    ...candidate("f", 0.99, 0.4),
    assessment: {
      ...candidate("f", 0.99, 0.4).assessment,
      evidenceClass: "published_result" as const,
      probability: 0.99,
      observedAt: "2026-08-13T11:59:00.000Z",
      expiresAt: "2026-08-13T12:10:00.000Z",
    },
  };
  const plan: QuotedPlan = {
    ...published,
    quotedAt: "2026-08-13T11:59:55.000Z",
    shares: 100,
    quotedCostTst: 40,
    maximumCostTst: 40.8,
    maximumCostAtomic: 40_800_000n,
    averagePrice: 0.4,
    maximumAveragePrice: 0.408,
    netEdge: 0.582,
    priceImpact: 0.008,
    worstCaseExpectedProfitTst: 58.2,
    mode: "full",
    decisionId: "f".repeat(64),
  };
  const flatBook = {
    rawMarkets: [],
    rawPositions: [],
    markets: [published.market],
    positions: [],
    availableTst: 1000,
    gasEth: 1,
    deployedValueTst: 0,
    totalEquityTst: 1000,
  };

  function executionFixture() {
    const ledger = {
      get: vi.fn(async () => null),
      prepare: vi.fn(async () => undefined),
      discardPrepared: vi.fn(async () => undefined),
      confirm: vi.fn(async () => undefined),
    };
    const client = {
      ensureTokenApproval: vi.fn(async () => ({ approvalNeeded: false, allowance: 100_000_000n })),
      buyShares: vi.fn(async () => ({ transactionHash: `0x${"a".repeat(64)}` })),
    };
    return { ledger, client };
  }

  it("discards PREPARED and never buys when the second podium guard rejects", async () => {
    const fixture = executionFixture();
    const preflight = vi.fn()
      .mockResolvedValueOnce({ allowed: true } as TournamentPreflightResult)
      .mockResolvedValueOnce({
        allowed: false,
        reason: "podium_target_not_cleared",
      } as TournamentPreflightResult);
    await expect(executeQuotedPlan({
      client: fixture.client as never,
      plan,
      policy: tournamentPolicy,
      ledger: fixture.ledger,
      now: () => Date.parse("2026-08-13T12:00:00.000Z"),
      readBook: vi.fn(async () => flatBook),
      preflightTournament: preflight,
      exactResultExecutionEnabled: () => true,
    })).resolves.toEqual({
      status: "SKIPPED",
      reason: "post_approval_tournament_preflight:podium_target_not_cleared",
    });
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(fixture.ledger.prepare).toHaveBeenCalledOnce();
    expect(fixture.ledger.discardPrepared).toHaveBeenCalledWith(plan.decisionId);
    expect(fixture.client.buyShares).not.toHaveBeenCalled();
    expect(fixture.ledger.confirm).not.toHaveBeenCalled();
  });

  it("buys exactly once with the original atomic ceiling after two fresh guards pass", async () => {
    const fixture = executionFixture();
    const preflight = vi.fn(async () => ({ allowed: true } as TournamentPreflightResult));
    await expect(executeQuotedPlan({
      client: fixture.client as never,
      plan,
      policy: tournamentPolicy,
      ledger: fixture.ledger,
      now: () => Date.parse("2026-08-13T12:00:00.000Z"),
      readBook: vi.fn(async () => flatBook),
      preflightTournament: preflight,
      exactResultExecutionEnabled: () => true,
    })).resolves.toEqual({
      status: "TRADED",
      transactionHash: `0x${"a".repeat(64)}`,
    });
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(fixture.client.buyShares).toHaveBeenCalledOnce();
    expect(fixture.client.buyShares).toHaveBeenCalledWith({
      marketAddress: plan.market.id,
      outcomeIdx: plan.assessment.outcomeIndex,
      sharesOut: 100n * 10n ** 18n,
      maxTokensIn: plan.maximumCostAtomic,
    });
    expect(fixture.ledger.confirm).toHaveBeenCalledWith(
      plan.decisionId,
      `0x${"a".repeat(64)}`,
    );
  });

  it("fails closed before approval when exact-result execution is disabled", async () => {
    const fixture = executionFixture();
    const preflight = vi.fn(async () => ({ allowed: true } as TournamentPreflightResult));
    await expect(executeQuotedPlan({
      client: fixture.client as never,
      plan,
      policy: tournamentPolicy,
      ledger: fixture.ledger,
      now: () => Date.parse("2026-08-13T12:00:00.000Z"),
      readBook: vi.fn(async () => flatBook),
      preflightTournament: preflight,
      exactResultExecutionEnabled: () => false,
    })).resolves.toEqual({
      status: "SKIPPED",
      reason: "exact_result_execution_disabled",
    });
    expect(fixture.ledger.prepare).not.toHaveBeenCalled();
    expect(fixture.client.ensureTokenApproval).not.toHaveBeenCalled();
    expect(fixture.client.buyShares).not.toHaveBeenCalled();
  });

  it("discards PREPARED if exact-result execution is disabled during approval", async () => {
    const fixture = executionFixture();
    const preflight = vi.fn(async () => ({ allowed: true } as TournamentPreflightResult));
    const exactResultExecutionEnabled = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    await expect(executeQuotedPlan({
      client: fixture.client as never,
      plan,
      policy: tournamentPolicy,
      ledger: fixture.ledger,
      now: () => Date.parse("2026-08-13T12:00:00.000Z"),
      readBook: vi.fn(async () => flatBook),
      preflightTournament: preflight,
      exactResultExecutionEnabled,
    })).resolves.toEqual({
      status: "SKIPPED",
      reason: "post_approval_exact_result_execution_disabled",
    });
    expect(fixture.ledger.prepare).toHaveBeenCalledOnce();
    expect(fixture.ledger.discardPrepared).toHaveBeenCalledWith(plan.decisionId);
    expect(fixture.client.buyShares).not.toHaveBeenCalled();
  });

  it("fails closed for an exact-result canary plan when no flag callback is provided", async () => {
    const fixture = executionFixture();
    const canaryPlan = { ...plan, mode: "canary" as const };
    await expect(executeQuotedPlan({
      client: fixture.client as never,
      plan: canaryPlan,
      policy: tournamentPolicy,
      ledger: fixture.ledger,
      now: () => Date.parse("2026-08-13T12:00:00.000Z"),
      readBook: vi.fn(async () => flatBook),
      preflightTournament: vi.fn(async () => ({ allowed: true } as TournamentPreflightResult)),
    })).resolves.toEqual({
      status: "SKIPPED",
      reason: "exact_result_execution_disabled",
    });
    expect(fixture.ledger.prepare).not.toHaveBeenCalled();
    expect(fixture.client.ensureTokenApproval).not.toHaveBeenCalled();
    expect(fixture.client.buyShares).not.toHaveBeenCalled();
  });

  it("rechecks the exact-result flag at the final no-await boundary", async () => {
    const fixture = executionFixture();
    const preflight = vi.fn(async () => ({ allowed: true } as TournamentPreflightResult));
    const exactResultExecutionEnabled = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    await expect(executeQuotedPlan({
      client: fixture.client as never,
      plan,
      policy: tournamentPolicy,
      ledger: fixture.ledger,
      now: () => Date.parse("2026-08-13T12:00:00.000Z"),
      readBook: vi.fn(async () => flatBook),
      preflightTournament: preflight,
      exactResultExecutionEnabled,
    })).resolves.toEqual({
      status: "SKIPPED",
      reason: "final_exact_result_execution_disabled",
    });
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(fixture.ledger.prepare).toHaveBeenCalledOnce();
    expect(fixture.ledger.discardPrepared).toHaveBeenCalledWith(plan.decisionId);
    expect(fixture.client.buyShares).not.toHaveBeenCalled();
  });

  it("blocks a replay even when a later quote would have a different decision ID", () => {
    expect(hasConfirmedExactResultExecution({
      records: [{
        decisionId: "1".repeat(64),
        marketId: plan.market.id,
        outcomeIndex: plan.assessment.outcomeIndex,
        shares: 1,
        quotedCostTst: 1,
        assessmentEvidenceClass: "published_result",
        status: "CONFIRMED",
        createdAt: 1,
        transactionHash: `0x${"2".repeat(64)}`,
      }],
      marketId: plan.market.id,
      outcomeIndex: plan.assessment.outcomeIndex,
    })).toBe(true);
  });
});

describe("official-PnL tournament preflight", () => {
  it("ignores inconsistent accountValue and uses official PnL plus the maximum-cost winning payout floor", async () => {
    const base = candidate("9", 0.99, 0.132989);
    const freshMarket = {
      ...base.market,
      resolvesAt: "2026-08-21T03:59:00.000Z",
      settlesAt: "2026-08-23T03:59:00.000Z",
    };
    const plan: QuotedPlan = {
      ...base,
      market: freshMarket,
      assessment: {
        ...base.assessment,
        evidenceClass: "published_result",
        probability: 0.99,
        observedAt: "2026-08-19T15:59:55.000Z",
        expiresAt: "2026-08-19T16:05:00.000Z",
      },
      quotedAt: "2026-08-19T15:59:58.000Z",
      shares: 5280.45,
      quotedCostTst: 1176,
      maximumCostTst: 1199.560337,
      maximumCostAtomic: 1_199_560_337n,
      averagePrice: 1176 / 5280.45,
      maximumAveragePrice: 1199.560337 / 5280.45,
      netEdge: 0.75,
      priceImpact: 0.094,
      worstCaseExpectedProfitTst: 4028,
      mode: "full",
      decisionId: "9".repeat(64),
    };
    const book = {
      rawMarkets: [], rawPositions: [], markets: [freshMarket], positions: [],
      availableTst: 1422.528949, gasEth: 1, deployedValueTst: 0, totalEquityTst: 1422.528949,
    };
    const snapshot = {
      version: 1,
      observedAt: "2026-08-19T15:59:40.000Z",
      sourceUrl: "https://competition.delphi.fyi/",
      third: {
        rank: 3, address: `0x${"3".repeat(40)}`, name: "Third",
        accountValue: 4339.9, cash: 100, pnl: 3638.812186,
        tradesVolume: 1, tradesCount: 1,
      },
      conviction: {
        rank: 30, address: "0x86bE235Bb9Aa6D9E2Cf89b2f4E9c90e1ecb7C781", name: "Conviction",
        accountValue: 9999, cash: 1422.528949, pnl: 422.528949,
        tradesVolume: 1, tradesCount: 26,
      },
      thirdPlacePnlTst: 3638.812186,
      convictionPnlTst: 422.528949,
      gapToThirdPnlTst: 3216.283237,
    } as PodiumSnapshot;
    const result = await preflightTournamentExactPlan({
      client: { quoteBuy: vi.fn(async () => ({ tokensIn: 1_176_000_000n })) },
      plan,
      policy: tournamentPolicy,
      book,
      now: () => Date.parse("2026-08-19T16:00:00.000Z"),
      loadPodium: vi.fn(async () => snapshot),
    });
    expect(result).toMatchObject({
      allowed: true,
      route: "direct_podium",
      directProjectedPnlTst: 4503.418612,
      requiredFinalPnlTst: 3938.812186,
    });
  });

  it("uses the fresh SDK settlement timestamp to admit a near-podium Gemini-sized exact win", async () => {
    const base = candidate("8", 0.99, 0.14);
    const planMarket = {
      ...base.market,
      resolvesAt: "2026-08-21T03:59:00.000Z",
    };
    const freshMarket = {
      ...planMarket,
      settlesAt: "2026-08-23T03:59:00.000Z",
    };
    const plan: QuotedPlan = {
      ...base,
      market: planMarket,
      assessment: {
        ...base.assessment,
        evidenceClass: "published_result",
        probability: 0.99,
        observedAt: "2026-08-19T15:59:55.000Z",
        expiresAt: "2026-08-19T16:05:00.000Z",
      },
      quotedAt: "2026-08-19T15:59:58.000Z",
      shares: 4737,
      quotedCostTst: 1320,
      maximumCostTst: 1348,
      maximumCostAtomic: 1_348_000_000n,
      averagePrice: 1320 / 4737,
      maximumAveragePrice: 1348 / 4737,
      netEdge: 0.99 - 1348 / 4737,
      priceImpact: 1348 / 4737 - 0.14,
      worstCaseExpectedProfitTst: 4737 * 0.99 - 1348,
      mode: "full",
      decisionId: "8".repeat(64),
    };
    const book = {
      rawMarkets: [], rawPositions: [], markets: [freshMarket], positions: [],
      availableTst: 1422.528949, gasEth: 1, deployedValueTst: 0, totalEquityTst: 1422.528949,
    };
    const snapshot = {
      version: 1,
      observedAt: "2026-08-19T15:59:40.000Z",
      sourceUrl: "https://competition.delphi.fyi/",
      third: {
        rank: 3, address: `0x${"3".repeat(40)}`, name: "Third",
        accountValue: 5315, cash: 100, pnl: 4315,
        tradesVolume: 1, tradesCount: 1,
      },
      conviction: {
        rank: 30, address: "0x86bE235Bb9Aa6D9E2Cf89b2f4E9c90e1ecb7C781", name: "Conviction",
        accountValue: 1422.528949, cash: 1422.528949, pnl: 422.528949,
        tradesVolume: 1, tradesCount: 26,
      },
      thirdPlacePnlTst: 4315,
      convictionPnlTst: 422.528949,
      gapToThirdPnlTst: 3892.471051,
    } as PodiumSnapshot;
    const result = await preflightTournamentExactPlan({
      client: { quoteBuy: vi.fn(async () => ({ tokensIn: 1_320_000_000n })) },
      plan,
      policy: tournamentPolicy,
      book,
      now: () => Date.parse("2026-08-19T16:00:00.000Z"),
      loadPodium: vi.fn(async () => snapshot),
    });
    expect(result).toMatchObject({
      allowed: true,
      route: "near_podium_exact",
      freshQuotedCostTst: 1320,
    });
    expect(result.allowed && result.directProjectedPnlTst).toBeCloseTo(3811.528949);
  });

  it("fails the near-podium preflight closed when the fresh market omits settlement time", async () => {
    const base = candidate("7", 0.99, 0.14);
    const freshMarket = {
      ...base.market,
      resolvesAt: "2026-08-21T03:59:00.000Z",
      settlesAt: null,
    };
    const plan: QuotedPlan = {
      ...base,
      market: freshMarket,
      assessment: {
        ...base.assessment,
        evidenceClass: "published_result",
        probability: 0.99,
        observedAt: "2026-08-19T15:59:55.000Z",
        expiresAt: "2026-08-19T16:05:00.000Z",
      },
      quotedAt: "2026-08-19T15:59:58.000Z",
      shares: 4737,
      quotedCostTst: 1320,
      maximumCostTst: 1348,
      maximumCostAtomic: 1_348_000_000n,
      averagePrice: 1320 / 4737,
      maximumAveragePrice: 1348 / 4737,
      netEdge: 0.99 - 1348 / 4737,
      priceImpact: 1348 / 4737 - 0.14,
      worstCaseExpectedProfitTst: 4737 * 0.99 - 1348,
      mode: "full",
      decisionId: "7".repeat(64),
    };
    const book = {
      rawMarkets: [], rawPositions: [], markets: [freshMarket], positions: [],
      availableTst: 1422.528949, gasEth: 1, deployedValueTst: 0, totalEquityTst: 1422.528949,
    };
    const snapshot = {
      version: 1,
      observedAt: "2026-08-19T15:59:40.000Z",
      sourceUrl: "https://competition.delphi.fyi/",
      third: {
        rank: 3, address: `0x${"3".repeat(40)}`, name: "Third",
        accountValue: 5315, cash: 100, pnl: 4315,
        tradesVolume: 1, tradesCount: 1,
      },
      conviction: {
        rank: 30, address: "0x86bE235Bb9Aa6D9E2Cf89b2f4E9c90e1ecb7C781", name: "Conviction",
        accountValue: 1422.528949, cash: 1422.528949, pnl: 422.528949,
        tradesVolume: 1, tradesCount: 26,
      },
      thirdPlacePnlTst: 4315,
      convictionPnlTst: 422.528949,
      gapToThirdPnlTst: 3892.471051,
    } as PodiumSnapshot;
    await expect(preflightTournamentExactPlan({
      client: { quoteBuy: vi.fn(async () => ({ tokensIn: 1_320_000_000n })) },
      plan,
      policy: tournamentPolicy,
      book,
      now: () => Date.parse("2026-08-19T16:00:00.000Z"),
      loadPodium: vi.fn(async () => snapshot),
    })).resolves.toEqual({
      allowed: false,
      reason: "settlement_missing_or_invalid",
      freshQuotedCostTst: 1320,
    });
  });
});
