import { describe, expect, it } from "vitest";
import type { MarketView } from "../src/model.js";
import type { OpportunityDefinition } from "../src/opportunity-policy.js";
import { tournamentPreapprovalMarketIds } from "../src/preapproval.js";

const market = (id: string): MarketView => ({
  id: `0x${id.repeat(40)}` as `0x${string}`,
  question: id,
  outcomes: ["Yes", "No"],
  status: "open",
  resolvesAt: "2026-08-21T00:00:00.000Z",
  prices: [0.2, 0.8],
  tradingFeePct: 0.5,
  dataSources: [],
});

const definition = (
  item: MarketView,
  classification: OpportunityDefinition["classification"],
  resultCapableOutcomes: number[],
): OpportunityDefinition => ({
  marketId: item.id,
  classification,
  resultCapableOutcomes,
  earliestDecisiveAt: resultCapableOutcomes.length > 0
    ? "2026-08-10T00:00:00.000Z"
    : null,
  rationale: "Only explicit result-capable official markets may receive bounded preapproval.",
});

describe("tournament exact-result preapproval scope", () => {
  it("includes only open, explicitly result-capable official markets", () => {
    const partial = market("2");
    const forecast = market("1");
    const unknown = market("3");
    const closed = { ...market("4"), status: "awaiting_settlement" };
    expect(tournamentPreapprovalMarketIds({
      markets: [partial, forecast, unknown, closed],
      opportunities: [
        definition(partial, "partial_result", [0]),
        definition(forecast, "forecast_only", []),
        definition(closed, "result_capable", [0, 1]),
      ],
    })).toEqual([partial.id]);
  });
});
