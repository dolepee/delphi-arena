import type { Assessment, Policy } from "./model.js";

export const ABSOLUTE_TOURNAMENT_EXACT_COST_CAP_TST = 1_350;
export const ABSOLUTE_TOURNAMENT_ALLOCATION_CAP_PCT = 95;
export const ABSOLUTE_TOURNAMENT_EXACT_PRICE_IMPACT = 0.2;
export const ABSOLUTE_TOURNAMENT_LEADERBOARD_AGE_SECONDS = 60;
export const ABSOLUTE_TOURNAMENT_QUOTE_AGE_SECONDS = 15;
export const MINIMUM_TOURNAMENT_PODIUM_BUFFER_TST = 300;
export const MINIMUM_NEAR_PODIUM_EXACT_PROFIT_TST = 500;
export const NEAR_PODIUM_EXACT_TARGET_FRACTION = 0.25;
export const MINIMUM_NEAR_PODIUM_SETTLEMENT_LEAD_MS = 18 * 60 * 60 * 1_000;
const BOOK_RECONCILIATION_TOLERANCE_TST = 0.1;

export interface TournamentBook {
  totalEquityTst: number;
  availableTst: number;
  deployedValueTst: number;
  positionCount: number;
}

export interface TournamentPodiumTarget {
  observedAt: string;
  initialTst: number;
  liveThirdPlacePnlTst: number;
  convictionPnlTst: number;
  convictionCashTst: number;
  projectedThirdPlacePnlTst?: number;
}

export interface TournamentExactQuote {
  observedAt: string;
  decisionId: string;
  marketId: `0x${string}`;
  outcomeIndex: number;
  shares: number;
  maximumCostTst: number;
  priceImpact: number;
  settlesAt: string | null;
  assessment: Assessment;
}

/**
 * A paired branch is accepted only when another component has already
 * verified a net equity floor. It cannot represent an unresolved forecast or
 * another order that still needs capital. The floor must be incremental to
 * totalEquityTst so callers cannot count a marked position twice.
 */
export interface VerifiedPairedBranchTarget {
  verification: "locked_net_equity_floor";
  verified: true;
  verifiedAt: string;
  expiresAt: string;
  evidenceIds: string[];
  additionalNetEquityFloorTst: number;
}

export type TournamentGuardReason =
  | "tournament_policy_missing_or_invalid"
  | "book_missing_or_invalid"
  | "book_not_flat"
  | "leaderboard_book_mismatch"
  | "leaderboard_missing_or_invalid"
  | "leaderboard_stale"
  | "quote_missing_or_invalid"
  | "quote_stale"
  | "quote_precedes_exact_evidence"
  | "fresh_quote_exceeds_original_ceiling"
  | "not_deterministic_exact_result"
  | "exact_evidence_stale_or_invalid"
  | "quote_exceeds_dynamic_cost_cap"
  | "quote_exceeds_exact_impact_cap"
  | "paired_branch_invalid"
  | "paired_branch_stale"
  | "near_podium_profit_too_small"
  | "near_podium_deficit_too_large"
  | "settlement_missing_or_invalid"
  | "settlement_after_competition"
  | "settlement_too_late_for_near_podium"
  | "podium_target_not_cleared";

export type TournamentGuardDecision = {
  allowed: false;
  reason: TournamentGuardReason;
} | {
  allowed: true;
  route: "direct_podium" | "verified_paired_branch" | "near_podium_exact";
  maximumAuthorizedCostTst: number;
  podiumTargetPnlTst: number;
  requiredFinalPnlTst: number;
  directProjectedFinalEquityTst: number;
  directProjectedPnlTst: number;
  projectedFinalEquityTst: number;
  projectedPnlTst: number;
};

export interface TournamentSettings {
  orderCapTst: number;
  allocationPct: number;
  podiumBufferTst: number;
  leaderboardAgeMs: number;
  quoteAgeMs: number;
  impactCap: number;
}

function finiteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function tournamentSettings(policy: Policy): TournamentSettings | null {
  const orderCapTst = policy.maximumTournamentExactResultOrderTst;
  const allocationPct = policy.maximumTournamentEquityAllocationPct;
  const podiumBufferTst = policy.minimumTournamentPodiumBufferTst;
  const leaderboardAgeSeconds = policy.maximumTournamentLeaderboardAgeSeconds;
  const quoteAgeSeconds = policy.maximumTournamentQuoteAgeSeconds;
  const impactCap = Math.min(
    policy.maximumPublishedResultPriceImpact,
    ABSOLUTE_TOURNAMENT_EXACT_PRICE_IMPACT,
  );
  if (
    orderCapTst === undefined || !Number.isFinite(orderCapTst) || orderCapTst <= 0 ||
    orderCapTst > ABSOLUTE_TOURNAMENT_EXACT_COST_CAP_TST ||
    allocationPct === undefined || !Number.isFinite(allocationPct) || allocationPct <= 0 ||
    allocationPct > ABSOLUTE_TOURNAMENT_ALLOCATION_CAP_PCT ||
    podiumBufferTst === undefined || !finiteNonnegative(podiumBufferTst) ||
    podiumBufferTst < MINIMUM_TOURNAMENT_PODIUM_BUFFER_TST ||
    leaderboardAgeSeconds === undefined || !Number.isInteger(leaderboardAgeSeconds) ||
    leaderboardAgeSeconds <= 0 ||
    leaderboardAgeSeconds > ABSOLUTE_TOURNAMENT_LEADERBOARD_AGE_SECONDS ||
    quoteAgeSeconds === undefined || !Number.isInteger(quoteAgeSeconds) || quoteAgeSeconds <= 0 ||
    quoteAgeSeconds > ABSOLUTE_TOURNAMENT_QUOTE_AGE_SECONDS ||
    !Number.isFinite(impactCap) || impactCap <= 0
  ) return null;
  return {
    orderCapTst,
    allocationPct,
    podiumBufferTst,
    leaderboardAgeMs: leaderboardAgeSeconds * 1_000,
    quoteAgeMs: quoteAgeSeconds * 1_000,
    impactCap,
  };
}

function validBook(book: TournamentBook): boolean {
  return Number.isFinite(book.totalEquityTst) && book.totalEquityTst > 0 &&
    finiteNonnegative(book.availableTst) &&
    finiteNonnegative(book.deployedValueTst) &&
    Number.isInteger(book.positionCount) && book.positionCount >= 0 &&
    book.deployedValueTst <= book.totalEquityTst &&
    Math.abs(book.availableTst + book.deployedValueTst - book.totalEquityTst) <= 0.01;
}

export function maximumTournamentExactResultCost(input: {
  policy: Policy;
  book: TournamentBook;
}): number | null {
  const tournament = tournamentSettings(input.policy);
  if (!tournament || !validBook(input.book)) return null;
  const allocationLimitTst = input.book.totalEquityTst * tournament.allocationPct / 100;
  const portfolioRoomTst = Math.max(0, allocationLimitTst - input.book.deployedValueTst);
  const cashLimitTst = input.book.availableTst * tournament.allocationPct / 100;
  return Math.max(0, Math.min(
    tournament.orderCapTst,
    allocationLimitTst,
    portfolioRoomTst,
    cashLimitTst,
  ));
}

function isDeterministicExactResult(assessment: Assessment): boolean {
  return assessment.evidenceClass === "published_result" &&
    assessment.probability === 0.99 &&
    assessment.confidence === "high" &&
    assessment.status === "actionable";
}

function exactEvidenceIsFresh(input: {
  assessment: Assessment;
  policy: Policy;
  now: number;
}): boolean {
  const observedAt = timestamp(input.assessment.observedAt);
  const expiresAt = timestamp(input.assessment.expiresAt);
  if (
    observedAt === null || expiresAt === null || observedAt > input.now ||
    input.now >= expiresAt ||
    input.now - observedAt > input.policy.maximumAssessmentAgeMinutes * 60_000 ||
    input.assessment.sources.length < input.policy.minimumEvidenceSources ||
    !input.assessment.sources.some((source) => source.kind === "authoritative")
  ) return false;
  return input.assessment.sources.every((source) => {
    const sourceObservedAt = timestamp(source.observedAt);
    return sourceObservedAt !== null && sourceObservedAt <= observedAt;
  });
}

function pairedBranchProjection(input: {
  branch: VerifiedPairedBranchTarget;
  directProjectedFinalEquityTst: number;
  maximumAgeMs: number;
  now: number;
}): { projectedFinalEquityTst: number } | TournamentGuardReason {
  const verifiedAt = timestamp(input.branch.verifiedAt);
  const expiresAt = timestamp(input.branch.expiresAt);
  if (
    input.branch.verification !== "locked_net_equity_floor" || input.branch.verified !== true ||
    !finiteNonnegative(input.branch.additionalNetEquityFloorTst) ||
    input.branch.additionalNetEquityFloorTst === 0 ||
    input.branch.evidenceIds.length === 0 ||
    input.branch.evidenceIds.some((value) => value.trim().length === 0) ||
    verifiedAt === null || expiresAt === null || verifiedAt > input.now || verifiedAt >= expiresAt
  ) return "paired_branch_invalid";
  if (input.now >= expiresAt || input.now - verifiedAt > input.maximumAgeMs) {
    return "paired_branch_stale";
  }
  return {
    projectedFinalEquityTst:
      input.directProjectedFinalEquityTst + input.branch.additionalNetEquityFloorTst,
  };
}

