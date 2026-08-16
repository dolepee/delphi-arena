import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOpportunities } from "../src/opportunity-audit.js";

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
});
