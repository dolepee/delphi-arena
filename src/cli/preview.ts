import { client, assertSignerIdentity } from "../delphi.js";
import { loadAssessments, loadPolicy } from "../config.js";
import { orderBudget, selectCandidates } from "../planner.js";
import { findQuotedPlan } from "../quote-plan.js";
import { readBook } from "../runtime.js";

await assertSignerIdentity();
const [policy, assessments, book] = await Promise.all([loadPolicy(), loadAssessments(), readBook(client)]);
const candidates = selectCandidates({ now: Date.now(), policy, markets: book.markets, positions: book.positions, assessments });
const previews: unknown[] = [];
for (const candidate of candidates) {
  for (const mode of ["canary", "full"] as const) {
    const assumedEquity = Math.max(book.totalEquityTst, policy.minimumStartingTst);
    const assumedAvailable = Math.max(book.availableTst, policy.minimumStartingTst);
    const budgetTst = orderBudget({
      policy,
      totalEquityTst: assumedEquity,
      availableTst: assumedAvailable,
      deployedValueTst: book.deployedValueTst,
      existingMarketValueTst: candidate.existingMarketValue,
      mode,
    });
    const accepted = await findQuotedPlan({ client, candidate, policy, budgetTst, mode });
    previews.push(accepted ? {
      mode,
      marketId: accepted.market.id,
      outcome: accepted.market.outcomes[accepted.assessment.outcomeIndex],
      shares: accepted.shares,
      quotedCostTst: accepted.quotedCostTst,
      maximumCostTst: accepted.maximumCostTst,
      averagePrice: accepted.averagePrice,
      netEdge: accepted.netEdge,
      priceImpact: accepted.priceImpact,
    } : { mode, marketId: candidate.market.id, accepted: false });
  }
}
process.stdout.write(`${JSON.stringify({ status: "QUOTE_ONLY_PREVIEW", writesAttempted: false, previews }, null, 2)}\n`);
