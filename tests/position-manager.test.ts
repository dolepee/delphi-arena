import { describe, expect, it } from "vitest";
import type { Assessment, PositionView } from "../src/model.js";
import { bestAlternativeForMarket, exitReason, remainingAverageCostPerShare } from "../src/position-manager.js";

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

  it("rotates a non-losing position into a substantially stronger verified edge", () => {
    expect(exitReason({
      position,
      assessment: { ...assessment, probability: 0.99, evidenceClass: "official_schedule" },
      minimumProceedsTst: 92,
      averageCostPerShare: 0.9,
      minimumProfitTakeReturnPct: 3,
      maximumHoldEdgeForProfitTake: 0.02,
      bestAlternativeNetEdge: 0.62,
      minimumRotationEdgeAdvantage: 0.15,
    })).toBe("OPPORTUNITY_ROTATION");
  });

  it("does not rotate at a loss or for a marginal edge improvement", () => {
    const base = {
      position,
      assessment: { ...assessment, probability: 0.99, evidenceClass: "official_schedule" as const },
      minimumProfitTakeReturnPct: 3,
      maximumHoldEdgeForProfitTake: 0.02,
      minimumRotationEdgeAdvantage: 0.15,
    };
    expect(exitReason({ ...base, minimumProceedsTst: 88, averageCostPerShare: 0.9, bestAlternativeNetEdge: 0.62 })).toBeNull();
    expect(exitReason({ ...base, minimumProceedsTst: 92, averageCostPerShare: 0.9, bestAlternativeNetEdge: 0.2 })).toBeNull();
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

  it("reserves exit slippage before approving a profit or rotation", () => {
    const common = {
      position,
      assessment,
      averageCostPerShare: 0.97,
      minimumProfitTakeReturnPct: 3,
      maximumHoldEdgeForProfitTake: 0.02,
    };
    expect(exitReason({ ...common, minimumProceedsTst: 96, bestAlternativeNetEdge: 0.62 })).toBeNull();
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
    })).toBeCloseTo(0.9);
  });

  it("fails closed when ledger inventory cannot explain the live position", () => {
    expect(remainingAverageCostPerShare({
      position: { ...position, shares: 100 },
      buys: [confirmedBuy("a", 50, 35, 1)],
      exits: [],
    })).toBeNull();
  });
});

describe("rotation alternative selection", () => {
  it("uses the strongest different market when the global best is the current one", () => {
    expect(bestAlternativeForMarket([
      { marketId: position.marketId, netEdge: 0.7 },
      { marketId: "0x2222222222222222222222222222222222222222", netEdge: 0.6 },
      { marketId: "0x3333333333333333333333333333333333333333", netEdge: 0.5 },
    ], position.marketId)?.netEdge).toBe(0.6);
  });
});
