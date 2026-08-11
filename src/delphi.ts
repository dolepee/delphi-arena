import { DelphiClient, type Market, type Position } from "@gensyn-ai/gensyn-delphi-sdk";
import { EXPECTED_WALLET, assertEnvironment } from "./config.js";
import type { MarketView, PositionView } from "./model.js";

export const client = new DelphiClient();

export async function assertSignerIdentity(): Promise<void> {
  assertEnvironment();
  const { address } = await client.getSigner();
  if (address.toLowerCase() !== EXPECTED_WALLET.toLowerCase()) {
    throw new Error(`signer ${address} is not the registered competition wallet`);
  }
}

export function marketToView(market: Market): MarketView {
  const outcomes = market.metadata?.outcomes;
  const prices = market.spotPrices;
  if (!market.metadata?.question || !outcomes || !prices || prices.length !== outcomes.length) {
    throw new Error(`market ${market.id} is missing question, outcomes, or prices`);
  }
  return {
    id: market.id as `0x${string}`,
    question: market.metadata.question,
    outcomes,
    status: market.status,
    resolvesAt: market.resolvesAt,
    prices,
    tradingFeePct: market.tradingFee ? Number(market.tradingFee) / 1e16 : 0,
    dataSources: market.dataSources,
  };
}

export function positionToView(position: Position, market: MarketView): PositionView {
  const outcomeIndex = Number(position.outcomeIdx);
  const markPrice = market.prices[outcomeIndex];
  if (!Number.isInteger(outcomeIndex) || markPrice === undefined) {
    throw new Error(`position ${position.id} cannot be priced`);
  }
  return {
    marketId: position.marketProxy as `0x${string}`,
    outcomeIndex,
    shares: Number(BigInt(position.shares)) / 1e18,
    markPrice,
  };
}
