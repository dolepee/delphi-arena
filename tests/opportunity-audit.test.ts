import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Assessment } from "../src/model.js";
import {
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
});
