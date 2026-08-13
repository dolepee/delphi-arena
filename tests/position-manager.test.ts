import { describe, expect, it } from "vitest";
import type { Assessment, PositionView } from "../src/model.js";
import { assessmentForPosition, exitReason, isPastMarketResolution, positionLedgerGeneration, remainingAverageCostPerShare } from "../src/position-manager.js";

const position: PositionView = {
  marketId: "0x1111111111111111111111111111111111111111",
  outcomeIndex: 0,
  shares: 100,
  markPrice: 0.8,
};

const assessment: Assessment = {
  marketId: position.marketId,
  outcomeIndex: 0,
  evidenceClass: "forecast",
  probability: 0.81,
  confidence: "high",
  status: "actionable",
  observedAt: "2026-08-13T20:00:00.000Z",
  expiresAt: "2026-08-13T20:10:00.000Z",
  rationale: "An evidence-backed assessment long enough for schema validation.",
  sources: [{
    url: "https://example.com/source",
    kind: "authoritative",
    observedAt: "2026-08-13T20:00:00.000Z",
    valueHash: "a".repeat(64),
  }],
};

describe("position exit policy", () => {
  it("treats a missing market deadline as open-ended", () => {
    const now = Date.parse("2026-08-13T20:00:00.000Z");
    expect(isPastMarketResolution(null, now)).toBe(false);
    expect(isPastMarketResolution(undefined, now)).toBe(false);
    expect(isPastMarketResolution("2026-08-13T19:59:59.999Z", now)).toBe(true);
  });

  it("prioritizes a valid published result over a newer forecast", () => {
    const result = { ...assessment, outcomeIndex: 1, evidenceClass: "published_result" as const, probability: 0.99 };
    const newerForecast = {
      ...assessment,
      observedAt: "2026-08-13T20:01:00.000Z",
      expiresAt: "2026-08-13T20:10:00.000Z",
    };
    expect(assessmentForPosition({
      assessments: [result, newerForecast], position,
      market: { outcomes: ["Yes", "No"], prices: [0.8, 0.2] },
      policy: { minimumEvidenceSources: 1, maximumAssessmentAgeMinutes: 30 } as never,
      now: Date.parse("2026-08-13T20:02:00.000Z"),
    })?.outcomeIndex).toBe(1);
  });

  it("refuses conflicting valid published results", () => {
    const first = { ...assessment, evidenceClass: "published_result" as const, probability: 0.99 };
    const second = { ...assessment, outcomeIndex: 1, evidenceClass: "published_result" as const, probability: 0.99 };
    expect(assessmentForPosition({
      assessments: [first, second], position,
      market: { outcomes: ["Yes", "No"], prices: [0.8, 0.2] },
      policy: { minimumEvidenceSources: 1, maximumAssessmentAgeMinutes: 30 } as never,
      now: Date.parse("2026-08-13T20:01:00.000Z"),
    })).toBeNull();
  });

  it("exits immediately on a high-confidence published-result flip", () => {
    expect(exitReason({
      position,
      assessment: { ...assessment, outcomeIndex: 1, evidenceClass: "published_result", probability: 0.99 },
      minimumProceedsTst: 10,
      averageCostPerShare: 0.7,
      minimumProfitTakeReturnPct: 3,
      maximumHoldEdgeForProfitTake: 0.02,
    })).toBe("EVIDENCE_FLIP");
  });

  it("takes profit only after price convergence leaves little remaining edge", () => {
    expect(exitReason({
      position,
      assessment,
      minimumProceedsTst: 80,
      averageCostPerShare: 0.7,
      minimumProfitTakeReturnPct: 3,
      maximumHoldEdgeForProfitTake: 0.02,
    })).toBe("PROFIT_TAKE");
  });

  it("holds a profitable position when meaningful assessed edge remains", () => {
    expect(exitReason({
      position,
      assessment: { ...assessment, probability: 0.99, evidenceClass: "published_result" },
      minimumProceedsTst: 92,
      averageCostPerShare: 0.7,
      minimumProfitTakeReturnPct: 3,
      maximumHoldEdgeForProfitTake: 0.02,
    })).toBeNull();
  });

  it("does not profit-take without a known cost basis", () => {
    expect(exitReason({
      position,
      assessment,
      minimumProceedsTst: 80,
      averageCostPerShare: null,
      minimumProfitTakeReturnPct: 3,
      maximumHoldEdgeForProfitTake: 0.02,
    })).toBeNull();
  });

  it("reserves exit slippage before approving a profit", () => {
    const common = {
      position,
      assessment,
      averageCostPerShare: 0.97,
      minimumProfitTakeReturnPct: 3,
      maximumHoldEdgeForProfitTake: 0.02,
    };
    expect(exitReason({ ...common, minimumProceedsTst: 96 })).toBeNull();
    expect(exitReason({ ...common, minimumProceedsTst: 98 })).toBeNull();
  });
});

