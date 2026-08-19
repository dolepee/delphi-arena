import { createHash } from "node:crypto";
import type { Assessment, Candidate, MarketView, Policy, PositionView, QuotedPlan } from "./model.js";
import {
  isAssessmentAllowedByOpportunity,
  type OpportunityDefinition,
} from "./opportunity-policy.js";
import { tournamentSettings } from "./tournament-guard.js";

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

export function maximumPriceImpact(assessment: Assessment, policy: Policy): number {
  return isDeterministicPublishedResult(assessment)
    ? policy.maximumPublishedResultPriceImpact
    : policy.maximumPriceImpact;
}

export function isAssessmentEvidenceValid(input: {
  assessment: Assessment;
  policy: Policy;
  now: number;
}): boolean {
  const { assessment, policy, now } = input;
  if (assessment.status !== "actionable" || assessment.confidence === "low") return false;
  if (assessment.evidenceClass === "published_result" && !isDeterministicPublishedResult(assessment)) return false;
  const observedAt = Date.parse(assessment.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > now || now >= Date.parse(assessment.expiresAt)) return false;
  if (now - observedAt > policy.maximumAssessmentAgeMinutes * 60_000) return false;
  if (assessment.sources.length < policy.minimumEvidenceSources) return false;
  if (!assessment.sources.some((source) => source.kind === "authoritative")) return false;
  if (assessment.sources.some((source) => Date.parse(source.observedAt) > observedAt)) return false;
  return true;
}

