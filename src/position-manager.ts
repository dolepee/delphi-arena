import { createHash } from "node:crypto";
import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { resolve } from "node:path";
import { sendAlert } from "./alerts.js";
import { loadAssessments, loadPolicy, stateDirectory } from "./config.js";
import { ExitLedger } from "./exit-ledger.js";
import { TradeLedger } from "./ledger.js";
import type { Assessment, PositionView } from "./model.js";
import { assertMaintenanceReadiness, readBook } from "./runtime.js";

const sharesToRaw = (shares: number) => BigInt(Math.floor(shares * 1e6)) * 10n ** 12n;
const rawToTokens = (raw: bigint) => Number(raw) / 1e6;

export function exitReason(input: {
  position: PositionView;
  assessment: Assessment;
  quotedProceedsTst: number;
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
  const averageExitPrice = input.quotedProceedsTst / input.position.shares;
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

export async function runPositionManagementCycle(client: DelphiClient, now = Date.now()) {
  const [policy, assessments, book] = await Promise.all([loadPolicy(), loadAssessments(), readBook(client)]);
  await assertMaintenanceReadiness(book);
  const tradeLedger = new TradeLedger(resolve(stateDirectory(), "trade-ledger.json"));
  const exitLedger = new ExitLedger(resolve(stateDirectory(), "exit-ledger.json"));
  const pending = await exitLedger.pending();
  if (pending) throw new Error(`unresolved exit intent ${pending.decisionId}; automatic writes blocked`);
  const buyPending = await tradeLedger.pending();
  if (buyPending) throw new Error(`unresolved trade intent ${buyPending.decisionId}; automatic exits blocked`);
  const buys = (await tradeLedger.records()).filter((record) => record.status === "CONFIRMED");

  let bestAlternative: { marketId: string; netEdge: number } | null = null;
  for (const assessment of assessments) {
    const market = book.markets.find((candidate) => candidate.id.toLowerCase() === assessment.marketId.toLowerCase());
    if (
      !market || market.status !== "open" || assessment.status !== "actionable" ||
      assessment.confidence !== "high" || assessment.evidenceClass !== "published_result" ||
      now >= Date.parse(assessment.expiresAt) || now >= Date.parse(market.resolvesAt ?? "1970-01-01")
    ) continue;
    const opposingPosition = book.positions.some((position) =>
      position.marketId.toLowerCase() === market.id.toLowerCase() &&
      position.outcomeIndex !== assessment.outcomeIndex
    );
    if (opposingPosition) continue;
    const spot = market.prices[assessment.outcomeIndex];
    if (spot === undefined || spot <= 0) continue;
    const probeShares = Math.max(0.01, Math.floor((policy.minimumFullOrderTst / spot) * 100) / 100);
    try {
      const quote = await client.quoteBuy({
        marketAddress: market.id,
        outcomeIdx: assessment.outcomeIndex,
        sharesOut: sharesToRaw(probeShares),
      });
      const averagePrice = rawToTokens(quote.tokensIn) / probeShares;
      const stressedAveragePrice = averagePrice * (1 + policy.slippagePct / 100);
      const netEdge = assessment.probability - stressedAveragePrice;
      if (netEdge > (bestAlternative?.netEdge ?? 0)) bestAlternative = { marketId: market.id, netEdge };
    } catch {
      continue;
    }
  }

  for (const position of book.positions) {
    const market = book.markets.find((candidate) => candidate.id.toLowerCase() === position.marketId.toLowerCase());
    if (!market || market.status !== "open") continue;
    const assessment = assessments
      .filter((candidate) => candidate.marketId.toLowerCase() === position.marketId.toLowerCase())
      .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
    if (!assessment || assessment.status !== "actionable") continue;
    if (now >= Date.parse(assessment.expiresAt) || now >= Date.parse(market.resolvesAt ?? "1970-01-01")) continue;

    const sharesIn = sharesToRaw(position.shares);
    if (sharesIn <= 0n) continue;
    const quote = await client.quoteSell({ marketAddress: market.id, outcomeIdx: position.outcomeIndex, sharesIn });
    const quotedProceedsTst = rawToTokens(quote.tokensOut);
    const matchingBuys = buys.filter((record) =>
      record.marketId.toLowerCase() === position.marketId.toLowerCase() &&
      record.outcomeIndex === position.outcomeIndex
    );
    const boughtShares = matchingBuys.reduce((total, record) => total + record.shares, 0);
    const averageCostPerShare = boughtShares > 0
      ? matchingBuys.reduce((total, record) => total + record.quotedCostTst, 0) / boughtShares
      : null;
    const reason = exitReason({
      position,
      assessment,
      quotedProceedsTst,
      averageCostPerShare,
      minimumProfitTakeReturnPct: policy.minimumProfitTakeReturnPct ?? 3,
      maximumHoldEdgeForProfitTake: policy.maximumHoldEdgeForProfitTake ?? 0.02,
      bestAlternativeNetEdge: bestAlternative?.marketId.toLowerCase() === market.id.toLowerCase()
        ? null
        : (bestAlternative?.netEdge ?? null),
      minimumRotationEdgeAdvantage: policy.minimumRotationEdgeAdvantage ?? 0.15,
    });
    if (!reason) continue;

    const minimumProceedsAtomic = quote.tokensOut * BigInt(Math.floor((100 - (policy.exitSlippagePct ?? policy.slippagePct)) * 100)) / 10_000n;
    const minimumProceedsTst = rawToTokens(minimumProceedsAtomic);
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
