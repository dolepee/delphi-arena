import { client, assertSignerIdentity } from "../delphi.js";
import { loadAssessments, loadPolicy, stateDirectory } from "../config.js";
import { maximumAdditionalShares, orderBudget, selectCandidates } from "../planner.js";
import { findQuotedPlan } from "../quote-plan.js";
import { readBook } from "../runtime.js";
import { resolve } from "node:path";
import { ExitLedger } from "../exit-ledger.js";
import { applyExitConstraints } from "../engine.js";

await assertSignerIdentity();
const [policy, assessments, book] = await Promise.all([loadPolicy(), loadAssessments(), readBook(client)]);
const previewNow = Date.now();
const exits = await new ExitLedger(resolve(stateDirectory(), "exit-ledger.json")).records();
const candidates = applyExitConstraints({
  candidates: selectCandidates({ now: previewNow, policy, markets: book.markets, positions: book.positions, assessments }),
  exits,
  now: previewNow,
});
const previews: unknown[] = [];
for (const candidate of candidates) {
  for (const mode of ["canary", "full"] as const) {
    const assumedEquity = Math.max(book.totalEquityTst, policy.minimumStartingTst);
    const assumedAvailable = Math.max(book.availableTst, policy.minimumStartingTst);
    const budgetTst = orderBudget({
      policy,
      assessment: candidate.assessment,
      totalEquityTst: assumedEquity,
      availableTst: assumedAvailable,
      deployedValueTst: book.deployedValueTst,
      existingMarketValueTst: candidate.existingMarketValue,
      mode,
    });
    const accepted = await findQuotedPlan({
      client,
      candidate,
      policy,
      budgetTst,
      mode,
      totalEquityTst: assumedEquity,
      maximumShares: maximumAdditionalShares({
        policy,
        assessment: candidate.assessment,
        totalEquityTst: assumedEquity,
        positions: book.positions,
        marketId: candidate.market.id,
        mode,
      }),
    });
    previews.push(accepted ? {
      mode,
      marketId: accepted.market.id,
      outcome: accepted.market.outcomes[accepted.assessment.outcomeIndex],
      evidenceClass: accepted.assessment.evidenceClass,
      shares: accepted.shares,
      quotedCostTst: accepted.quotedCostTst,
      maximumCostTst: accepted.maximumCostTst,
      averagePrice: accepted.averagePrice,
      maximumAveragePrice: accepted.maximumAveragePrice,
      netEdge: accepted.netEdge,
      priceImpact: accepted.priceImpact,
      worstCaseExpectedProfitTst: accepted.worstCaseExpectedProfitTst,
    } : { mode, marketId: candidate.market.id, accepted: false });
  }
}
process.stdout.write(`${JSON.stringify({ status: "QUOTE_ONLY_PREVIEW", writesAttempted: false, previews }, null, 2)}\n`);
