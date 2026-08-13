import { createHash } from "node:crypto";
import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { resolve } from "node:path";
import { sendAlert } from "./alerts.js";
import { loadAssessments, loadPolicy, stateDirectory } from "./config.js";
import { assessmentEvidenceFingerprint, blocksEntryForAssessment, ExitLedger, pendingRotationDestination } from "./exit-ledger.js";
import type { ExitRecord } from "./exit-ledger.js";
import { TradeLedger } from "./ledger.js";
import type { TradeRecord } from "./ledger.js";
import type { Assessment, PositionView } from "./model.js";
import { activationMode, assertMaintenanceReadiness, readBook } from "./runtime.js";
import type { Book } from "./runtime.js";
import { quoteCandidates } from "./engine.js";
import { isAssessmentEvidenceValid, selectCandidates } from "./planner.js";
import { marketToView } from "./delphi.js";

const sharesToRaw = (shares: number) => BigInt(Math.floor(shares * 1e6)) * 10n ** 12n;
const rawToTokens = (raw: bigint) => Number(raw) / 1e6;

export function isPastMarketResolution(resolvesAt: string | null | undefined, now: number): boolean {
  return Boolean(resolvesAt) && now >= Date.parse(resolvesAt!);
}

export function assessmentForPosition(input: {
  assessments: Assessment[];
  position: PositionView;
  market: { outcomes: string[]; prices: number[] };
  policy: Awaited<ReturnType<typeof loadPolicy>>;
  now: number;
}): Assessment | null {
  const valid = input.assessments.filter((assessment) =>
    assessment.marketId.toLowerCase() === input.position.marketId.toLowerCase() &&
    input.market.outcomes[assessment.outcomeIndex] !== undefined &&
    input.market.prices[assessment.outcomeIndex] !== undefined &&
    isAssessmentEvidenceValid({ assessment, policy: input.policy, now: input.now })
  );
  const publishedResults = valid.filter((assessment) =>
    assessment.evidenceClass === "published_result" && assessment.confidence === "high"
  );
  if (new Set(publishedResults.map((assessment) => assessment.outcomeIndex)).size > 1) return null;
  const preferred = publishedResults.length > 0
    ? publishedResults
    : valid.filter((assessment) => assessment.outcomeIndex === input.position.outcomeIndex);
  return preferred.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0] ?? null;
}

export function withoutConflictingPublishedResults<T extends {
  market: { id: string };
  assessment: Assessment;
}>(candidates: T[]): T[] {
  const outcomes = new Map<string, Set<number>>();
  for (const candidate of candidates) {
    const key = candidate.market.id.toLowerCase();
    const set = outcomes.get(key) ?? new Set<number>();
    set.add(candidate.assessment.outcomeIndex);
    outcomes.set(key, set);
  }
  return candidates.filter((candidate) =>
    (outcomes.get(candidate.market.id.toLowerCase())?.size ?? 0) === 1
  );
}

export function exitReason(input: {
  position: PositionView;
  assessment: Assessment;
  minimumProceedsTst: number;
  averageCostPerShare: number | null;
  minimumProfitTakeReturnPct: number;
  maximumHoldEdgeForProfitTake: number;
  bestAlternativeNetEdge?: number | null;
  minimumRotationEdgeAdvantage?: number;
}): "EVIDENCE_FLIP" | "PROFIT_TAKE" | "OPPORTUNITY_ROTATION" | null {
  if (
    input.assessment.outcomeIndex !== input.position.outcomeIndex &&
    input.assessment.status === "actionable" &&
    input.assessment.confidence === "high" &&
    input.assessment.evidenceClass === "published_result"
  ) return "EVIDENCE_FLIP";

  if (input.assessment.outcomeIndex !== input.position.outcomeIndex || input.averageCostPerShare === null) return null;
  const averageExitPrice = input.minimumProceedsTst / input.position.shares;
  const returnPct = (averageExitPrice / input.averageCostPerShare - 1) * 100;
  const holdEdge = input.assessment.probability - averageExitPrice;
  if (
    returnPct >= 0 &&
    input.bestAlternativeNetEdge !== null &&
    input.bestAlternativeNetEdge !== undefined &&
    input.bestAlternativeNetEdge - holdEdge >= (input.minimumRotationEdgeAdvantage ?? 0.15)
  ) return "OPPORTUNITY_ROTATION";
  return returnPct >= input.minimumProfitTakeReturnPct && holdEdge <= input.maximumHoldEdgeForProfitTake
    ? "PROFIT_TAKE"
    : null;
}

