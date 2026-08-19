import type { MarketView } from "./model.js";
import type { OpportunityDefinition } from "./opportunity-policy.js";

export function tournamentPreapprovalMarketIds(input: {
  markets: MarketView[];
  opportunities: OpportunityDefinition[];
}): `0x${string}`[] {
  const definitions = new Map(input.opportunities.map((opportunity) => [
    opportunity.marketId.toLowerCase(),
    opportunity,
  ]));
  return input.markets.flatMap((market) => {
    const opportunity = definitions.get(market.id.toLowerCase());
    if (
      market.status !== "open" ||
      !opportunity ||
      (opportunity.classification !== "result_capable" &&
        opportunity.classification !== "partial_result") ||
      opportunity.resultCapableOutcomes.length === 0
    ) return [];
    return [market.id];
  }).sort();
}