describe("remaining inventory cost basis", () => {
  const confirmedBuy = (decisionId: string, shares: number, cost: number, createdAt: number) => ({
    decisionId: decisionId.repeat(64), marketId: position.marketId, outcomeIndex: position.outcomeIndex,
    shares, quotedCostTst: cost, status: "CONFIRMED" as const, createdAt, transactionHash: `0x${decisionId.repeat(64)}`,
  });
  const confirmedExit = (decisionId: string, shares: number, createdAt: number) => ({
    decisionId: decisionId.repeat(64), marketId: position.marketId, outcomeIndex: position.outcomeIndex,
    shares, quotedProceedsTst: shares * 0.8, minimumProceedsTst: shares * 0.78,
    reason: "PROFIT_TAKE" as const, status: "CONFIRMED" as const, createdAt,
    transactionHash: `0x${decisionId.repeat(64)}`,
  });

  it("excludes a closed lot before evaluating a reopened position", () => {
    expect(remainingAverageCostPerShare({
      position: { ...position, shares: 100 },
      buys: [confirmedBuy("a", 100, 70, 1), confirmedBuy("b", 100, 90, 3)],
      exits: [confirmedExit("c", 100, 2)],
      entrySlippagePct: 2,
    })).toBeCloseTo(0.918);
  });

  it("does not apply an older untracked-position exit to a later buy", () => {
    expect(remainingAverageCostPerShare({
      position: { ...position, shares: 100 },
      buys: [confirmedBuy("a", 100, 90, 2)],
      exits: [confirmedExit("b", 100, 1)],
      entrySlippagePct: 2,
    })).toBeCloseTo(0.918);
  });

  it("fails closed when ledger inventory cannot explain the live position", () => {
    expect(remainingAverageCostPerShare({
      position: { ...position, shares: 100 },
      buys: [confirmedBuy("a", 50, 35, 1)],
      exits: [],
      entrySlippagePct: 2,
    })).toBeNull();
  });

  it("uses the persisted maximum authorized entry cost when available", () => {
    const buy = { ...confirmedBuy("a", 100, 70, 1), maximumCostTst: 72 };
    expect(remainingAverageCostPerShare({
      position: { ...position, shares: 100 },
      buys: [buy],
      exits: [],
      entrySlippagePct: 5,
    })).toBeCloseTo(0.72);
  });

  it("prefers an independently reconciled actual entry cost", () => {
    const buy = { ...confirmedBuy("a", 100, 70, 1), maximumCostTst: 72, actualCostTst: 70.5 };
    expect(remainingAverageCostPerShare({
      position: { ...position, shares: 100 },
      buys: [buy],
      exits: [],
      entrySlippagePct: 5,
    })).toBeCloseTo(0.705);
  });

  it("changes the position generation when a sold outcome is reopened", () => {
    const firstBuy = confirmedBuy("a", 100, 70, 1);
    const firstExit = confirmedExit("b", 100, 2);
    const first = positionLedgerGeneration({ position, buys: [firstBuy], exits: [] });
    const reopened = positionLedgerGeneration({
      position,
      buys: [firstBuy, confirmedBuy("c", 100, 90, 3)],
      exits: [firstExit],
    });
    expect(reopened).not.toBe(first);
  });
});
