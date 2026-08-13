import { describe, expect, it } from "vitest";
import type { Assessment, PositionView } from "../src/model.js";
import { exitReason } from "../src/position-manager.js";

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
      quotedProceedsTst: 10,
      averageCostPerShare: 0.7,
      minimumProfitTakeReturnPct: 3,
      maximumHoldEdgeForProfitTake: 0.02,
    })).toBe("EVIDENCE_FLIP");
  });

  it("takes profit only after price convergence leaves little remaining edge", () => {
    expect(exitReason({
      position,
      assessment,
      quotedProceedsTst: 80,
      averageCostPerShare: 0.7,
      minimumProfitTakeReturnPct: 3,
      maximumHoldEdgeForProfitTake: 0.02,
    })).toBe("PROFIT_TAKE");
  });

  it("holds a profitable position when meaningful assessed edge remains", () => {
    expect(exitReason({
      position,
      assessment: { ...assessment, probability: 0.99, evidenceClass: "published_result" },
      quotedProceedsTst: 92,
      averageCostPerShare: 0.7,
      minimumProfitTakeReturnPct: 3,
      maximumHoldEdgeForProfitTake: 0.02,
    })).toBeNull();
  });

  it("rotates a non-losing position into a substantially stronger verified edge", () => {
    expect(exitReason({
      position,
      assessment: { ...assessment, probability: 0.99, evidenceClass: "official_schedule" },
      quotedProceedsTst: 92,
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
    expect(exitReason({ ...base, quotedProceedsTst: 88, averageCostPerShare: 0.9, bestAlternativeNetEdge: 0.62 })).toBeNull();
    expect(exitReason({ ...base, quotedProceedsTst: 92, averageCostPerShare: 0.9, bestAlternativeNetEdge: 0.2 })).toBeNull();
  });

  it("does not profit-take without a known cost basis", () => {
    expect(exitReason({
      position,
      assessment,
      quotedProceedsTst: 80,
      averageCostPerShare: null,
      minimumProfitTakeReturnPct: 3,
      maximumHoldEdgeForProfitTake: 0.02,
    })).toBeNull();
  });
});
