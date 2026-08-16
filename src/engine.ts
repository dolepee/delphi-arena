import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadAssessments, loadPolicy, stateDirectory } from "./config.js";
import { TradeLedger } from "./ledger.js";
import { isDeterministicPublishedResult, maximumAdditionalShares, maximumPriceImpact, orderBudget, rankQuotedPlans, selectCandidates } from "./planner.js";
import { findQuotedPlan } from "./quote-plan.js";
import { assertWriteReadiness, readBook } from "./runtime.js";
import { sendAlert } from "./alerts.js";
import { assessmentEvidenceFingerprint, blocksEntryForAssessment, ExitLedger } from "./exit-ledger.js";

const sharesToRaw = (shares: number) => BigInt(Math.floor(shares * 1e6)) * 10n ** 12n;

export function isPlanExecutableAt(
  plan: {
    assessment: { observedAt: string; expiresAt: string };
    market: { resolvesAt?: string | null };
  },
  competitionEndsAt: string,
  maximumAssessmentAgeMinutes: number,
  now: number,
): boolean {
  return now < Date.parse(plan.assessment.expiresAt) &&
    now - Date.parse(plan.assessment.observedAt) <= maximumAssessmentAgeMinutes * 60_000 &&
    (!plan.market.resolvesAt || now < Date.parse(plan.market.resolvesAt)) &&
    now < Date.parse(competitionEndsAt);
}

export function isPlanWithinBookLimits(input: {
  plan: ReturnType<typeof rankQuotedPlans>[number];
  policy: Awaited<ReturnType<typeof loadPolicy>>;
  book: Awaited<ReturnType<typeof readBook>>;
}): boolean {
  const resultLane = input.plan.mode === "full" &&
    isDeterministicPublishedResult(input.plan.assessment);
  const marketPct = resultLane
    ? input.policy.maximumPublishedResultMarketAllocationPct
    : input.policy.maximumMarketAllocationPct;
  const portfolioPct = resultLane
    ? input.policy.maximumPublishedResultPortfolioAllocationPct
    : input.policy.maximumPortfolioAllocationPct;
  const sameOutcomeShares = input.book.positions
    .filter((position) =>
      position.marketId.toLowerCase() === input.plan.market.id.toLowerCase() &&
      position.outcomeIndex === input.plan.assessment.outcomeIndex
    )
    .reduce((total, position) => total + position.shares, 0);
  const opposingPosition = input.book.positions.some((position) =>
    position.marketId.toLowerCase() === input.plan.market.id.toLowerCase() &&
    position.outcomeIndex !== input.plan.assessment.outcomeIndex
  );
  const portfolioShares = input.book.positions.reduce(
    (total, position) => total + position.shares,
    0,
  );
  const sameOutcomeValue = input.book.positions
    .filter((position) =>
      position.marketId.toLowerCase() === input.plan.market.id.toLowerCase() &&
      position.outcomeIndex === input.plan.assessment.outcomeIndex
    )
    .reduce((total, position) => total + position.shares * position.markPrice, 0);
  const freshMarket = input.book.markets.find((market) =>
    market.id.toLowerCase() === input.plan.market.id.toLowerCase()
  );
  const freshSpot = freshMarket?.prices[input.plan.assessment.outcomeIndex];
  const allocationWithinLimits = resultLane
    ? sameOutcomeValue + input.plan.maximumCostTst <= input.book.totalEquityTst * marketPct / 100 &&
      input.book.deployedValueTst + input.plan.maximumCostTst <= input.book.totalEquityTst * portfolioPct / 100
    : sameOutcomeShares + input.plan.shares <= input.book.totalEquityTst * marketPct / 100 &&
      portfolioShares + input.plan.shares <= input.book.totalEquityTst * portfolioPct / 100;
  return freshMarket?.status === "open" &&
    freshSpot !== undefined &&
    input.plan.maximumAveragePrice - freshSpot <= maximumPriceImpact(input.plan.assessment, input.policy) &&
    !opposingPosition &&
    input.plan.maximumCostTst <= input.book.availableTst &&
    allocationWithinLimits;
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
        totalEquityTst: input.book.totalEquityTst,
        maximumShares: maximumAdditionalShares({
          policy: input.policy,
          assessment: candidate.assessment,
          totalEquityTst: input.book.totalEquityTst,
          positions: input.book.positions ?? [],
          marketId: candidate.market.id,
          mode: input.mode,
        }),
      });
      if (plan) quotedPlans.push(plan);
    } catch (error) {
      quoteFailures.push(`${candidate.market.id}:${String(error)}`);
    }
  }
  return { plans: rankQuotedPlans(quotedPlans), quoteFailures };
}

