import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eventExecutionEnabled, loadAssessmentContext } from "../src/config.js";

describe("event execution activation", () => {
  const original = process.env.DELPHI_EVENT_EXECUTION_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.DELPHI_EVENT_EXECUTION_ENABLED;
    else process.env.DELPHI_EVENT_EXECUTION_ENABLED = original;
  });

  it("fails closed unless explicitly enabled", () => {
    delete process.env.DELPHI_EVENT_EXECUTION_ENABLED;
    expect(eventExecutionEnabled()).toBe(false);
    process.env.DELPHI_EVENT_EXECUTION_ENABLED = "false";
    expect(eventExecutionEnabled()).toBe(false);
    process.env.DELPHI_EVENT_EXECUTION_ENABLED = "true";
    expect(eventExecutionEnabled()).toBe(true);
  });
});

describe("classified assessment loading", () => {
  const originalAssessmentsPath = process.env.DELPHI_ASSESSMENTS_PATH;
  const originalOpportunitiesPath = process.env.DELPHI_OPPORTUNITIES_PATH;

  afterEach(() => {
    if (originalAssessmentsPath === undefined) delete process.env.DELPHI_ASSESSMENTS_PATH;
    else process.env.DELPHI_ASSESSMENTS_PATH = originalAssessmentsPath;
    if (originalOpportunitiesPath === undefined) delete process.env.DELPHI_OPPORTUNITIES_PATH;
    else process.env.DELPHI_OPPORTUNITIES_PATH = originalOpportunitiesPath;
  });

  it("drops assessments for an unknown market", async () => {
    const directory = await mkdtemp(join(tmpdir(), "delphi-assessment-context-"));
    const assessmentsPath = join(directory, "assessments.json");
    const opportunitiesPath = join(directory, "opportunities.json");
    await writeFile(assessmentsPath, JSON.stringify({ version: 1, assessments: [{
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
    }] }));
    await writeFile(opportunitiesPath, JSON.stringify({ version: 1, markets: [] }));
    process.env.DELPHI_ASSESSMENTS_PATH = assessmentsPath;
    process.env.DELPHI_OPPORTUNITIES_PATH = opportunitiesPath;

    await expect(loadAssessmentContext()).resolves.toMatchObject({
      assessments: [],
      opportunities: [],
    });
  });

  it("rejects missing or malformed opportunity definitions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "delphi-assessment-context-invalid-"));
    const assessmentsPath = join(directory, "assessments.json");
    const opportunitiesPath = join(directory, "opportunities.json");
    await writeFile(assessmentsPath, JSON.stringify({ version: 1, assessments: [] }));
    process.env.DELPHI_ASSESSMENTS_PATH = assessmentsPath;
    process.env.DELPHI_OPPORTUNITIES_PATH = join(directory, "missing.json");
    await expect(loadAssessmentContext()).rejects.toThrow();

    await writeFile(opportunitiesPath, "{malformed");
    process.env.DELPHI_OPPORTUNITIES_PATH = opportunitiesPath;
    await expect(loadAssessmentContext()).rejects.toThrow();
  });
});
