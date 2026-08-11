import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadAssessments, loadPolicy, stateDirectory } from "./config.js";
import { TradeLedger } from "./ledger.js";
import { orderBudget, selectCandidates } from "./planner.js";
import { findQuotedPlan } from "./quote-plan.js";
import { assertWriteReadiness, readBook } from "./runtime.js";
import { sendAlert } from "./alerts.js";

const sharesToRaw = (shares: number) => BigInt(Math.floor(shares * 1e6)) * 10n ** 12n;

export async function runTradingCycle(client: DelphiClient, now = Date.now()) {
  const [policy, assessments, book] = await Promise.all([
    loadPolicy(),
    loadAssessments(),
    readBook(client),
  ]);
  const ledger = new TradeLedger(resolve(stateDirectory(), "trade-ledger.json"));
  const pending = await ledger.pending();
  if (pending) throw new Error(`unresolved trade intent ${pending.decisionId}; automatic writes blocked`);
  const candidates = selectCandidates({ now, policy, markets: book.markets, positions: book.positions, assessments });
  if (candidates.length === 0) return { status: "NO_TRADE" as const, reason: "no fresh evidence-backed edge" };

  const mode = await assertWriteReadiness({ now, policy, book });
  for (const candidate of candidates) {
    const budgetTst = orderBudget({
      policy,
      totalEquityTst: book.totalEquityTst,
      availableTst: book.availableTst,
      deployedValueTst: book.deployedValueTst,
      existingMarketValueTst: candidate.existingMarketValue,
      mode,
    });
    const plan = await findQuotedPlan({ client, candidate, policy, budgetTst, mode });
    if (plan) {
        if (await ledger.get(plan.decisionId)) return { status: "DEDUPLICATED" as const, decisionId: plan.decisionId };
        await ledger.prepare({
          decisionId: plan.decisionId,
          marketId: plan.market.id,
          outcomeIndex: plan.assessment.outcomeIndex,
          shares: plan.shares,
          quotedCostTst: plan.quotedCostTst,
          createdAt: now,
        });
        const maximumCost = BigInt(Math.ceil(plan.maximumCostTst * 1e6));
        await client.ensureTokenApproval({
          marketAddress: plan.market.id,
          minimumAmount: maximumCost,
          approveAmount: maximumCost,
        });
        const result = await client.buyShares({
          marketAddress: plan.market.id,
          outcomeIdx: plan.assessment.outcomeIndex,
          sharesOut: sharesToRaw(plan.shares),
          maxTokensIn: maximumCost,
        });
        await ledger.confirm(plan.decisionId, result.transactionHash);
        if (mode === "canary") {
          await mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
          await writeFile(resolve(stateDirectory(), "canary-complete.json"), `${JSON.stringify({
            decisionId: plan.decisionId,
            transactionHash: result.transactionHash,
            completedAt: Date.now(),
          }, null, 2)}\n`, { mode: 0o600 });
        }
        await sendAlert("POSITION OPENED", `${plan.market.question}\n${plan.market.outcomes[plan.assessment.outcomeIndex]} | ${plan.shares} shares | ${plan.quotedCostTst.toFixed(4)} TST | net edge ${(plan.netEdge * 100).toFixed(2)}%\n${result.transactionHash}`);
        return { status: "TRADED" as const, plan, transactionHash: result.transactionHash };
    }
  }
  return { status: "NO_TRADE" as const, reason: "all quotes failed edge, impact, or allocation limits" };
}
