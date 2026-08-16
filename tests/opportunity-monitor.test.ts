import { describe, expect, it } from "vitest";
import type { MarketView } from "../src/model.js";
import type { OpportunityDefinition } from "../src/opportunity-audit.js";
import { unclassifiedMarkets } from "../src/opportunity-monitor.js";

const market = (id: `0x${string}`, status = "open"): MarketView => ({
  id,
  question: "Will this newly listed market resolve Yes?",
  outcomes: ["Yes", "No"],
  status,
  resolvesAt: "2026-08-20T00:00:00.000Z",
  prices: [0.5, 0.5],
  tradingFeePct: 0.5,
  dataSources: [],
});

describe("opportunity coverage monitor", () => {
  it("fails new open markets closed until an explicit classification exists", () => {
    const first = market("0x1111111111111111111111111111111111111111");
    const second = market("0x2222222222222222222222222222222222222222");
    const definition: OpportunityDefinition = {
      marketId: first.id,
      classification: "abstain",
      resultCapableOutcomes: [],
      earliestDecisiveAt: null,
      rationale: "No exact authoritative result is available before this market closes.",
    };
    expect(unclassifiedMarkets([first, second], [definition]).map((item) => item.id)).toEqual([second.id]);
  });

  it("ignores closed markets that can no longer accept a trade", () => {
    expect(unclassifiedMarkets([
      market("0x1111111111111111111111111111111111111111", "resolved"),
    ], [])).toEqual([]);
  });
});
