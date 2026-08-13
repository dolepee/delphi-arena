import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import type { Candidate, Policy, QuotedPlan } from "./model.js";
import { validateQuote } from "./planner.js";

const sharesToRaw = (shares: number) => BigInt(Math.floor(shares * 1e6)) * 10n ** 12n;
const cents = (value: number) => Math.floor(value * 100) / 100;

export async function findQuotedPlan(input: {
  client: Pick<DelphiClient, "quoteBuy">;
  candidate: Candidate;
  policy: Policy;
  budgetTst: number;
  mode: "canary" | "full";
  totalEquityTst: number;
}): Promise<QuotedPlan | null> {
  if (input.budgetTst <= 0) return null;
  let low = 0;
  let high = cents(input.budgetTst / Math.max(input.candidate.spotPrice, 0.01));
  let best: QuotedPlan | null = null;
  const quoted = new Set<number>();
  for (let attempt = 0; attempt < 22 && high >= 0.01; attempt += 1) {
    const shares = cents((low + high) / 2);
    if (shares < 0.01 || quoted.has(shares)) break;
    quoted.add(shares);
    const { tokensIn } = await input.client.quoteBuy({
      marketAddress: input.candidate.market.id,
      outcomeIdx: input.candidate.assessment.outcomeIndex,
      sharesOut: sharesToRaw(shares),
    });
    const plan = validateQuote({
      candidate: input.candidate,
      policy: input.policy,
      shares,
      quotedCostTst: Number(tokensIn) / 1e6,
      budgetTst: input.budgetTst,
      mode: input.mode,
      totalEquityTst: input.totalEquityTst,
    });
    if (plan) {
      best = plan;
      low = shares + 0.01;
    } else {
      high = shares - 0.01;
    }
  }
  return best;
}
