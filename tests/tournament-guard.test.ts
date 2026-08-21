import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { policySchema, type Assessment, type Policy } from "../src/model.js";
import {
  guardTournamentExactResult,
  MATERIAL_EXACT_PODIUM_GAP_FRACTION,
  maximumTournamentExactResultCost,
  type TournamentExactQuote,
  type VerifiedPairedBranchTarget,
} from "../src/tournament-guard.js";

const NOW = Date.parse("2026-08-19T16:00:00.000Z");
const MARKET_ID = "0x1111111111111111111111111111111111111111" as const;

const POLICY: Policy = {
  competitionEndsAt: "2026-08-23T23:59:00.000Z",
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
  maximumTournamentExactResultOrderTst: 1350,
  maximumTournamentEquityAllocationPct: 95,
  minimumTournamentPodiumBufferTst: 300,
  maximumTournamentLeaderboardAgeSeconds: 45,
  maximumTournamentQuoteAgeSeconds: 15,
  slippagePct: 2,
  maximumNewTradesPerCycle: 1,
  minimumEvidenceSources: 1,
  maximumAssessmentAgeMinutes: 30,
  canaryMaximumTst: 1,
  qualificationFallback: "none",
};

const ASSESSMENT: Assessment = {
  marketId: MARKET_ID,
  outcomeIndex: 0,
  evidenceClass: "published_result",
  probability: 0.99,
  confidence: "high",
  status: "actionable",
  observedAt: "2026-08-19T15:59:55.000Z",
  expiresAt: "2026-08-19T16:01:00.000Z",
  rationale: "The authoritative source has published the exact market result.",
  sources: [{
    url: "https://example.com/official-result",
    kind: "authoritative",
    observedAt: "2026-08-19T15:59:54.000Z",
    valueHash: "a".repeat(64),
  }],
};

const QUOTE: TournamentExactQuote = {
  observedAt: "2026-08-19T15:59:58.000Z",
  decisionId: "decision-1",
  marketId: MARKET_ID,
  outcomeIndex: 0,
  shares: 5280.45,
  maximumCostTst: 1199.560337,
  priceImpact: 0.094181,
  settlesAt: "2026-08-23T03:59:00.000Z",
  assessment: ASSESSMENT,
};

const BOOK = {
  totalEquityTst: 1422.528949,
  availableTst: 1422.528949,
  deployedValueTst: 0,
  positionCount: 0,
};

const LEADERBOARD = {
  observedAt: "2026-08-19T15:59:30.000Z",
  initialTst: 1000,
  liveThirdPlacePnlTst: 3638.812186,
  convictionPnlTst: 422.528949,
  convictionCashTst: 1422.528949,
};

describe("tournament exact-result sizing", () => {
  it("caps an empty book by the absolute 1350 TST tournament limit", () => {
    expect(maximumTournamentExactResultCost({ policy: POLICY, book: BOOK })).toBe(1350);
  });

  it("uses the tighter 95% portfolio room and cash limits", () => {
    expect(maximumTournamentExactResultCost({
      policy: POLICY,
      book: { ...BOOK, availableTst: 1122.528949, deployedValueTst: 300, positionCount: 1 },
    })).toBeCloseTo(1051.40250155);
    expect(maximumTournamentExactResultCost({
      policy: POLICY,
      book: { totalEquityTst: 900, availableTst: 900, deployedValueTst: 0, positionCount: 0 },
    })).toBe(855);
  });

  it("fails closed when tournament policy is absent", () => {
    const policy = { ...POLICY, maximumTournamentExactResultOrderTst: undefined };
    expect(maximumTournamentExactResultCost({ policy, book: BOOK })).toBeNull();
    expect(guardTournamentExactResult({
      policy,
      now: NOW,
      book: BOOK,
      leaderboard: LEADERBOARD,
      quote: QUOTE,
    })).toEqual({ allowed: false, reason: "tournament_policy_missing_or_invalid" });
  });
});

