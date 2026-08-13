import { createHash } from "node:crypto";
import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { resolve } from "node:path";
import { sendAlert } from "./alerts.js";
import { loadAssessments, loadPolicy, stateDirectory } from "./config.js";
import { ExitLedger } from "./exit-ledger.js";
import type { ExitRecord } from "./exit-ledger.js";
import { TradeLedger } from "./ledger.js";
import type { TradeRecord } from "./ledger.js";
import type { Assessment, PositionView } from "./model.js";
import { assertMaintenanceReadiness, readBook } from "./runtime.js";
import { quoteCandidates } from "./engine.js";
import { isAssessmentEvidenceValid, selectCandidates } from "./planner.js";

const sharesToRaw = (shares: number) => BigInt(Math.floor(shares * 1e6)) * 10n ** 12n;
const rawToTokens = (raw: bigint) => Number(raw) / 1e6;

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

export function bestAlternativeForMarket(
  alternatives: Array<{ marketId: string; netEdge: number }>,
  currentMarketId: string,
): { marketId: string; netEdge: number } | null {
  return alternatives
    .filter((candidate) => candidate.marketId.toLowerCase() !== currentMarketId.toLowerCase())
    .sort((left, right) => right.netEdge - left.netEdge)[0] ?? null;
}

export async function runPositionManagementCycle(client: DelphiClient, now = Date.now()) {
  const [policy, assessments, book] = await Promise.all([loadPolicy(), loadAssessments(), readBook(client)]);
  await assertMaintenanceReadiness(book);
  const tradeLedger = new TradeLedger(resolve(stateDirectory(), "trade-ledger.json"));
  const exitLedger = new ExitLedger(resolve(stateDirectory(), "exit-ledger.json"));
  const pending = await exitLedger.pending();
  if (pending) throw new Error(`unresolved exit intent ${pending.decisionId}; automatic writes blocked`);
  const buyPending = await tradeLedger.pending();
  if (buyPending) throw new Error(`unresolved trade intent ${buyPending.decisionId}; automatic exits blocked`);
  const buys = await tradeLedger.records();
  const exits = await exitLedger.records();

  const resultCandidates = selectCandidates({ now, policy, markets: book.markets, positions: book.positions, assessments })
    .filter((candidate) => candidate.assessment.confidence === "high" && candidate.assessment.evidenceClass === "published_result");
  const { plans: executableAlternatives } = await quoteCandidates({
    client,
    candidates: resultCandidates,
    policy,
    book,
    mode: "full",
  });
  const alternatives = executableAlternatives.map((plan) => ({ marketId: plan.market.id, netEdge: plan.netEdge }));

  for (const position of book.positions) {
    const market = book.markets.find((candidate) => candidate.id.toLowerCase() === position.marketId.toLowerCase());
    if (!market || market.status !== "open") continue;
    const assessment = assessments
      .filter((candidate) => candidate.marketId.toLowerCase() === position.marketId.toLowerCase())
      .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
    if (!assessment || !isAssessmentEvidenceValid({ assessment, policy, now })) continue;
    if (now >= Date.parse(assessment.expiresAt) || now >= Date.parse(market.resolvesAt ?? "1970-01-01")) continue;

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
    const bestAlternative = bestAlternativeForMarket(alternatives, market.id);
    const reason = exitReason({
      position,
      assessment,
      minimumProceedsTst,
      averageCostPerShare,
      minimumProfitTakeReturnPct: policy.minimumProfitTakeReturnPct ?? 3,
      maximumHoldEdgeForProfitTake: policy.maximumHoldEdgeForProfitTake ?? 0.02,
      bestAlternativeNetEdge: bestAlternative?.netEdge ?? null,
      minimumRotationEdgeAdvantage: policy.minimumRotationEdgeAdvantage ?? 0.15,
    });
    if (!reason) continue;

    const decisionId = createHash("sha256").update(JSON.stringify({
      marketId: market.id.toLowerCase(), outcomeIndex: position.outcomeIndex, shares: position.shares,
      reason, assessmentObservedAt: assessment.observedAt,
    })).digest("hex");
    if (await exitLedger.get(decisionId)) continue;
    await exitLedger.prepare({
      decisionId, marketId: market.id, outcomeIndex: position.outcomeIndex,
      shares: position.shares, quotedProceedsTst, minimumProceedsTst, reason, createdAt: now,
    });
    const result = await client.sellShares({
      marketAddress: market.id,
      outcomeIdx: position.outcomeIndex,
      sharesIn,
      minTokensOut: minimumProceedsAtomic,
    });
    await exitLedger.confirm(decisionId, result.transactionHash);
    await sendAlert("POSITION EXITED", `${reason}\n${market.question}\n${market.outcomes[position.outcomeIndex]} | ${position.shares} shares | quoted ${quotedProceedsTst.toFixed(4)} TST\n${result.transactionHash}`);
    return { status: "SOLD" as const, reason, transactionHash: result.transactionHash };
  }
  return { status: "NO_EXIT" as const, reason: "no fresh evidence flip or converged profitable position" };
}
