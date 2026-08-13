import { createHash } from "node:crypto";
import type { Assessment, Candidate, MarketView, Policy, PositionView, QuotedPlan } from "./model.js";

const confidenceWeight = { high: 1, medium: 0.7, low: 0.35 } as const;

function minimumNetEdge(assessment: Assessment, policy: Policy): number {
  if (assessment.evidenceClass === "published_result") return policy.minimumPublishedResultNetEdge;
  if (assessment.evidenceClass === "official_schedule") return policy.minimumOfficialScheduleNetEdge;
  return policy.minimumNetEdge;
}

export function isDeterministicPublishedResult(assessment: Assessment): boolean {
  return assessment.evidenceClass === "published_result" &&
    assessment.confidence === "high" &&
    assessment.probability === 0.99;
}

function maximumPriceImpact(assessment: Assessment, policy: Policy): number {
  return isDeterministicPublishedResult(assessment)
    ? policy.maximumPublishedResultPriceImpact
    : policy.maximumPriceImpact;
}

export function selectCandidates(input: {
  now: number;
  policy: Policy;
  markets: MarketView[];
  positions: PositionView[];
  assessments: Assessment[];
}): Candidate[] {
  const markets = new Map(input.markets.map((market) => [market.id.toLowerCase(), market]));
  const positionsByMarket = new Map<string, PositionView[]>();
  for (const position of input.positions) {
    const key = position.marketId.toLowerCase();
    positionsByMarket.set(key, [...(positionsByMarket.get(key) ?? []), position]);
  }

  return input.assessments.flatMap((assessment) => {
    if (assessment.status !== "actionable" || assessment.confidence === "low") return [];
    if (assessment.evidenceClass === "published_result" && !isDeterministicPublishedResult(assessment)) return [];
    const observedAt = Date.parse(assessment.observedAt);
    if (input.now >= Date.parse(assessment.expiresAt)) return [];
    if (input.now - observedAt > input.policy.maximumAssessmentAgeMinutes * 60_000) return [];
    if (assessment.sources.length < input.policy.minimumEvidenceSources) return [];
    if (!assessment.sources.some((source) => source.kind === "authoritative")) return [];
    if (assessment.sources.some((source) => Date.parse(source.observedAt) > observedAt)) return [];

    const market = markets.get(assessment.marketId.toLowerCase());
    if (!market || market.status !== "open") return [];
    if (market.resolvesAt !== null && input.now >= Date.parse(market.resolvesAt)) return [];
    const spotPrice = market.prices[assessment.outcomeIndex];
    if (spotPrice === undefined || market.outcomes[assessment.outcomeIndex] === undefined) return [];
    const existing = positionsByMarket.get(market.id.toLowerCase()) ?? [];
    if (existing.some((position) => position.outcomeIndex !== assessment.outcomeIndex)) return [];
    const existingMarketValue = existing.reduce(
      (total, position) => total + position.shares * position.markPrice,
      0,
    );
    const rawEdge = assessment.probability - spotPrice;
    if (rawEdge < minimumNetEdge(assessment, input.policy)) return [];
    return [{ assessment, market, spotPrice, rawEdge, existingMarketValue }];
  }).sort((left, right) =>
    right.rawEdge * confidenceWeight[right.assessment.confidence] -
    left.rawEdge * confidenceWeight[left.assessment.confidence]
  );
}

export function planDigest(candidate: Candidate, shares: number, quotedCostTst: number): string {
  return createHash("sha256").update(JSON.stringify({
    marketId: candidate.market.id.toLowerCase(),
    outcomeIndex: candidate.assessment.outcomeIndex,
    probability: candidate.assessment.probability,
    observedAt: candidate.assessment.observedAt,
    expiresAt: candidate.assessment.expiresAt,
    sourceHashes: candidate.assessment.sources.map((source) => source.valueHash).sort(),
    shares,
    quotedCostTst,
  })).digest("hex");
}

export function validateQuote(input: {
  candidate: Candidate;
  policy: Policy;
  shares: number;
  quotedCostTst: number;
  budgetTst: number;
  mode: "canary" | "full";
}): QuotedPlan | null {
  if (
    !Number.isFinite(input.shares) ||
    !Number.isFinite(input.quotedCostTst) ||
    !Number.isFinite(input.budgetTst) ||
    input.shares <= 0 ||
    input.quotedCostTst <= 0 ||
    input.quotedCostTst > input.budgetTst
  ) return null;
  // quoteBuy().tokensIn is the SDK's total cash-in and already includes the
  // market fee. Apply slippage once, then gate the worst executable price.
  const maximumCostTst = Math.ceil(
    input.quotedCostTst * (1 + input.policy.slippagePct / 100) * 1e6,
  ) / 1e6;
  if (maximumCostTst > input.budgetTst) return null;
  const averagePrice = input.quotedCostTst / input.shares;
  const maximumAveragePrice = maximumCostTst / input.shares;
  const netEdge = input.candidate.assessment.probability - maximumAveragePrice;
  const priceImpact = maximumAveragePrice - input.candidate.spotPrice;
  const worstCaseExpectedProfitTst =
    input.shares * input.candidate.assessment.probability - maximumCostTst;
  if (
    netEdge < minimumNetEdge(input.candidate.assessment, input.policy) ||
    priceImpact > maximumPriceImpact(input.candidate.assessment, input.policy) ||
    worstCaseExpectedProfitTst <= 0
  ) return null;
  return {
    ...input.candidate,
    shares: input.shares,
    quotedCostTst: input.quotedCostTst,
    maximumCostTst,
    averagePrice,
    maximumAveragePrice,
    netEdge,
    priceImpact,
    worstCaseExpectedProfitTst,
    mode: input.mode,
    decisionId: planDigest(input.candidate, input.shares, input.quotedCostTst),
  };
}

export function orderBudget(input: {
  policy: Policy;
  assessment: Assessment;
  totalEquityTst: number;
  availableTst: number;
  deployedValueTst: number;
  existingMarketValueTst: number;
  mode: "canary" | "full";
}): number {
  const resultLane = input.mode === "full" && isDeterministicPublishedResult(input.assessment);
  const marketAllocationPct = resultLane
    ? input.policy.maximumPublishedResultMarketAllocationPct
    : input.policy.maximumMarketAllocationPct;
  const portfolioAllocationPct = resultLane
    ? input.policy.maximumPublishedResultPortfolioAllocationPct
    : input.policy.maximumPortfolioAllocationPct;
  const marketRoom = input.totalEquityTst * marketAllocationPct / 100 - input.existingMarketValueTst;
  const portfolioRoom = input.totalEquityTst * portfolioAllocationPct / 100 - input.deployedValueTst;
  const modeCap = input.mode === "canary"
    ? input.policy.canaryMaximumTst
    : resultLane
      ? input.policy.maximumPublishedResultOrderTst
      : input.policy.maximumOrderTst;
  const budget = Math.max(0, Math.min(input.availableTst, marketRoom, portfolioRoom, modeCap));
  if (input.mode === "full" && budget < input.policy.minimumFullOrderTst) return 0;
  return budget;
}

export function rankQuotedPlans(plans: QuotedPlan[]): QuotedPlan[] {
  return [...plans].sort((left, right) =>
    right.worstCaseExpectedProfitTst - left.worstCaseExpectedProfitTst ||
    right.netEdge - left.netEdge ||
    left.decisionId.localeCompare(right.decisionId)
  );
}
