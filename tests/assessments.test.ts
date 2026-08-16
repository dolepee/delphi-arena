import { describe, expect, it } from "vitest";
import { selectEventAssessments } from "../src/assessments.js";
import type { Assessment } from "../src/model.js";

const assessment: Assessment = {
  marketId: "0x1111111111111111111111111111111111111111",
  outcomeIndex: 0,
  evidenceClass: "published_result",
  probability: 0.99,
  confidence: "high",
  status: "actionable",
  observedAt: "2026-08-16T20:00:00.000Z",
  expiresAt: "2026-08-16T20:10:00.000Z",
  rationale: "An exact authoritative result suitable for the serialized event lane.",
  sources: [{
    url: "https://example.com/result",
    kind: "authoritative",
    observedAt: "2026-08-16T20:00:00.000Z",
    valueHash: "a".repeat(64),
  }],
};

describe("event assessment lane", () => {
  it("accepts only exact high-confidence published results", () => {
    expect(selectEventAssessments([
      assessment,
      { ...assessment, evidenceClass: "forecast" },
      { ...assessment, probability: 0.98 },
      { ...assessment, confidence: "medium" },
    ])).toEqual([assessment]);
  });
});