describe("podium tournament guard", () => {
  it("allows a deterministic quote that clears the live target and buffer", () => {
    const result = guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: LEADERBOARD,
      quote: QUOTE,
    });
    expect(result).toMatchObject({
      allowed: true,
      route: "direct_podium",
      maximumAuthorizedCostTst: 1350,
      podiumTargetPnlTst: 3638.812186,
      requiredFinalPnlTst: 3938.812186,
    });
    expect(result.allowed && result.directProjectedFinalEquityTst).toBeCloseTo(5503.418612);
    expect(result.allowed && result.directProjectedPnlTst).toBeCloseTo(4503.418612);
  });

  it("keeps near-podium ahead of material-exact when both fallbacks qualify", () => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: { ...LEADERBOARD, projectedThirdPlacePnlTst: 4300 },
      quote: QUOTE,
    })).toMatchObject({ allowed: true, route: "near_podium_exact" });
  });

  it("rejects material-exact when a higher projected podium target makes its profit immaterial", () => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: { ...LEADERBOARD, projectedThirdPlacePnlTst: 10_000 },
      quote: QUOTE,
    })).toEqual({ allowed: false, reason: "material_exact_profit_too_small" });
  });

  it("keeps direct podium first when the quote also satisfies the near-podium fallback", () => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: LEADERBOARD,
      quote: QUOTE,
    })).toMatchObject({ allowed: true, route: "direct_podium" });
  });

  it.each([
    null,
    "not-a-timestamp",
    "2026-08-19T16:00:00.000Z",
  ])("rejects direct-podium payout math without a valid future settlement: %s", (settlesAt) => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: LEADERBOARD,
      quote: { ...QUOTE, settlesAt },
    })).toEqual({ allowed: false, reason: "settlement_missing_or_invalid" });
  });

  it.each([
    "2026-08-23T23:59:00.000Z",
    "2026-08-24T00:00:00.000Z",
  ])("rejects direct-podium payout scheduled at or after final scoring: %s", (settlesAt) => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: LEADERBOARD,
      quote: { ...QUOTE, settlesAt },
    })).toEqual({ allowed: false, reason: "settlement_after_competition" });
  });

  it("fails closed when the book is nonflat or disagrees with official Conviction PnL/cash", () => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: { ...BOOK, positionCount: 1, deployedValueTst: 100, availableTst: 1322.528949 },
      leaderboard: LEADERBOARD,
      quote: QUOTE,
    })).toEqual({ allowed: false, reason: "book_not_flat" });
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: { ...LEADERBOARD, convictionCashTst: 1400 },
      quote: QUOTE,
    })).toEqual({ allowed: false, reason: "leaderboard_book_mismatch" });
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: { ...LEADERBOARD, convictionPnlTst: 400 },
      quote: QUOTE,
    })).toEqual({ allowed: false, reason: "leaderboard_book_mismatch" });
  });

  it("allows a short direct quote only with a fresh locked paired-branch floor", () => {
    const quote = { ...QUOTE, shares: 3230.73, maximumCostTst: 1075.041986 };
    const pairedBranch: VerifiedPairedBranchTarget = {
      verification: "locked_net_equity_floor",
      verified: true,
      verifiedAt: "2026-08-19T15:59:50.000Z",
      expiresAt: "2026-08-19T16:05:00.000Z",
      evidenceIds: ["settled-branch-1"],
      additionalNetEquityFloorTst: 1475,
    };
    const result = guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: LEADERBOARD,
      quote,
      pairedBranch,
    });
    expect(result).toMatchObject({
      allowed: true,
      route: "verified_paired_branch",
    });
    expect(result.allowed && result.projectedFinalEquityTst).toBeCloseTo(5053.216963);
  });

  it("does not let a locked paired branch bypass the final-scoring settlement gate", () => {
    const quote = {
      ...QUOTE,
      shares: 3230.73,
      maximumCostTst: 1075.041986,
      settlesAt: "2026-08-24T00:00:00.000Z",
    };
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: LEADERBOARD,
      quote,
      pairedBranch: {
        verification: "locked_net_equity_floor",
        verified: true,
        verifiedAt: "2026-08-19T15:59:50.000Z",
        expiresAt: "2026-08-19T16:05:00.000Z",
        evidenceIds: ["settled-branch-1"],
        additionalNetEquityFloorTst: 1475,
      },
    })).toEqual({ allowed: false, reason: "settlement_after_competition" });
  });

  it("rejects an expired paired branch instead of treating it as a podium path", () => {
    const quote = { ...QUOTE, shares: 3230.73, maximumCostTst: 1075.041986 };
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: LEADERBOARD,
      quote,
      pairedBranch: {
        verification: "locked_net_equity_floor",
        verified: true,
        verifiedAt: "2026-08-19T15:50:00.000Z",
        expiresAt: "2026-08-19T15:59:59.000Z",
        evidenceIds: ["settled-branch-1"],
        additionalNetEquityFloorTst: 1475,
      },
    })).toEqual({ allowed: false, reason: "paired_branch_stale" });
  });

  it.each([
    [undefined, "leaderboard_missing_or_invalid"],
    [{ ...LEADERBOARD, initialTst: 999 }, "leaderboard_missing_or_invalid"],
    [{ ...LEADERBOARD, observedAt: "2026-08-19T15:59:14.000Z" }, "leaderboard_stale"],
  ] as const)("fails closed on a missing or stale leaderboard", (leaderboard, reason) => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard,
      quote: QUOTE,
    })).toEqual({ allowed: false, reason });
  });

  it.each([
    [undefined, "quote_missing_or_invalid"],
    [{ ...QUOTE, observedAt: "2026-08-19T15:59:44.000Z" }, "quote_stale"],
    [{ ...QUOTE, observedAt: "2026-08-19T15:59:54.000Z" }, "quote_precedes_exact_evidence"],
  ] as const)("fails closed on a missing, stale, or pre-evidence quote", (quote, reason) => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: LEADERBOARD,
      quote,
    })).toEqual({ allowed: false, reason });
  });

  it.each([
    [{ ...ASSESSMENT, evidenceClass: "forecast" as const }, "not_deterministic_exact_result"],
    [{ ...ASSESSMENT, probability: 0.98 }, "not_deterministic_exact_result"],
    [{ ...ASSESSMENT, confidence: "medium" as const }, "not_deterministic_exact_result"],
    [{ ...ASSESSMENT, status: "watch" as const }, "not_deterministic_exact_result"],
  ] as const)("rejects a non-deterministic exact-result label", (assessment, reason) => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: LEADERBOARD,
      quote: { ...QUOTE, assessment },
    })).toEqual({ allowed: false, reason });
  });

  it("rejects quotes above the dynamic cost or exact-result impact limits", () => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: LEADERBOARD,
      quote: { ...QUOTE, maximumCostTst: 1350.000001 },
    })).toEqual({ allowed: false, reason: "quote_exceeds_dynamic_cost_cap" });
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: LEADERBOARD,
      quote: { ...QUOTE, priceImpact: 0.200001 },
    })).toEqual({ allowed: false, reason: "quote_exceeds_exact_impact_cap" });
  });

  it("admits a Gemini-sized exact win that lands within one starting bankroll of the live podium", () => {
    const result = guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: { ...LEADERBOARD, liveThirdPlacePnlTst: 4315 },
      quote: {
        ...QUOTE,
        shares: 4737,
        maximumCostTst: 1348,
        priceImpact: 0.19,
        settlesAt: "2026-08-23T03:59:00.000Z",
      },
    });
    expect(result).toMatchObject({
      allowed: true,
      route: "near_podium_exact",
    });
    expect(result.allowed && result.directProjectedPnlTst).toBeCloseTo(3811.528949);
  });

  it("rejects a UAP-sized exact win below half of the fresh podium gap", () => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: { ...LEADERBOARD, liveThirdPlacePnlTst: 4315 },
      quote: {
        ...QUOTE,
        shares: 2843.15,
        maximumCostTst: 1081.232819,
        priceImpact: 0.15,
        settlesAt: "2026-08-23T03:59:00.000Z",
      },
    })).toEqual({ allowed: false, reason: "material_exact_profit_too_small" });
  });

  it("admits the current UAP quote through the bounded material-exact route", () => {
    const now = Date.parse("2026-08-21T06:39:00.000Z");
    const assessment: Assessment = {
      ...ASSESSMENT,
      observedAt: "2026-08-21T06:38:55.000Z",
      expiresAt: "2026-08-21T06:45:00.000Z",
      sources: [{
        ...ASSESSMENT.sources[0]!,
        observedAt: "2026-08-21T06:38:54.000Z",
      }],
    };
    const policy = { ...POLICY, competitionEndsAt: "2026-08-24T13:00:00.000Z" };
    const leaderboard = {
      ...LEADERBOARD,
      observedAt: "2026-08-21T06:38:30.000Z",
      liveThirdPlacePnlTst: 7074.493784,
    };
    const quote = {
      ...QUOTE,
      observedAt: "2026-08-21T06:38:58.000Z",
      shares: 4577.5,
      maximumCostTst: 1176.591,
      priceImpact: 0.15,
      settlesAt: "2026-08-23T14:00:00.000Z",
      assessment,
    };
    const result = guardTournamentExactResult({
      policy,
      now,
      book: BOOK,
      leaderboard,
      quote,
    });
    expect(result).toMatchObject({
      allowed: true,
      route: "material_exact",
      podiumTargetPnlTst: 7074.493784,
    });
    expect(result.allowed && result.directProjectedPnlTst).toBeCloseTo(3823.437949);
    expect(quote.shares - quote.maximumCostTst).toBeGreaterThanOrEqual(
      (leaderboard.liveThirdPlacePnlTst - LEADERBOARD.convictionPnlTst) *
        MATERIAL_EXACT_PODIUM_GAP_FRACTION,
    );

    const exactHalfGapTst =
      (leaderboard.liveThirdPlacePnlTst - leaderboard.convictionPnlTst) *
      MATERIAL_EXACT_PODIUM_GAP_FRACTION;
    expect(guardTournamentExactResult({
      policy,
      now,
      book: BOOK,
      leaderboard,
      quote: {
        ...quote,
        shares: quote.maximumCostTst + exactHalfGapTst,
      },
    })).toMatchObject({ allowed: true, route: "material_exact" });
    expect(guardTournamentExactResult({
      policy,
      now,
      book: BOOK,
      leaderboard,
      quote: {
        ...quote,
        shares: quote.maximumCostTst + exactHalfGapTst - 0.000001,
      },
    })).toEqual({ allowed: false, reason: "material_exact_profit_too_small" });
  });

  it("uses the higher projected target for the material-exact profit floor", () => {
    const liveThirdPlacePnlTst = LEADERBOARD.convictionPnlTst + 4000;
    const projectedThirdPlacePnlTst = LEADERBOARD.convictionPnlTst + 6000;
    const quote = {
      ...QUOTE,
      shares: 3500,
      maximumCostTst: 1000,
      priceImpact: 0.1,
    };
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: { ...LEADERBOARD, liveThirdPlacePnlTst },
      quote,
    })).toMatchObject({ allowed: true, route: "material_exact" });
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: {
        ...LEADERBOARD,
        liveThirdPlacePnlTst,
        projectedThirdPlacePnlTst,
      },
      quote,
    })).toEqual({ allowed: false, reason: "material_exact_profit_too_small" });
  });

  it("preserves the absolute 500 TST floor for a Section-sized exact win", () => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: { ...LEADERBOARD, liveThirdPlacePnlTst: 4315 },
      quote: {
        ...QUOTE,
        shares: 1300,
        maximumCostTst: 900,
        priceImpact: 0.1,
        settlesAt: "2026-08-22T00:00:00.000Z",
      },
    })).toEqual({ allowed: false, reason: "near_podium_profit_too_small" });
  });

  it("accepts the exact 50% gap boundary and rejects the first amount below it", () => {
    const leaderboard = { ...LEADERBOARD, liveThirdPlacePnlTst: 1422.528949 };
    expect(MATERIAL_EXACT_PODIUM_GAP_FRACTION).toBe(0.5);
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard,
      quote: { ...QUOTE, shares: 600, maximumCostTst: 100, priceImpact: 0.1 },
    })).toMatchObject({ allowed: true, route: "near_podium_exact" });
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard,
      quote: { ...QUOTE, shares: 599.999999, maximumCostTst: 100, priceImpact: 0.1 },
    })).toEqual({ allowed: false, reason: "near_podium_profit_too_small" });
  });

  it("does not let a tiny podium gap admit a trivial exact payout", () => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: {
        ...LEADERBOARD,
        liveThirdPlacePnlTst: LEADERBOARD.convictionPnlTst + 100,
      },
      quote: {
        ...QUOTE,
        shares: 200,
        maximumCostTst: 100,
        priceImpact: 0.1,
      },
    })).toEqual({ allowed: false, reason: "near_podium_profit_too_small" });
  });

  it("keeps near-podium at its residual-gap boundary, then falls through to material-exact", () => {
    const leaderboard = { ...LEADERBOARD, liveThirdPlacePnlTst: 4315 };
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard,
      quote: {
        ...QUOTE,
        shares: 3813.721051,
        maximumCostTst: 1000,
        priceImpact: 0.1,
      },
    })).toMatchObject({ allowed: true, route: "near_podium_exact" });
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard,
      quote: {
        ...QUOTE,
        shares: 3813.72105,
        maximumCostTst: 1000,
        priceImpact: 0.1,
      },
    })).toMatchObject({ allowed: true, route: "material_exact" });
  });

  it("rejects near-podium wins that cannot settle at least 18 hours before competition end", () => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: { ...LEADERBOARD, liveThirdPlacePnlTst: 4315 },
      quote: {
        ...QUOTE,
        shares: 4737,
        maximumCostTst: 1348,
        priceImpact: 0.19,
        settlesAt: "2026-08-23T06:00:00.000Z",
      },
    })).toEqual({ allowed: false, reason: "settlement_too_late_for_near_podium" });
  });

  it("applies the same inclusive 18-hour settlement lead to material-exact", () => {
    const leaderboard = {
      ...LEADERBOARD,
      liveThirdPlacePnlTst: LEADERBOARD.convictionPnlTst + 6000,
    };
    const quote = {
      ...QUOTE,
      shares: 4100,
      maximumCostTst: 1000,
      priceImpact: 0.1,
      settlesAt: "2026-08-23T05:59:00.000Z",
    };
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard,
      quote,
    })).toMatchObject({ allowed: true, route: "material_exact" });
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard,
      quote: { ...quote, settlesAt: "2026-08-23T06:00:00.000Z" },
    })).toEqual({ allowed: false, reason: "settlement_too_late_for_material_exact" });
  });

  it("accepts the exact 18-hour settlement boundary", () => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: { ...LEADERBOARD, liveThirdPlacePnlTst: 4315 },
      quote: {
        ...QUOTE,
        shares: 4737,
        maximumCostTst: 1348,
        priceImpact: 0.19,
        settlesAt: "2026-08-23T05:59:00.000Z",
      },
    })).toMatchObject({ allowed: true, route: "near_podium_exact" });
  });

  it.each([
    null,
    "not-a-timestamp",
    "2026-08-19T16:00:00.000Z",
  ])("fails closed on a missing, malformed, or non-future settlement timestamp: %s", (settlesAt) => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: { ...LEADERBOARD, liveThirdPlacePnlTst: 4315 },
      quote: {
        ...QUOTE,
        shares: 4737,
        maximumCostTst: 1348,
        priceImpact: 0.19,
        settlesAt,
      },
    })).toEqual({ allowed: false, reason: "settlement_missing_or_invalid" });
  });

  it("fails closed on future leaderboard, evidence, and quote timestamps", () => {
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: { ...LEADERBOARD, observedAt: "2026-08-19T16:00:00.001Z" },
      quote: QUOTE,
    })).toEqual({ allowed: false, reason: "leaderboard_missing_or_invalid" });
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: LEADERBOARD,
      quote: {
        ...QUOTE,
        assessment: {
          ...ASSESSMENT,
          observedAt: "2026-08-19T16:00:00.001Z",
        },
      },
    })).toEqual({ allowed: false, reason: "exact_evidence_stale_or_invalid" });
    expect(guardTournamentExactResult({
      policy: POLICY,
      now: NOW,
      book: BOOK,
      leaderboard: LEADERBOARD,
      quote: { ...QUOTE, observedAt: "2026-08-19T16:00:00.001Z" },
    })).toEqual({ allowed: false, reason: "quote_missing_or_invalid" });
  });
});

