import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Assessment, Policy } from "../src/model.js";
import {
  auditOpportunities,
  isAssessmentAllowedByOpportunity,
  loadOpportunities,
  type OpportunityDefinition,
} from "../src/opportunity-audit.js";

const assessment: Assessment = {
  marketId: "0x1111111111111111111111111111111111111111",
  outcomeIndex: 0,
  evidenceClass: "forecast",
  probability: 0.9,
  confidence: "high",
  status: "actionable",
  observedAt: "2026-08-18T12:00:00.000Z",
  expiresAt: "2026-08-18T12:10:00.000Z",
  rationale: "The authoritative source supports a bounded market assessment.",
  sources: [{
    url: "https://example.com/source",
    kind: "authoritative",
    observedAt: "2026-08-18T12:00:00.000Z",
    valueHash: "a".repeat(64),
  }],
};

function definition(
  classification: OpportunityDefinition["classification"],
  overrides: Partial<OpportunityDefinition> = {},
): OpportunityDefinition {
  return {
    marketId: assessment.marketId,
    classification,
    resultCapableOutcomes: classification === "result_capable" || classification === "partial_result"
      ? [0]
      : [],
    earliestDecisiveAt: classification === "result_capable" || classification === "partial_result"
      ? "2026-08-18T11:00:00.000Z"
      : null,
    rationale: "This classification has a sufficiently detailed decision rationale.",
    ...overrides,
  };
}

describe("opportunity definitions", () => {
  it("loads an explicit result-capability classification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "delphi-opportunities-"));
    const path = join(directory, "opportunities.json");
    await writeFile(path, JSON.stringify({ version: 1, markets: [{
      marketId: "0x1111111111111111111111111111111111111111",
      classification: "partial_result",
      resultCapableOutcomes: [0],
      earliestDecisiveAt: "2026-08-18T00:00:00.000Z",
      rationale: "The positive threshold can become irreversible while the market remains open.",
    }] }));
    expect((await loadOpportunities(path))[0]?.resultCapableOutcomes).toEqual([0]);
  });

  it("rejects a classification without a decision rationale", async () => {
    const directory = await mkdtemp(join(tmpdir(), "delphi-opportunities-invalid-"));
    const path = join(directory, "opportunities.json");
    await writeFile(path, JSON.stringify({ version: 1, markets: [{
      marketId: "0x1111111111111111111111111111111111111111",
      classification: "forecast_only",
      resultCapableOutcomes: [],
      earliestDecisiveAt: null,
      rationale: "short",
    }] }));
    await expect(loadOpportunities(path)).rejects.toThrow();
  });

  it("fails closed for a missing file or incoherent decisive mapping", async () => {
    const directory = await mkdtemp(join(tmpdir(), "delphi-opportunities-closed-"));
    await expect(loadOpportunities(join(directory, "missing.json"))).rejects.toThrow();
    const path = join(directory, "opportunities.json");
    await writeFile(path, JSON.stringify({ version: 1, markets: [{
      ...definition("result_capable"),
      resultCapableOutcomes: [],
    }] }));
    await expect(loadOpportunities(path)).rejects.toThrow();
  });

  it("rejects unknown and abstain assessments", () => {
    expect(isAssessmentAllowedByOpportunity(assessment, [])).toBe(false);
    expect(isAssessmentAllowedByOpportunity(assessment, [definition("abstain")])).toBe(false);
  });

  it("allows only forecasts on a forecast-only market", () => {
    const definitions = [definition("forecast_only")];
    expect(isAssessmentAllowedByOpportunity(assessment, definitions)).toBe(true);
    expect(isAssessmentAllowedByOpportunity({
      ...assessment,
      evidenceClass: "official_schedule",
    }, definitions)).toBe(false);
    expect(isAssessmentAllowedByOpportunity({
      ...assessment,
      evidenceClass: "published_result",
      probability: 0.99,
    }, definitions)).toBe(false);
  });

  it("requires a mapped outcome and decisive timestamp for elevated evidence", () => {
    const definitions = [definition("partial_result", {
      earliestDecisiveAt: "2026-08-18T12:00:00.000Z",
    })];
    const published = {
      ...assessment,
      evidenceClass: "published_result" as const,
      probability: 0.99,
    };
    expect(isAssessmentAllowedByOpportunity(published, definitions)).toBe(true);
    expect(isAssessmentAllowedByOpportunity({
      ...published,
      outcomeIndex: 1,
    }, definitions)).toBe(false);
    expect(isAssessmentAllowedByOpportunity({
      ...published,
      observedAt: "2026-08-18T11:59:59.999Z",
    }, definitions)).toBe(false);
    expect(isAssessmentAllowedByOpportunity({
      ...assessment,
      outcomeIndex: 1,
    }, definitions)).toBe(true);
  });

  it("reports tournament-sized exact-result capacity instead of the legacy 850 TST cap", async () => {
    const policy = {
      competitionEndsAt: "2026-08-23T23:59:00.000Z", minimumStartingTst: 1000, minimumGasEth: 0.001,
      minimumNetEdge: 0.08, minimumPublishedResultNetEdge: 0.02, minimumOfficialScheduleNetEdge: 0.04,
      maximumMarketAllocationPct: 35, maximumPortfolioAllocationPct: 90, maximumOrderTst: 250,
      maximumPublishedResultMarketAllocationPct: 85, maximumPublishedResultPortfolioAllocationPct: 95,
      maximumPublishedResultOrderTst: 850, minimumFullOrderTst: 5, maximumPriceImpact: 0.04,
      maximumPublishedResultPriceImpact: 0.2, slippagePct: 2, maximumNewTradesPerCycle: 1,
      minimumEvidenceSources: 1, maximumAssessmentAgeMinutes: 30, canaryMaximumTst: 1,
      qualificationFallback: "none", maximumTournamentExactResultOrderTst: 1350,
      maximumTournamentEquityAllocationPct: 95, minimumTournamentPodiumBufferTst: 300,
      maximumTournamentLeaderboardAgeSeconds: 45, maximumTournamentQuoteAgeSeconds: 15,
    } satisfies Policy;
    const market = {
      id: assessment.marketId,
      question: "Will the exact official result be YES?",
      outcomes: ["Yes", "No"],
      status: "open",
      resolvesAt: "2026-08-21T14:00:00.000Z",
      prices: [0.1, 0.9],
      tradingFeePct: 0.5,
      dataSources: [],
    } as const;
    const result = await auditOpportunities({
      client: {
        quoteBuy: async ({ sharesOut }: { sharesOut: bigint }) => ({
          tokensIn: BigInt(Math.ceil(Number(sharesOut) / 1e18 * 0.2 * 1e6)),
        }),
      } as never,
      book: {
        rawMarkets: [], rawPositions: [], markets: [market], positions: [],
        availableTst: 1422.528949, deployedValueTst: 0, totalEquityTst: 1422.528949, gasEth: 1,
      } as never,
      policy,
      definitions: [definition("partial_result")],
      now: Date.parse("2026-08-19T14:00:00.000Z"),
    });
    const live = result.rows[0]?.outcomes?.[0]?.live;
    expect(live && "maximumCostTst" in live ? live.maximumCostTst : 0).toBeGreaterThan(850);
    expect(live && "maximumCostTst" in live ? live.maximumCostTst : Infinity).toBeLessThanOrEqual(1350);
  });
});
