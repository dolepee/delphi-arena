import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EXPECTED_WALLET, loadAssessmentContext, loadPolicy, stateDirectory } from "./config.js";
import { TradeLedger, type TradeRecord } from "./ledger.js";
import { isDeterministicPublishedResult, maximumAdditionalShares, maximumPriceImpact, orderBudget, rankQuotedPlans, selectCandidates } from "./planner.js";
import { findQuotedPlan } from "./quote-plan.js";
import { assertWriteReadiness, readBook, type Book } from "./runtime.js";
import { sendAlert } from "./alerts.js";
import { assessmentEvidenceFingerprint, blocksEntryForAssessment, ExitLedger } from "./exit-ledger.js";
import {
  loadFreshPodiumSnapshot,
  type PodiumSnapshot,
} from "./podium-monitor.js";
import {
  guardTournamentExactResult,
  tournamentSettings,
  type TournamentGuardDecision,
} from "./tournament-guard.js";

const sharesToRaw = (shares: number) => BigInt(Math.floor(shares * 1e6)) * 10n ** 12n;

export function hasConfirmedExactResultExecution(input: {
  records: TradeRecord[];
  marketId: string;
  outcomeIndex: number;
}): boolean {
  return input.records.some((record) =>
    record.status === "CONFIRMED" &&
    record.assessmentEvidenceClass === "published_result" &&
    record.marketId.toLowerCase() === input.marketId.toLowerCase() &&
    record.outcomeIndex === input.outcomeIndex
  );
}

export type TournamentPreflightResult = TournamentGuardDecision & {
  freshQuotedCostTst?: number;
};

export async function preflightTournamentExactPlan(input: {
  client: Pick<DelphiClient, "quoteBuy">;
  plan: ReturnType<typeof rankQuotedPlans>[number];
  policy: Awaited<ReturnType<typeof loadPolicy>>;
  book: Book;
  now?: () => number;
  loadPodium?: (now: number, maximumAgeMs: number) => Promise<PodiumSnapshot>;
}): Promise<TournamentPreflightResult> {
  const tournament = tournamentSettings(input.policy);
  if (!tournament) return { allowed: false, reason: "tournament_policy_missing_or_invalid" };
  const freshMarket = input.book.markets.find((market) =>
    market.id.toLowerCase() === input.plan.market.id.toLowerCase()
  );
  const freshSpot = freshMarket?.prices[input.plan.assessment.outcomeIndex];
  if (freshMarket?.status !== "open" || freshSpot === undefined) {
    return { allowed: false, reason: "quote_missing_or_invalid" };
  }
  const currentQuote = await input.client.quoteBuy({
    marketAddress: input.plan.market.id,
    outcomeIdx: input.plan.assessment.outcomeIndex,
    sharesOut: sharesToRaw(input.plan.shares),
  });
  const quotedAt = (input.now ?? Date.now)();
  if (currentQuote.tokensIn > input.plan.maximumCostAtomic) {
    return {
      allowed: false,
      reason: "fresh_quote_exceeds_original_ceiling",
      freshQuotedCostTst: Number(currentQuote.tokensIn) / 1e6,
    };
  }
  const snapshot = await (input.loadPodium ?? (async (now, maximumAgeMs) =>
    loadFreshPodiumSnapshot(
      resolve(stateDirectory(), "podium", "latest.json"),
      now,
      maximumAgeMs,
      EXPECTED_WALLET,
    )))(quotedAt, tournament.leaderboardAgeMs);
  const decision = guardTournamentExactResult({
    policy: input.policy,
    now: quotedAt,
    book: {
      totalEquityTst: input.book.totalEquityTst,
      availableTst: input.book.availableTst,
      deployedValueTst: input.book.deployedValueTst,
      positionCount: input.book.positions.length,
    },
    leaderboard: {
      observedAt: snapshot.observedAt,
      initialTst: input.policy.minimumStartingTst,
      liveThirdPlacePnlTst: snapshot.third.pnl,
      convictionPnlTst: snapshot.conviction.pnl,
      convictionCashTst: snapshot.conviction.cash,
    },
    quote: {
      observedAt: new Date(quotedAt).toISOString(),
      decisionId: input.plan.decisionId,
      marketId: input.plan.market.id,
      outcomeIndex: input.plan.assessment.outcomeIndex,
      shares: input.plan.shares,
      maximumCostTst: input.plan.maximumCostTst,
      priceImpact: input.plan.maximumAveragePrice - freshSpot,
      assessment: input.plan.assessment,
    },
  });
  return {
    ...decision,
    freshQuotedCostTst: Number(currentQuote.tokensIn) / 1e6,
  };
}

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
  const tournament = resultLane ? tournamentSettings(input.policy) : null;
  const marketPct = tournament?.allocationPct ?? (resultLane
    ? input.policy.maximumPublishedResultMarketAllocationPct
    : input.policy.maximumMarketAllocationPct);
  const portfolioPct = tournament?.allocationPct ?? (resultLane
    ? input.policy.maximumPublishedResultPortfolioAllocationPct
    : input.policy.maximumPortfolioAllocationPct);
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