export function remainingAverageCostPerShare(input: {
  position: PositionView;
  buys: TradeRecord[];
  exits: ExitRecord[];
  entrySlippagePct: number;
}): number | null {
  const keyMatches = (record: { marketId: string; outcomeIndex: number }) =>
    record.marketId.toLowerCase() === input.position.marketId.toLowerCase() &&
    record.outcomeIndex === input.position.outcomeIndex;
  const lots = input.buys
    .filter((record) => record.status === "CONFIRMED" && keyMatches(record))
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((record) => ({
      shares: record.shares,
      costPerShare: (
        record.actualCostTst ?? record.maximumCostTst ?? record.quotedCostTst * (1 + input.entrySlippagePct / 100)
      ) / record.shares,
    }));
  let sharesExited = input.exits
    .filter((record) => record.status === "CONFIRMED" && keyMatches(record))
    .reduce((total, record) => total + record.shares, 0);
  for (const lot of lots) {
    const consumed = Math.min(lot.shares, sharesExited);
    lot.shares -= consumed;
    sharesExited -= consumed;
  }
  if (sharesExited > 1e-6) return null;
  const remaining = lots.filter((lot) => lot.shares > 1e-6);
  const recordedShares = remaining.reduce((total, lot) => total + lot.shares, 0);
  if (Math.abs(recordedShares - input.position.shares) > 1e-4) return null;
  let sharesNeeded = input.position.shares;
  let cost = 0;
  for (const lot of remaining) {
    const included = Math.min(lot.shares, sharesNeeded);
    cost += included * lot.costPerShare;
    sharesNeeded -= included;
    if (sharesNeeded <= 1e-6) break;
  }
  return input.position.shares > 0 && sharesNeeded <= 1e-6 ? cost / input.position.shares : null;
}

export function positionLedgerGeneration(input: {
  position: PositionView;
  buys: TradeRecord[];
  exits: ExitRecord[];
}): string {
  const keyMatches = (record: { marketId: string; outcomeIndex: number }) =>
    record.marketId.toLowerCase() === input.position.marketId.toLowerCase() &&
    record.outcomeIndex === input.position.outcomeIndex;
  return createHash("sha256").update(JSON.stringify({
    buys: input.buys.filter(keyMatches).map((record) => [
      record.decisionId, record.status, record.transactionHash ?? null, record.shares,
    ]),
    exits: input.exits.filter(keyMatches).map((record) => [
      record.decisionId, record.status, record.transactionHash ?? null, record.shares,
    ]),
  })).digest("hex");
}

export function bestAlternativeForMarket(
  alternatives: Array<{ marketId: string; netEdge: number }>,
  currentMarketId: string,
): { marketId: string; netEdge: number } | null {
  return alternatives
    .filter((candidate) => candidate.marketId.toLowerCase() !== currentMarketId.toLowerCase())
    .sort((left, right) => right.netEdge - left.netEdge)[0] ?? null;
}

export function postExitBookForRotation(
  book: Book,
  position: PositionView,
  minimumProceedsTst: number,
): Book {
  const positions = book.positions.filter((candidate) =>
    candidate.marketId.toLowerCase() !== position.marketId.toLowerCase() ||
    candidate.outcomeIndex !== position.outcomeIndex
  );
  const deployedValueTst = positions.reduce(
    (total, candidate) => total + candidate.shares * candidate.markPrice,
    0,
  );
  const availableTst = book.availableTst + minimumProceedsTst;
  return {
    ...book,
    positions,
    availableTst,
    deployedValueTst,
    totalEquityTst: availableTst + deployedValueTst,
  };
}