export function guardTournamentExactResult(input: {
  policy: Policy;
  now: number;
  book: TournamentBook;
  leaderboard: TournamentPodiumTarget | null | undefined;
  quote: TournamentExactQuote | null | undefined;
  pairedBranch?: VerifiedPairedBranchTarget | null;
}): TournamentGuardDecision {
  const tournament = tournamentSettings(input.policy);
  if (!tournament) return { allowed: false, reason: "tournament_policy_missing_or_invalid" };
  if (!Number.isFinite(input.now) || !validBook(input.book)) {
    return { allowed: false, reason: "book_missing_or_invalid" };
  }

  if (
    !input.leaderboard || !Number.isFinite(input.leaderboard.liveThirdPlacePnlTst) ||
    input.leaderboard.liveThirdPlacePnlTst < 0 ||
    !Number.isFinite(input.leaderboard.convictionPnlTst) ||
    !finiteNonnegative(input.leaderboard.convictionCashTst) ||
    !Number.isFinite(input.leaderboard.initialTst) || input.leaderboard.initialTst <= 0 ||
    input.leaderboard.initialTst !== input.policy.minimumStartingTst
  ) {
    return { allowed: false, reason: "leaderboard_missing_or_invalid" };
  }
  const leaderboardObservedAt = timestamp(input.leaderboard.observedAt);
  if (leaderboardObservedAt === null || leaderboardObservedAt > input.now) {
    return { allowed: false, reason: "leaderboard_missing_or_invalid" };
  }
  if (input.now - leaderboardObservedAt > tournament.leaderboardAgeMs) {
    return { allowed: false, reason: "leaderboard_stale" };
  }
  const projectedTarget = input.leaderboard.projectedThirdPlacePnlTst;
  if (projectedTarget !== undefined && (!Number.isFinite(projectedTarget) || projectedTarget < 0)) {
    return { allowed: false, reason: "leaderboard_missing_or_invalid" };
  }
  if (input.book.positionCount !== 0 || input.book.deployedValueTst > BOOK_RECONCILIATION_TOLERANCE_TST) {
    return { allowed: false, reason: "book_not_flat" };
  }
  const leaderboardEquityTst = input.leaderboard.initialTst + input.leaderboard.convictionPnlTst;
  if (
    Math.abs(leaderboardEquityTst - input.book.totalEquityTst) > BOOK_RECONCILIATION_TOLERANCE_TST ||
    Math.abs(input.leaderboard.convictionCashTst - input.book.availableTst) >
      BOOK_RECONCILIATION_TOLERANCE_TST
  ) {
    return { allowed: false, reason: "leaderboard_book_mismatch" };
  }

  const quote = input.quote;
  if (
    !quote || quote.decisionId.trim().length === 0 ||
    !/^0x[0-9a-fA-F]{40}$/u.test(quote.marketId) ||
    !Number.isInteger(quote.outcomeIndex) || quote.outcomeIndex < 0 ||
    !Number.isFinite(quote.shares) || quote.shares <= 0 ||
    !Number.isFinite(quote.maximumCostTst) || quote.maximumCostTst <= 0 ||
    quote.maximumCostTst >= quote.shares ||
    !Number.isFinite(quote.priceImpact)
  ) return { allowed: false, reason: "quote_missing_or_invalid" };
  if (
    quote.marketId.toLowerCase() !== quote.assessment.marketId.toLowerCase() ||
    quote.outcomeIndex !== quote.assessment.outcomeIndex
  ) return { allowed: false, reason: "quote_missing_or_invalid" };
  if (!isDeterministicExactResult(quote.assessment)) {
    return { allowed: false, reason: "not_deterministic_exact_result" };
  }
  if (!exactEvidenceIsFresh({ assessment: quote.assessment, policy: input.policy, now: input.now })) {
    return { allowed: false, reason: "exact_evidence_stale_or_invalid" };
  }

  const quoteObservedAt = timestamp(quote.observedAt);
  if (quoteObservedAt === null || quoteObservedAt > input.now) {
    return { allowed: false, reason: "quote_missing_or_invalid" };
  }
  if (input.now - quoteObservedAt > tournament.quoteAgeMs) {
    return { allowed: false, reason: "quote_stale" };
  }
  if (quoteObservedAt < Date.parse(quote.assessment.observedAt)) {
    return { allowed: false, reason: "quote_precedes_exact_evidence" };
  }

  const maximumAuthorizedCostTst = maximumTournamentExactResultCost({
    policy: input.policy,
    book: input.book,
  });
  if (maximumAuthorizedCostTst === null) {
    return { allowed: false, reason: "tournament_policy_missing_or_invalid" };
  }
  if (quote.maximumCostTst > maximumAuthorizedCostTst) {
    return { allowed: false, reason: "quote_exceeds_dynamic_cost_cap" };
  }
  if (quote.priceImpact > tournament.impactCap) {
    return { allowed: false, reason: "quote_exceeds_exact_impact_cap" };
  }

  const settlesAt = timestamp(quote.settlesAt ?? "");
  const competitionEndsAt = timestamp(input.policy.competitionEndsAt);
  if (
    settlesAt === null || competitionEndsAt === null ||
    settlesAt <= input.now || competitionEndsAt <= input.now
  ) {
    return { allowed: false, reason: "settlement_missing_or_invalid" };
  }
  if (settlesAt >= competitionEndsAt) {
    return { allowed: false, reason: "settlement_after_competition" };
  }

  const podiumTargetPnlTst = Math.max(
    input.leaderboard.liveThirdPlacePnlTst,
    projectedTarget ?? input.leaderboard.liveThirdPlacePnlTst,
  );
  const requiredFinalPnlTst = podiumTargetPnlTst + tournament.podiumBufferTst;
  const directProjectedPnlTst =
    input.leaderboard.convictionPnlTst + quote.shares - quote.maximumCostTst;
  const directProjectedFinalEquityTst = input.leaderboard.initialTst + directProjectedPnlTst;
  if (!Number.isFinite(directProjectedFinalEquityTst)) {
    return { allowed: false, reason: "quote_missing_or_invalid" };
  }
  if (directProjectedPnlTst >= requiredFinalPnlTst) {
    return {
      allowed: true,
      route: "direct_podium",
      maximumAuthorizedCostTst,
      podiumTargetPnlTst,
      requiredFinalPnlTst,
      directProjectedFinalEquityTst,
      directProjectedPnlTst,
      projectedFinalEquityTst: directProjectedFinalEquityTst,
      projectedPnlTst: directProjectedPnlTst,
    };
  }

  if (input.pairedBranch) {
    const paired = pairedBranchProjection({
      branch: input.pairedBranch,
      directProjectedFinalEquityTst,
      maximumAgeMs: input.policy.maximumAssessmentAgeMinutes * 60_000,
      now: input.now,
    });
    if (typeof paired === "string") return { allowed: false, reason: paired };
    const projectedPnlTst = paired.projectedFinalEquityTst - input.leaderboard.initialTst;
    if (projectedPnlTst >= requiredFinalPnlTst) {
      return {
        allowed: true,
        route: "verified_paired_branch",
        maximumAuthorizedCostTst,
        podiumTargetPnlTst,
        requiredFinalPnlTst,
        directProjectedFinalEquityTst,
        directProjectedPnlTst,
        projectedFinalEquityTst: paired.projectedFinalEquityTst,
        projectedPnlTst,
      };
    }
  }

  const winningPayoutProfitFloorTst = quote.shares - quote.maximumCostTst;
  if (winningPayoutProfitFloorTst < MINIMUM_NEAR_PODIUM_EXACT_PROFIT_TST) {
    return { allowed: false, reason: "near_podium_profit_too_small" };
  }
  const maximumNearPodiumDeficitTst = Math.max(
    input.policy.minimumStartingTst,
    podiumTargetPnlTst * NEAR_PODIUM_EXACT_TARGET_FRACTION,
  );
  const podiumDeficitTst = Math.max(
    0,
    podiumTargetPnlTst - directProjectedPnlTst,
  );
  if (podiumDeficitTst > maximumNearPodiumDeficitTst) {
    return { allowed: false, reason: "near_podium_deficit_too_large" };
  }

  if (settlesAt > competitionEndsAt - MINIMUM_NEAR_PODIUM_SETTLEMENT_LEAD_MS) {
    return { allowed: false, reason: "settlement_too_late_for_near_podium" };
  }

  return {
    allowed: true,
    route: "near_podium_exact",
    maximumAuthorizedCostTst,
    podiumTargetPnlTst,
    requiredFinalPnlTst,
    directProjectedFinalEquityTst,
    directProjectedPnlTst,
    projectedFinalEquityTst: directProjectedFinalEquityTst,
    projectedPnlTst: directProjectedPnlTst,
  };
}