export async function preflightTournamentPlans(input: {
  client: DelphiClient;
  plans: ReturnType<typeof rankQuotedPlans>;
  policy: Awaited<ReturnType<typeof loadPolicy>>;
}): Promise<{
  plans: ReturnType<typeof rankQuotedPlans>;
  failures: string[];
}> {
  const book = await readBook(input.client);
  const plans: ReturnType<typeof rankQuotedPlans> = [];
  const failures: string[] = [];
  for (const plan of input.plans) {
    if (plan.mode !== "full" || !isDeterministicPublishedResult(plan.assessment)) {
      failures.push(`${plan.market.id}:not_tournament_exact`);
      continue;
    }
    try {
      const preflight = await preflightTournamentExactPlan({
        client: input.client,
        plan,
        policy: input.policy,
        book,
      });
      if (preflight.allowed) plans.push(plan);
      else failures.push(`${plan.market.id}:${preflight.reason}`);
    } catch (error) {
      failures.push(`${plan.market.id}:${String(error)}`);
    }
  }
  return { plans, failures };
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

type ExecutionLedger = Pick<
  TradeLedger,
  "get" | "prepare" | "discardPrepared" | "confirm"
>;

export type QuotedPlanExecutionResult = {
  status: "SKIPPED";
  reason: string;
} | {
  status: "TRADED";
  transactionHash: string;
};

export async function executeQuotedPlan(input: {
  client: Pick<DelphiClient, "ensureTokenApproval" | "buyShares">;
  plan: ReturnType<typeof rankQuotedPlans>[number];
  policy: Awaited<ReturnType<typeof loadPolicy>>;
  ledger: ExecutionLedger;
  now?: () => number;
  readBook: () => Promise<Book>;
  preflightTournament: (book: Book) => Promise<TournamentPreflightResult>;
}): Promise<QuotedPlanExecutionResult> {
  const now = input.now ?? Date.now;
  if (!isPlanExecutableAt(
    input.plan,
    input.policy.competitionEndsAt,
    input.policy.maximumAssessmentAgeMinutes,
    now(),
  )) return { status: "SKIPPED", reason: "plan_not_executable" };
  if (await input.ledger.get(input.plan.decisionId)) {
    return { status: "SKIPPED", reason: "decision_already_recorded" };
  }

  const tournamentExact = input.plan.mode === "full" &&
    isDeterministicPublishedResult(input.plan.assessment);
  const freshBook = await input.readBook();
  if (!isPlanWithinBookLimits({ plan: input.plan, policy: input.policy, book: freshBook })) {
    return { status: "SKIPPED", reason: "fresh_book_limits" };
  }
  if (tournamentExact) {
    try {
      const preflight = await input.preflightTournament(freshBook);
      if (!preflight.allowed) {
        return { status: "SKIPPED", reason: `tournament_preflight:${preflight.reason}` };
      }
    } catch (error) {
      return { status: "SKIPPED", reason: `tournament_preflight:${String(error)}` };
    }
  }

  const maximumCost = input.plan.maximumCostAtomic;
  await input.ledger.prepare({
    decisionId: input.plan.decisionId,
    marketId: input.plan.market.id,
    outcomeIndex: input.plan.assessment.outcomeIndex,
    shares: input.plan.shares,
    quotedCostTst: input.plan.quotedCostTst,
    maximumCostTst: input.plan.maximumCostTst,
    assessmentFingerprint: assessmentEvidenceFingerprint(input.plan.assessment),
    assessmentProbability: input.plan.assessment.probability,
    assessmentEvidenceClass: input.plan.assessment.evidenceClass,
    assessmentObservedAt: input.plan.assessment.observedAt,
    assessmentExpiresAt: input.plan.assessment.expiresAt,
    createdAt: now(),
  });
  // An uncertain approval failure deliberately leaves PREPARED for operator
  // reconciliation. Once approval returns, every later rejection is a
  // definite no-buy path and can safely discard the intent.
  await input.client.ensureTokenApproval({
    marketAddress: input.plan.market.id,
    minimumAmount: maximumCost,
    approveAmount: maximumCost,
  });
  try {
    const postApprovalBook = await input.readBook();
    if (!isPlanWithinBookLimits({
      plan: input.plan,
      policy: input.policy,
      book: postApprovalBook,
    })) {
      await input.ledger.discardPrepared(input.plan.decisionId);
      return { status: "SKIPPED", reason: "post_approval_book_limits" };
    }
    if (!isPlanExecutableAt(
      input.plan,
      input.policy.competitionEndsAt,
      input.policy.maximumAssessmentAgeMinutes,
      now(),
    )) {
      await input.ledger.discardPrepared(input.plan.decisionId);
      return { status: "SKIPPED", reason: "post_approval_plan_not_executable" };
    }
    if (tournamentExact) {
      const finalPreflight = await input.preflightTournament(postApprovalBook);
      if (!finalPreflight.allowed) {
        await input.ledger.discardPrepared(input.plan.decisionId);
        return {
          status: "SKIPPED",
          reason: `post_approval_tournament_preflight:${finalPreflight.reason}`,
        };
      }
    }
    if (!isPlanExecutableAt(
      input.plan,
      input.policy.competitionEndsAt,
      input.policy.maximumAssessmentAgeMinutes,
      now(),
    )) {
      await input.ledger.discardPrepared(input.plan.decisionId);
      return { status: "SKIPPED", reason: "post_preflight_plan_not_executable" };
    }
  } catch (error) {
    await input.ledger.discardPrepared(input.plan.decisionId);
    return { status: "SKIPPED", reason: `post_approval_preflight:${String(error)}` };
  }

  // A submitted buy failure is intentionally not caught: the PREPARED record
  // remains until its chain state is reconciled.
  const result = await input.client.buyShares({
    marketAddress: input.plan.market.id,
    outcomeIdx: input.plan.assessment.outcomeIndex,
    sharesOut: sharesToRaw(input.plan.shares),
    maxTokensIn: maximumCost,
  });
  await input.ledger.confirm(input.plan.decisionId, result.transactionHash);
  return { status: "TRADED", transactionHash: result.transactionHash };
}

export async function runTradingCycle(client: DelphiClient, now = Date.now()) {
  const [policy, assessmentContext, book] = await Promise.all([
    loadPolicy(),
    loadAssessmentContext(),
    readBook(client),
  ]);
  const { assessments, opportunities } = assessmentContext;
  const ledger = new TradeLedger(resolve(stateDirectory(), "trade-ledger.json"));
  const exitLedger = new ExitLedger(resolve(stateDirectory(), "exit-ledger.json"));
  const pendingExit = await exitLedger.pending();
  if (pendingExit) throw new Error(`unresolved exit intent ${pendingExit.decisionId}; automatic writes blocked`);
  const pending = await ledger.pending();
  if (pending) throw new Error(`unresolved trade intent ${pending.decisionId}; automatic writes blocked`);
  const [confirmedExits, tradeRecords] = await Promise.all([
    exitLedger.records(),
    ledger.records(),
  ]);
  const candidates = applyExitConstraints({
    candidates: selectCandidates({
      now,
      policy,
      markets: book.markets,
      positions: book.positions,
      assessments,
      opportunities,
    }),
    exits: confirmedExits,
    now,
  }).filter((candidate) =>
    !isDeterministicPublishedResult(candidate.assessment) ||
    !hasConfirmedExactResultExecution({
      records: tradeRecords,
      marketId: candidate.market.id,
      outcomeIndex: candidate.assessment.outcomeIndex,
    })
  );
  if (candidates.length === 0) return { status: "NO_TRADE" as const, reason: "no fresh evidence-backed edge" };

  const mode = await assertWriteReadiness({ now, policy, book });
  const { plans: quotedPlans, quoteFailures } = await quoteCandidates({ client, candidates, policy, book, mode });
  for (const plan of quotedPlans) {
    const execution = await executeQuotedPlan({
      client,
      plan,
      policy,
      ledger,
      readBook: () => readBook(client),
      preflightTournament: (freshBook) => preflightTournamentExactPlan({
        client,
        plan,
        policy,
        book: freshBook,
      }),
    });
    if (execution.status === "SKIPPED") {
      quoteFailures.push(`${plan.market.id}:${execution.reason}`);
      continue;
    }
    if (mode === "canary") {
      await mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
      await writeFile(resolve(stateDirectory(), "canary-complete.json"), `${JSON.stringify({
        decisionId: plan.decisionId,
        transactionHash: execution.transactionHash,
        completedAt: Date.now(),
      }, null, 2)}\n`, { mode: 0o600 });
    }
    await sendAlert("POSITION OPENED", `${plan.market.question}\n${plan.market.outcomes[plan.assessment.outcomeIndex]} | ${plan.shares} shares | ${plan.quotedCostTst.toFixed(4)} TST | net edge ${(plan.netEdge * 100).toFixed(2)}%\n${execution.transactionHash}`);
    return { status: "TRADED" as const, plan, transactionHash: execution.transactionHash };
  }
  return {
    status: "NO_TRADE" as const,
    reason: quotedPlans.length > 0
      ? "all valid quotes were already executed"
      : "all quotes failed edge, impact, or allocation limits",
    quoteFailures,
  };
}