describe("production tournament policy", () => {
  it("parses the isolated tournament controls without loosening forecast sizing", async () => {
    const raw = JSON.parse(await readFile(new URL("../config/policy.json", import.meta.url), "utf8"));
    const policy = policySchema.parse(raw);
    expect(policy.competitionEndsAt).toBe("2026-08-24T13:00:00.000Z");
    expect(policy.maximumTournamentExactResultOrderTst).toBe(1350);
    expect(policy.maximumTournamentEquityAllocationPct).toBe(95);
    expect(policy.minimumTournamentPodiumBufferTst).toBe(300);
    expect(policy.maximumTournamentLeaderboardAgeSeconds).toBe(45);
    expect(policy.maximumOrderTst).toBe(250);
    expect(policy.maximumPriceImpact).toBe(0.04);
    expect(policy.maximumPublishedResultOrderTst).toBe(850);
  });

  it("rejects a tournament cap above the authorized hard bounds", () => {
    expect(policySchema.safeParse({
      ...POLICY,
      maximumTournamentExactResultOrderTst: 1350.01,
    }).success).toBe(false);
    expect(policySchema.safeParse({
      ...POLICY,
      maximumTournamentEquityAllocationPct: 95.01,
    }).success).toBe(false);
    expect(policySchema.safeParse({
      ...POLICY,
      maximumTournamentLeaderboardAgeSeconds: 61,
    }).success).toBe(false);
    expect(policySchema.safeParse({
      ...POLICY,
      maximumTournamentQuoteAgeSeconds: 16,
    }).success).toBe(false);
    expect(policySchema.safeParse({
      ...POLICY,
      minimumTournamentPodiumBufferTst: 299.99,
    }).success).toBe(false);
  });
});