export function applyExitConstraints<T extends ReturnType<typeof selectCandidates>[number]>(input: {
  candidates: T[];
  exits: Awaited<ReturnType<ExitLedger["records"]>>;
  now: number;
}): T[] {
  return input.candidates
    .filter((candidate) => !blocksEntryForAssessment(
      input.exits,
      candidate.market.id,
      candidate.assessment.outcomeIndex,
      assessmentEvidenceFingerprint(candidate.assessment),
      input.now,
    ));
}

export async function runTradingCycle(client: DelphiClient, now = Date.now()) {
  const [policy, assessments, book] = await Promise.all([
    loadPolicy(),
    loadAssessments(),
    readBook(client),
  ]);
  const ledger = new TradeLedger(resolve(stateDirectory(), "trade-ledger.json"));
  const exitLedger = new ExitLedger(resolve(stateDirectory(), "exit-ledger.json"));
  const pendingExit = await exitLedger.pending();
  if (pendingExit) throw new Error(`unresolved exit intent ${pendingExit.decisionId}; automatic writes blocked`);
  const pending = await ledger.pending();
  if (pending) throw new Error(`unresolved trade intent ${pending.decisionId}; automatic writes blocked`);
  const confirmedExits = await exitLedger.records();
  const candidates = applyExitConstraints({
    candidates: selectCandidates({ now, policy, markets: book.markets, positions: book.positions, assessments }),
    exits: confirmedExits,
    now,
  });
  if (candidates.length === 0) return { status: "NO_TRADE" as const, reason: "no fresh evidence-backed edge" };

  const mode = await assertWriteReadiness({ now, policy, book });
  const { plans: quotedPlans, quoteFailures } = await quoteCandidates({ client, candidates, policy, book, mode });
  for (const plan of quotedPlans) {
        const executionNow = Date.now();
        if (!isPlanExecutableAt(plan, policy.competitionEndsAt, policy.maximumAssessmentAgeMinutes, executionNow)) continue;
        if (await ledger.get(plan.decisionId)) continue;
        const freshBook = await readBook(client);
        if (!isPlanWithinBookLimits({ plan, policy, book: freshBook })) continue;
        const maximumCost = plan.maximumCostAtomic;
        const preparedAt = Date.now();
        await ledger.prepare({
          decisionId: plan.decisionId,
          marketId: plan.market.id,
          outcomeIndex: plan.assessment.outcomeIndex,
          shares: plan.shares,
          quotedCostTst: plan.quotedCostTst,
          maximumCostTst: plan.maximumCostTst,
          assessmentFingerprint: assessmentEvidenceFingerprint(plan.assessment),
          assessmentProbability: plan.assessment.probability,
          assessmentEvidenceClass: plan.assessment.evidenceClass,
          assessmentObservedAt: plan.assessment.observedAt,
          assessmentExpiresAt: plan.assessment.expiresAt,
          createdAt: preparedAt,
        });
        await client.ensureTokenApproval({
          marketAddress: plan.market.id,
          minimumAmount: maximumCost,
          approveAmount: maximumCost,
        });
        const postApprovalBook = await readBook(client);
        if (!isPlanWithinBookLimits({ plan, policy, book: postApprovalBook })) {
          await ledger.discardPrepared(plan.decisionId);
          continue;
        }
        // Approval can itself wait for a transaction. Since the intent was
        // journaled first, an uncertain approval failure remains fail-closed.
        if (!isPlanExecutableAt(plan, policy.competitionEndsAt, policy.maximumAssessmentAgeMinutes, Date.now())) {
          await ledger.discardPrepared(plan.decisionId);
          continue;
        }
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
