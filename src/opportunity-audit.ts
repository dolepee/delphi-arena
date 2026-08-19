import { readFile } from "node:fs/promises";
import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { z } from "zod";
import { findQuotedPlan } from "./quote-plan.js";
import type { Assessment, Candidate, Policy } from "./model.js";
import type { Book } from "./runtime.js";

const opportunitySchema = z.object({
  marketId: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
  classification: z.enum(["result_capable", "partial_result", "forecast_only", "abstain"]),
  resultCapableOutcomes: z.array(z.number().int().nonnegative()),
  earliestDecisiveAt: z.string().datetime().nullable(),
  rationale: z.string().min(20),
});

const opportunitiesSchema = z.object({
  version: z.literal(1),
  markets: z.array(opportunitySchema),
});

export type OpportunityDefinition = z.infer<typeof opportunitySchema>;

export async function loadOpportunities(path: string): Promise<OpportunityDefinition[]> {
  return opportunitiesSchema.parse(JSON.parse(await readFile(path, "utf8"))).markets;
}

function hypotheticalAssessment(
  marketId: `0x${string}`,
  outcomeIndex: number,
  now: number,
): Assessment {
  const observedAt = new Date(now).toISOString();
  return {
    marketId,
    outcomeIndex,
    evidenceClass: "published_result",
    probability: 0.99,
    confidence: "high",
    status: "actionable",
    observedAt,
    expiresAt: new Date(now + 60_000).toISOString(),
    rationale: "Hypothetical exact-result capacity quote; this assessment is never persisted or executed.",
    sources: [{
      url: "https://competition.delphi.fyi/markets",
      kind: "authoritative",
      observedAt,
      valueHash: "0".repeat(64),
    }],
  };
}

async function quoteCapacity(input: {
  client: Pick<DelphiClient, "quoteBuy">;
  book: Book;
  policy: Policy;
  market: Book["markets"][number];
  outcomeIndex: number;
  availableTst: number;
  positions: Book["positions"];
  now: number;
}) {
  const assessment = hypotheticalAssessment(input.market.id, input.outcomeIndex, input.now);
  const existing = input.positions.filter((position) =>
    position.marketId.toLowerCase() === input.market.id.toLowerCase()
  );
  if (existing.some((position) => position.outcomeIndex !== input.outcomeIndex)) {
    return { executable: false, reason: "opposing live position", plan: null };
  }
  const existingPortfolioValue = input.positions.reduce(
    (total, position) => total + position.shares * position.markPrice,
    0,
  );
  const candidate: Candidate = {
    assessment,
    market: input.market,
    spotPrice: input.market.prices[input.outcomeIndex]!,
    rawEdge: 0.99 - input.market.prices[input.outcomeIndex]!,
    existingMarketValue: existing.reduce(
      (total, position) => total + position.shares * position.markPrice,
      0,
    ),
    existingMarketShares: existing.reduce((total, position) => total + position.shares, 0),
    existingPortfolioValue,
    existingPortfolioShares: input.positions.reduce((total, position) => total + position.shares, 0),
  };
  const marketRoom = input.book.totalEquityTst * input.policy.maximumPublishedResultMarketAllocationPct / 100 -
    candidate.existingMarketValue;
  const portfolioRoom = input.book.totalEquityTst * input.policy.maximumPublishedResultPortfolioAllocationPct / 100 -
    existingPortfolioValue;
  const budgetTst = Math.max(0, Math.min(
    input.availableTst,
    input.policy.maximumPublishedResultOrderTst,
    marketRoom,
    portfolioRoom,
  ));
  const plan = await findQuotedPlan({
    client: input.client,
    candidate,
    policy: input.policy,
    budgetTst,
    mode: "full",
    totalEquityTst: input.book.totalEquityTst,
    maximumAttempts: 10,
  });
  return { executable: plan !== null, reason: plan ? null : "edge, impact, allocation, or liquidity", plan };
}

export async function auditOpportunities(input: {
  client: Pick<DelphiClient, "quoteBuy">;
  book: Book;
  policy: Policy;
  definitions: OpportunityDefinition[];
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const definitions = new Map(input.definitions.map((item) => [item.marketId.toLowerCase(), item]));
  const rows = [];
  for (const market of input.book.markets.filter((item) => item.status === "open")) {
    const definition = definitions.get(market.id.toLowerCase());
    if (!definition) {
      rows.push({ marketId: market.id, question: market.question, classification: "unclassified" });
      continue;
    }
    const outcomes = [];
    for (const outcomeIndex of definition.resultCapableOutcomes) {
      if (market.outcomes[outcomeIndex] === undefined || market.prices[outcomeIndex] === undefined) {
        outcomes.push({ outcomeIndex, error: "outcome missing from live market" });
        continue;
      }
      const [live, recycled] = await Promise.all([
        quoteCapacity({
          client: input.client, book: input.book, policy: input.policy, market, outcomeIndex,
          availableTst: input.book.availableTst, positions: input.book.positions, now,
        }),
        quoteCapacity({
          client: input.client, book: input.book, policy: input.policy, market, outcomeIndex,
          availableTst: input.book.totalEquityTst, positions: [], now,
        }),
      ]);
      outcomes.push({
        outcomeIndex,
        outcome: market.outcomes[outcomeIndex],
        spotPrice: market.prices[outcomeIndex],
        live: live.plan ? {
          maximumCostTst: live.plan.maximumCostTst,
          shares: live.plan.shares,
          netEdge: live.plan.netEdge,
          maximumProfitTst: live.plan.worstCaseExpectedProfitTst,
        } : { executable: false, reason: live.reason },
        fullyRecycled: recycled.plan ? {
          maximumCostTst: recycled.plan.maximumCostTst,
          shares: recycled.plan.shares,
          netEdge: recycled.plan.netEdge,
          maximumProfitTst: recycled.plan.worstCaseExpectedProfitTst,
        } : { executable: false, reason: recycled.reason },
      });
    }
    rows.push({
      marketId: market.id,
      question: market.question,
      tradingClosesAt: market.resolvesAt,
      classification: definition.classification,
      earliestDecisiveAt: definition.earliestDecisiveAt,
      rationale: definition.rationale,
      outcomes,
    });
  }
  return {
    observedAt: new Date(now).toISOString(),
    availableTst: input.book.availableTst,
    totalEquityTst: input.book.totalEquityTst,
    rows,
    unclassifiedMarketIds: rows
      .filter((row) => row.classification === "unclassified")
      .map((row) => row.marketId),
  };
}
