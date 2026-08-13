import { createHash } from "node:crypto";
import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { resolve } from "node:path";
import { sendAlert } from "./alerts.js";
import { loadAssessments, loadPolicy, stateDirectory } from "./config.js";
import { assessmentEvidenceFingerprint, ExitLedger } from "./exit-ledger.js";
import type { ExitRecord } from "./exit-ledger.js";
import { TradeLedger } from "./ledger.js";
import type { TradeRecord } from "./ledger.js";
import type { Assessment, PositionView } from "./model.js";
import { activationMode, assertMaintenanceReadiness, readBook } from "./runtime.js";
import { isAssessmentEvidenceValid } from "./planner.js";

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

export function exitReason(input: {
  position: PositionView;
  assessment: Assessment;
  minimumProceedsTst: number;
  averageCostPerShare: number | null;
  minimumProfitTakeReturnPct: number;
  maximumHoldEdgeForProfitTake: number;
}): "EVIDENCE_FLIP" | "PROFIT_TAKE" | null {
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
  const lots: Array<{ shares: number; costPerShare: number }> = [];
  const events = [
    ...input.buys.filter((record) => record.status === "CONFIRMED" && keyMatches(record))
      .map((record) => ({ kind: "buy" as const, record })),
    ...input.exits.filter((record) => record.status === "CONFIRMED" && keyMatches(record))
      .map((record) => ({ kind: "exit" as const, record })),
  ].sort((left, right) => left.record.createdAt - right.record.createdAt ||
    (left.kind === "buy" ? -1 : 1));
  for (const event of events) {
    if (event.kind === "buy") {
      lots.push({
        shares: event.record.shares,
        costPerShare: (
          event.record.actualCostTst ?? event.record.maximumCostTst ??
          event.record.quotedCostTst * (1 + input.entrySlippagePct / 100)
        ) / event.record.shares,
      });
      continue;
    }
    let sharesExited = event.record.shares;
    for (const lot of lots) {
      const consumed = Math.min(lot.shares, sharesExited);
      lot.shares -= consumed;
      sharesExited -= consumed;
      if (sharesExited <= 1e-6) break;
    }
    // Any unmatched portion belonged to inventory that predated this ledger.
    // It must not consume a later, newly opened lot.
  }
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
}): string {
  const keyMatches = (record: { marketId: string; outcomeIndex: number }) =>
    record.marketId.toLowerCase() === input.position.marketId.toLowerCase() &&
    record.outcomeIndex === input.position.outcomeIndex;
  return createHash("sha256").update(JSON.stringify({
    buys: input.buys.filter(keyMatches).map((record) => [
      record.decisionId, record.status, record.transactionHash ?? null, record.shares,
    ]),
  })).digest("hex");
}

export async function runPositionManagementCycle(client: DelphiClient, now = Date.now()) {
  const [policy, assessments, book] = await Promise.all([loadPolicy(), loadAssessments(), readBook(client)]);
  await assertMaintenanceReadiness(book);
  if (book.gasEth < policy.minimumGasEth) {
    throw new Error(`position management requires at least ${policy.minimumGasEth} ETH gas reserve`);
  }
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
    const reason = exitReason({
      position,
      assessment,
      minimumProceedsTst,
      averageCostPerShare,
      minimumProfitTakeReturnPct: policy.minimumProfitTakeReturnPct ?? 3,
      maximumHoldEdgeForProfitTake: policy.maximumHoldEdgeForProfitTake ?? 0.02,
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
    if (freshBook.gasEth < policy.minimumGasEth) continue;
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
    const freshReason = exitReason({
      position: freshPosition,
      assessment,
      minimumProceedsTst: freshMinimumProceedsTst,
      averageCostPerShare,
      minimumProfitTakeReturnPct: policy.minimumProfitTakeReturnPct ?? 3,
      maximumHoldEdgeForProfitTake: policy.maximumHoldEdgeForProfitTake ?? 0.02,
    });
    if (!freshReason || freshReason !== reason) continue;
    const finalNow = Date.now();
    if (
      finalNow >= Date.parse(policy.competitionEndsAt) ||
      !isAssessmentEvidenceValid({ assessment, policy, now: finalNow }) ||
      isPastMarketResolution(freshMarket.resolvesAt, finalNow)
    ) continue;
    if (await activationMode() !== "full") continue;

    const positionGeneration = positionLedgerGeneration({ position, buys });
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
      soldOutcomeCooldownUntil: reason === "EVIDENCE_FLIP" ? assessment.expiresAt : undefined,
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
