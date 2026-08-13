import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadAssessments, loadPolicy, stateDirectory } from "./config.js";
import { TradeLedger } from "./ledger.js";
import { orderBudget, rankQuotedPlans, selectCandidates } from "./planner.js";
import { findQuotedPlan } from "./quote-plan.js";
import { assertWriteReadiness, readBook } from "./runtime.js";
import { sendAlert } from "./alerts.js";

const sharesToRaw = (shares: number) => BigInt(Math.floor(shares * 1e6)) * 10n ** 12n;

export function isPlanExecutableAt(
  plan: { assessment: { expiresAt: string } },
  competitionEndsAt: string,
  now: number,
): boolean {
  return now < Date.parse(plan.assessment.expiresAt) && now < Date.parse(competitionEndsAt);
}

export async function quoteCandidates(input: {
  client: Pick<DelphiClient, "quoteBuy">;
  candidates: ReturnType<typeof selectCandidates>;
  policy: Awaited<ReturnType<typeof loadPolicy>>;
  book: Awaited<ReturnType<typeof readBook>>;
  mode: "canary" | "full";
}) {
  const quotedPlans = [];
  const quoteFailures: string[] = [];
  for (const candidate of input.candidates) {
    const budgetTst = orderBudget({
      policy: input.policy,
      assessment: candidate.assessment,
      totalEquityTst: input.book.totalEquityTst,
      availableTst: input.book.availableTst,
      deployedValueTst: input.book.deployedValueTst,
      existingMarketValueTst: candidate.existingMarketValue,
      mode: input.mode,
    });
    try {
      const plan = await findQuotedPlan({
        client: input.client,
        candidate,
        policy: input.policy,
        budgetTst,
        mode: input.mode,
      });
      if (plan) quotedPlans.push(plan);
    } catch (error) {
      quoteFailures.push(`${candidate.market.id}:${String(error)}`);
    }
  }
  return { plans: rankQuotedPlans(quotedPlans), quoteFailures };
}

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
  const { plans: quotedPlans, quoteFailures } = await quoteCandidates({ client, candidates, policy, book, mode });
  for (const plan of quotedPlans) {
        const executionNow = Date.now();
        if (!isPlanExecutableAt(plan, policy.competitionEndsAt, executionNow)) continue;
        if (await ledger.get(plan.decisionId)) continue;
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
  return {
    status: "NO_TRADE" as const,
    reason: quotedPlans.length > 0
      ? "all valid quotes were already executed"
      : "all quotes failed edge, impact, or allocation limits",
    quoteFailures,
  };
}