export async function runPositionManagementCycle(client: DelphiClient, now = Date.now()) {
  const [policy, assessments, book] = await Promise.all([loadPolicy(), loadAssessments(), readBook(client)]);
  await assertMaintenanceReadiness(book);
  if (await activationMode() !== "full") {
    throw new Error("position management requires full-live approval");
  }
  const tradeLedger = new TradeLedger(resolve(stateDirectory(), "trade-ledger.json"));
  const exitLedger = new ExitLedger(resolve(stateDirectory(), "exit-ledger.json"));
  const pending = await exitLedger.pending();
  if (pending) throw new Error(`unresolved exit intent ${pending.decisionId}; automatic writes blocked`);
  const buyPending = await tradeLedger.pending();
  if (buyPending) throw new Error(`unresolved trade intent ${buyPending.decisionId}; automatic exits blocked`);
  const buys = await tradeLedger.records();
  const exits = await exitLedger.records();
  const pendingRotation = pendingRotationDestination(exits, buys, now);

  for (const position of book.positions) {
    const market = book.markets.find((candidate) => candidate.id.toLowerCase() === position.marketId.toLowerCase());
    if (!market || market.status !== "open") continue;
    const assessment = assessmentForPosition({ assessments, position, market, policy, now });
    if (!assessment) continue;
    if (now >= Date.parse(assessment.expiresAt) || isPastMarketResolution(market.resolvesAt, now)) continue;

    const sharesIn = sharesToRaw(position.shares);
    if (sharesIn <= 0n) continue;
    const quote = await client.quoteSell({ marketAddress: market.id, outcomeIdx: position.outcomeIndex, sharesIn });
    const quotedProceedsTst = rawToTokens(quote.tokensOut);
    const minimumProceedsAtomic = quote.tokensOut * BigInt(Math.floor((100 - (policy.exitSlippagePct ?? policy.slippagePct)) * 100)) / 10_000n;
    const minimumProceedsTst = rawToTokens(minimumProceedsAtomic);
    const averageCostPerShare = remainingAverageCostPerShare({
      position,
      buys,
      exits,
      entrySlippagePct: policy.slippagePct,
    });
    const postExitBook = postExitBookForRotation(book, position, minimumProceedsTst);
    const resultCandidates = withoutConflictingPublishedResults(selectCandidates({
      now,
      policy,
      markets: postExitBook.markets,
      positions: postExitBook.positions,
      assessments,
    }).filter((candidate) =>
      candidate.assessment.confidence === "high" &&
      candidate.assessment.evidenceClass === "published_result" &&
      !blocksEntryForAssessment(
        exits,
        candidate.market.id,
        candidate.assessment.outcomeIndex,
        assessmentEvidenceFingerprint(candidate.assessment),
      )
    ));
    const { plans: executableAlternatives } = await quoteCandidates({
      client,
      candidates: resultCandidates,
      policy,
      book: postExitBook,
      mode: "full",
    });
    const alternatives = executableAlternatives.map((plan) => ({
      marketId: plan.market.id,
      netEdge: plan.netEdge,
    }));
    const bestAlternative = bestAlternativeForMarket(alternatives, market.id);
    const reason = exitReason({
      position,
      assessment,
      minimumProceedsTst,
      averageCostPerShare,
      minimumProfitTakeReturnPct: policy.minimumProfitTakeReturnPct ?? 3,
      maximumHoldEdgeForProfitTake: policy.maximumHoldEdgeForProfitTake ?? 0.02,
      bestAlternativeNetEdge: pendingRotation ? null : bestAlternative?.netEdge ?? null,
      minimumRotationEdgeAdvantage: policy.minimumRotationEdgeAdvantage ?? 0.15,
    });
    if (!reason) continue;

    const executionNow = Date.now();
    if (
      executionNow >= Date.parse(policy.competitionEndsAt) ||
      !isAssessmentEvidenceValid({ assessment, policy, now: executionNow }) ||
      isPastMarketResolution(market.resolvesAt, executionNow)
    ) continue;
    const freshBook = await readBook(client);
    await assertMaintenanceReadiness(freshBook);
    const freshMarket = freshBook.markets.find((candidate) =>
      candidate.id.toLowerCase() === market.id.toLowerCase()
    );
    const freshPosition = freshBook.positions.find((candidate) =>
      candidate.marketId.toLowerCase() === position.marketId.toLowerCase() &&
      candidate.outcomeIndex === position.outcomeIndex
    );
    if (
      !freshMarket || freshMarket.status !== "open" ||
      freshMarket.outcomes[assessment.outcomeIndex] === undefined ||
      freshMarket.prices[assessment.outcomeIndex] === undefined ||
      !freshPosition || Math.abs(freshPosition.shares - position.shares) > 1e-6
    ) continue;

    const freshQuote = await client.quoteSell({
      marketAddress: freshMarket.id,
      outcomeIdx: freshPosition.outcomeIndex,
      sharesIn,
    });
    const freshQuotedProceedsTst = rawToTokens(freshQuote.tokensOut);
    const freshMinimumProceedsAtomic = freshQuote.tokensOut *
      BigInt(Math.floor((100 - (policy.exitSlippagePct ?? policy.slippagePct)) * 100)) /
      10_000n;
    const freshMinimumProceedsTst = rawToTokens(freshMinimumProceedsAtomic);
    const freshPostExitBook = postExitBookForRotation(
      freshBook,
      freshPosition,
      freshMinimumProceedsTst,
    );
    const freshCandidates = withoutConflictingPublishedResults(selectCandidates({
      now: Date.now(),
      policy,
      markets: freshPostExitBook.markets,
      positions: freshPostExitBook.positions,
      assessments,
    }).filter((candidate) =>
      candidate.assessment.confidence === "high" &&
      candidate.assessment.evidenceClass === "published_result" &&
      !blocksEntryForAssessment(
        exits,
        candidate.market.id,
        candidate.assessment.outcomeIndex,
        assessmentEvidenceFingerprint(candidate.assessment),
      )
    ));
    const { plans: freshExecutableAlternatives } = await quoteCandidates({
      client,
      candidates: freshCandidates,
      policy,
      book: freshPostExitBook,
      mode: "full",
    });
    const freshBestAlternative = bestAlternativeForMarket(
      freshExecutableAlternatives.map((plan) => ({
        marketId: plan.market.id,
        netEdge: plan.netEdge,
      })),
      freshMarket.id,
    );
    const freshBestAlternativePlan = freshBestAlternative
      ? freshExecutableAlternatives.find((plan) =>
        plan.market.id.toLowerCase() === freshBestAlternative.marketId.toLowerCase()
      ) ?? null
      : null;
    const freshReason = exitReason({
      position: freshPosition,
      assessment,
      minimumProceedsTst: freshMinimumProceedsTst,
      averageCostPerShare,
      minimumProfitTakeReturnPct: policy.minimumProfitTakeReturnPct ?? 3,
      maximumHoldEdgeForProfitTake: policy.maximumHoldEdgeForProfitTake ?? 0.02,
      bestAlternativeNetEdge: pendingRotation ? null : freshBestAlternative?.netEdge ?? null,
      minimumRotationEdgeAdvantage: policy.minimumRotationEdgeAdvantage ?? 0.15,
    });
    if (!freshReason || freshReason !== reason) continue;

    let rotationDestinationMarketId: string | undefined;
    let rotationDestinationOutcomeIndex: number | undefined;
    let rotationDestinationAssessmentFingerprint: string | undefined;
    let rotationDestinationExpiresAt: string | undefined;
    if (freshReason === "OPPORTUNITY_ROTATION") {
      if (!freshBestAlternativePlan) continue;
      const destinationMarket = marketToView(await client.getMarket({
        id: freshBestAlternativePlan.market.id,
        pricesAndImpliedProbabilities: true,
      }));
      const destinationCheckNow = Date.now();
      if (
        destinationMarket.status !== "open" ||
        isPastMarketResolution(destinationMarket.resolvesAt, destinationCheckNow) ||
        !isAssessmentEvidenceValid({
          assessment: freshBestAlternativePlan.assessment,
          policy,
          now: destinationCheckNow,
        }) ||
        destinationMarket.outcomes[freshBestAlternativePlan.assessment.outcomeIndex] === undefined ||
        destinationMarket.prices[freshBestAlternativePlan.assessment.outcomeIndex] === undefined
      ) continue;
      const destinationBook: Book = {
        ...freshPostExitBook,
        markets: freshPostExitBook.markets.map((candidate) =>
          candidate.id.toLowerCase() === destinationMarket.id.toLowerCase()
            ? destinationMarket
            : candidate
        ),
      };
      const destinationCandidates = withoutConflictingPublishedResults(selectCandidates({
        now: destinationCheckNow,
        policy,
        markets: destinationBook.markets,
        positions: destinationBook.positions,
        assessments,
      }).filter((candidate) =>
        candidate.market.id.toLowerCase() === destinationMarket.id.toLowerCase() &&
        candidate.assessment.confidence === "high" &&
        candidate.assessment.evidenceClass === "published_result" &&
        !blocksEntryForAssessment(
          exits,
          candidate.market.id,
          candidate.assessment.outcomeIndex,
          assessmentEvidenceFingerprint(candidate.assessment),
        )
      ));
      const { plans: destinationPlans } = await quoteCandidates({
        client,
        candidates: destinationCandidates,
        policy,
        book: destinationBook,
        mode: "full",
      });
      const destinationPlan = destinationPlans.find((plan) =>
        plan.market.id.toLowerCase() === destinationMarket.id.toLowerCase()
      );
      if (!destinationPlan || exitReason({
        position: freshPosition,
        assessment,
        minimumProceedsTst: freshMinimumProceedsTst,
        averageCostPerShare,
        minimumProfitTakeReturnPct: policy.minimumProfitTakeReturnPct ?? 3,
        maximumHoldEdgeForProfitTake: policy.maximumHoldEdgeForProfitTake ?? 0.02,
        bestAlternativeNetEdge: destinationPlan.netEdge,
        minimumRotationEdgeAdvantage: policy.minimumRotationEdgeAdvantage ?? 0.15,
      }) !== "OPPORTUNITY_ROTATION") continue;
      rotationDestinationMarketId = destinationPlan.market.id;
      rotationDestinationOutcomeIndex = destinationPlan.assessment.outcomeIndex;
      rotationDestinationAssessmentFingerprint = assessmentEvidenceFingerprint(destinationPlan.assessment);
      rotationDestinationExpiresAt = new Date(Math.min(
        Date.parse(destinationPlan.assessment.expiresAt),
        Date.parse(destinationPlan.assessment.observedAt) + policy.maximumAssessmentAgeMinutes * 60_000,
        destinationPlan.market.resolvesAt ? Date.parse(destinationPlan.market.resolvesAt) : Number.POSITIVE_INFINITY,
        Date.parse(policy.competitionEndsAt),
      )).toISOString();
    }
    const finalNow = Date.now();
    if (
      finalNow >= Date.parse(policy.competitionEndsAt) ||
      !isAssessmentEvidenceValid({ assessment, policy, now: finalNow }) ||
      isPastMarketResolution(freshMarket.resolvesAt, finalNow) ||
      (rotationDestinationExpiresAt !== undefined && finalNow >= Date.parse(rotationDestinationExpiresAt))
    ) continue;
    if (await activationMode() !== "full") continue;

    const positionGeneration = positionLedgerGeneration({ position, buys, exits });
    const decisionId = createHash("sha256").update(JSON.stringify({
      marketId: market.id.toLowerCase(), outcomeIndex: position.outcomeIndex, shares: position.shares,
      reason, assessmentObservedAt: assessment.observedAt, positionGeneration,
    })).digest("hex");
    if (await exitLedger.get(decisionId)) continue;
    await exitLedger.prepare({
      decisionId, marketId: market.id, outcomeIndex: position.outcomeIndex,
      shares: position.shares, quotedProceedsTst: freshQuotedProceedsTst,
      minimumProceedsTst: freshMinimumProceedsTst, reason,
      assessmentObservedAt: assessment.observedAt,
      assessmentFingerprint: assessmentEvidenceFingerprint(assessment),
      rotationDestinationMarketId,
      rotationDestinationOutcomeIndex,
      rotationDestinationAssessmentFingerprint,
      rotationDestinationExpiresAt,
      createdAt: finalNow,
    });
    const result = await client.sellShares({
      marketAddress: market.id,
      outcomeIdx: position.outcomeIndex,
      sharesIn,
      minTokensOut: freshMinimumProceedsAtomic,
    });
    await exitLedger.confirm(decisionId, result.transactionHash);
    await sendAlert("POSITION EXITED", `${reason}\n${market.question}\n${market.outcomes[position.outcomeIndex]} | ${position.shares} shares | quoted ${freshQuotedProceedsTst.toFixed(4)} TST\n${result.transactionHash}`);
    return { status: "SOLD" as const, reason, transactionHash: result.transactionHash };
  }
  return { status: "NO_EXIT" as const, reason: "no fresh evidence flip or converged profitable position" };
}