export function selectCandidates(input: {
  now: number;
  policy: Policy;
  markets: MarketView[];
  positions: PositionView[];
  assessments: Assessment[];
  opportunities: OpportunityDefinition[];
}): Candidate[] {
  const existingPortfolioShares = input.positions.reduce(
    (total, position) => total + position.shares,
    0,
  );
  const existingPortfolioValue = input.positions.reduce(
    (total, position) => total + position.shares * position.markPrice,
    0,
  );
  const markets = new Map(input.markets.map((market) => [market.id.toLowerCase(), market]));
  const positionsByMarket = new Map<string, PositionView[]>();
  for (const position of input.positions) {
    const key = position.marketId.toLowerCase();
    positionsByMarket.set(key, [...(positionsByMarket.get(key) ?? []), position]);
  }

  return input.assessments.flatMap((assessment) => {
    if (!isAssessmentAllowedByOpportunity(assessment, input.opportunities)) return [];
    if (!isAssessmentEvidenceValid({ assessment, policy: input.policy, now: input.now })) return [];

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
    const existingMarketShares = existing.reduce(
      (total, position) => total + position.shares,
      0,
    );
    const rawEdge = assessment.probability - spotPrice;
    if (rawEdge < minimumNetEdge(assessment, input.policy)) return [];
    return [{
      assessment,
      market,
      spotPrice,
      rawEdge,
      existingMarketValue,
      existingMarketShares,
      existingPortfolioValue,
      existingPortfolioShares,
    }];
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
  quotedAt?: string;
  shares: number;
  quotedCostTst: number;
  budgetTst: number;
  mode: "canary" | "full";
  totalEquityTst: number;
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
  const maximumCostAtomic = BigInt(Math.ceil(
    input.quotedCostTst * (1 + input.policy.slippagePct / 100) * 1e6,
  ));
  const maximumCostTst = Number(maximumCostAtomic) / 1e6;
  if (maximumCostTst > input.budgetTst) return null;
  const averagePrice = input.quotedCostTst / input.shares;
  const maximumAveragePrice = maximumCostTst / input.shares;
  const netEdge = input.candidate.assessment.probability - maximumAveragePrice;
  const priceImpact = maximumAveragePrice - input.candidate.spotPrice;
  const worstCaseExpectedProfitTst =
    input.shares * input.candidate.assessment.probability - maximumCostTst;
  const resultLane = input.mode === "full" && isDeterministicPublishedResult(input.candidate.assessment);
  const tournament = resultLane ? tournamentSettings(input.policy) : null;
  const marketAllocationPct = tournament?.allocationPct ?? (resultLane
    ? input.policy.maximumPublishedResultMarketAllocationPct
    : input.policy.maximumMarketAllocationPct);
  const portfolioAllocationPct = tournament?.allocationPct ?? (resultLane
    ? input.policy.maximumPublishedResultPortfolioAllocationPct
    : input.policy.maximumPortfolioAllocationPct);
  // Forecasts retain conservative face-value concentration limits. A
  // deterministic published result instead uses cash at risk: its 1 TST face
  // value is the expected payout, not the amount that can be lost. The quote
  // budget and this independent check both cap the cash exposure.
  const maximumPostTradeMarketRiskTst = resultLane
    ? input.candidate.existingMarketValue + maximumCostTst
    : input.candidate.existingMarketShares + input.shares;
  const maximumPostTradePortfolioRiskTst = resultLane
    ? input.candidate.existingPortfolioValue + maximumCostTst
    : input.candidate.existingPortfolioShares + input.shares;
  if (
    netEdge < minimumNetEdge(input.candidate.assessment, input.policy) ||
    priceImpact > maximumPriceImpact(input.candidate.assessment, input.policy) ||
    worstCaseExpectedProfitTst <= 0 ||
    maximumPostTradeMarketRiskTst > input.totalEquityTst * marketAllocationPct / 100 ||
    maximumPostTradePortfolioRiskTst > input.totalEquityTst * portfolioAllocationPct / 100
  ) return null;
  return {
    ...input.candidate,
    // Direct validation callers that do not originate from a live SDK quote
    // receive an intentionally stale timestamp. Production quote discovery
    // always supplies the actual post-response observation time.
    quotedAt: input.quotedAt ?? new Date(0).toISOString(),
    shares: input.shares,
    quotedCostTst: input.quotedCostTst,
    maximumCostTst,
    maximumCostAtomic,
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
  const tournament = resultLane ? tournamentSettings(input.policy) : null;
  const marketAllocationPct = tournament?.allocationPct ?? (resultLane
    ? input.policy.maximumPublishedResultMarketAllocationPct
    : input.policy.maximumMarketAllocationPct);
  const portfolioAllocationPct = tournament?.allocationPct ?? (resultLane
    ? input.policy.maximumPublishedResultPortfolioAllocationPct
    : input.policy.maximumPortfolioAllocationPct);
  const marketRoom = input.totalEquityTst * marketAllocationPct / 100 - input.existingMarketValueTst;
  const portfolioRoom = input.totalEquityTst * portfolioAllocationPct / 100 - input.deployedValueTst;
  const modeCap = input.mode === "canary"
    ? input.policy.canaryMaximumTst
    : resultLane
      ? tournament?.orderCapTst ?? input.policy.maximumPublishedResultOrderTst
      : input.policy.maximumOrderTst;
  const availableRoom = tournament
    ? input.availableTst * tournament.allocationPct / 100
    : input.availableTst;
  const budget = Math.max(0, Math.min(availableRoom, marketRoom, portfolioRoom, modeCap));
  if (input.mode === "full" && budget < input.policy.minimumFullOrderTst) return 0;
  return budget;
}

export function maximumAdditionalShares(input: {
  policy: Policy;
  assessment: Assessment;
  totalEquityTst: number;
  positions: PositionView[];
  marketId: string;
  mode: "canary" | "full";
}): number {
  const resultLane = input.mode === "full" && isDeterministicPublishedResult(input.assessment);
  if (resultLane) return Number.POSITIVE_INFINITY;
  const marketAllocationPct = resultLane
    ? input.policy.maximumPublishedResultMarketAllocationPct
    : input.policy.maximumMarketAllocationPct;
  const portfolioAllocationPct = resultLane
    ? input.policy.maximumPublishedResultPortfolioAllocationPct
    : input.policy.maximumPortfolioAllocationPct;
  const sameOutcomeShares = input.positions
    .filter((position) =>
      position.marketId.toLowerCase() === input.marketId.toLowerCase() &&
      position.outcomeIndex === input.assessment.outcomeIndex
    )
    .reduce((total, position) => total + position.shares, 0);
  const portfolioShares = input.positions.reduce((total, position) => total + position.shares, 0);
  return Math.max(0, Math.min(
    input.totalEquityTst * marketAllocationPct / 100 - sameOutcomeShares,
    input.totalEquityTst * portfolioAllocationPct / 100 - portfolioShares,
  ));
}

export function rankQuotedPlans(plans: QuotedPlan[]): QuotedPlan[] {
  return [...plans].sort((left, right) =>
    right.worstCaseExpectedProfitTst - left.worstCaseExpectedProfitTst ||
    right.netEdge - left.netEdge ||
    left.decisionId.localeCompare(right.decisionId)
  );
}
