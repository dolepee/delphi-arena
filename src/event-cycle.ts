import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import type { Assessment, Candidate, Policy, QuotedPlan } from "./model.js";
import type { Book } from "./runtime.js";
import { TradeLedger } from "./ledger.js";
import { ExitLedger } from "./exit-ledger.js";
import { resolve } from "node:path";
import { stateDirectory } from "./config.js";
import {
  isAssessmentAllowedByOpportunity,
  type OpportunityDefinition,
} from "./opportunity-policy.js";

export interface EventCycleDependencies {
  client: DelphiClient;
  now: () => number;
  readBook: (client: DelphiClient) => Promise<Book>;
  generateOfficialAssessments: (markets: Book["markets"], now: number) => Promise<Assessment[]>;
  selectEventAssessments: (assessments: Assessment[]) => Assessment[];
  loadOpportunityDefinitions: () => Promise<OpportunityDefinition[]>;
  executionEnabled: () => boolean;
  assertNoPendingIntents: () => Promise<void>;
  loadPolicy: () => Promise<Policy>;
  selectCandidates: (input: {
    now: number;
    policy: Policy;
    markets: Book["markets"];
    positions: Book["positions"];
    assessments: Assessment[];
    opportunities: OpportunityDefinition[];
  }) => Candidate[];
  quoteCandidates: (input: {
    client: DelphiClient;
    candidates: Candidate[];
    policy: Policy;
    book: Book;
    mode: "full";
  }) => Promise<{ plans: QuotedPlan[]; quoteFailures: string[] }>;
  preflightTournamentPlans: (input: {
    plans: QuotedPlan[];
    policy: Policy;
  }) => Promise<{ plans: QuotedPlan[]; failures: string[] }>;
  saveAssessments: (assessments: Assessment[]) => Promise<void>;
  managePositions: (client: DelphiClient, now: number, options?: { allowStaleProfitTake?: boolean }) => Promise<unknown>;
  trade: (client: DelphiClient, now: number) => Promise<unknown>;
}

export async function assertNoPendingEventIntents(): Promise<void> {
  const exitLedger = new ExitLedger(resolve(stateDirectory(), "exit-ledger.json"));
  const tradeLedger = new TradeLedger(resolve(stateDirectory(), "trade-ledger.json"));
  const [pendingExit, pendingTrade] = await Promise.all([
    exitLedger.pending(),
    tradeLedger.pending(),
  ]);
  if (pendingExit) {
    throw new Error(`unresolved exit intent ${pendingExit.decisionId}; event writes blocked`);
  }
  if (pendingTrade) {
    throw new Error(`unresolved trade intent ${pendingTrade.decisionId}; event writes blocked`);
  }
}

function timestamp(value: number): string {
  return new Date(value).toISOString();
}

export async function runEventCycle(dependencies: EventCycleDependencies): Promise<Record<string, unknown>> {
  const startedAt = dependencies.now();
  const [sourceBook, opportunities] = await Promise.all([
    dependencies.readBook(dependencies.client),
    dependencies.loadOpportunityDefinitions(),
  ]);
  const assessments = dependencies.selectEventAssessments(
    await dependencies.generateOfficialAssessments(sourceBook.markets, startedAt),
  ).filter((assessment) =>
    isAssessmentAllowedByOpportunity(assessment, opportunities)
  );
  if (assessments.length === 0) {
    const completedAt = dependencies.now();
    return {
      status: "NO_EVENT",
      startedAt: timestamp(startedAt),
      completedAt: timestamp(completedAt),
      latencyMs: { total: completedAt - startedAt },
    };
  }
  if (!dependencies.executionEnabled()) {
    const completedAt = dependencies.now();
    return {
      status: "EVENT_DETECTED_DRY_RUN",
      startedAt: timestamp(startedAt),
      completedAt: timestamp(completedAt),
      latencyMs: { total: completedAt - startedAt },
      assessments: assessments.map((assessment) => ({
        marketId: assessment.marketId,
        outcomeIndex: assessment.outcomeIndex,
        evidenceClass: assessment.evidenceClass,
        observedAt: assessment.observedAt,
        expiresAt: assessment.expiresAt,
      })),
    };
  }

  await dependencies.assertNoPendingIntents();
  const policy = await dependencies.loadPolicy();
  // Source retrieval can take long enough for a market to close or the book to
  // move. Re-read before any exit projection or executable quote.
  const book = await dependencies.readBook(dependencies.client);
  const quoteNow = dependencies.now();
  const activeAssessments = assessments.filter((assessment) => {
    const market = book.markets.find((candidate) =>
      candidate.id.toLowerCase() === assessment.marketId.toLowerCase()
    );
    return market?.status === "open" &&
      market.outcomes[assessment.outcomeIndex] !== undefined &&
      market.prices[assessment.outcomeIndex] !== undefined &&
      (!market.resolvesAt || quoteNow < Date.parse(market.resolvesAt));
  });
  if (activeAssessments.length === 0) {
    const completedAt = dependencies.now();
    return {
      status: "EVENT_STALE_BEFORE_QUOTE",
      startedAt: timestamp(startedAt),
      completedAt: timestamp(completedAt),
      latencyMs: { total: completedAt - startedAt },
    };
  }
  const exactOutcomes = new Map(activeAssessments.map((assessment) => [
    assessment.marketId.toLowerCase(),
    assessment.outcomeIndex,
  ]));
  const opposingPositions = book.positions.filter((position) => {
    const outcomeIndex = exactOutcomes.get(position.marketId.toLowerCase());
    return outcomeIndex !== undefined && outcomeIndex !== position.outcomeIndex;
  });
  let projectedAvailableTst = book.availableTst;
  let projectedDeployedValueTst = book.deployedValueTst;
  for (const position of opposingPositions) {
    const market = book.markets.find((candidate) =>
      candidate.id.toLowerCase() === position.marketId.toLowerCase()
    );
    if (!market || market.status !== "open") continue;
    const sharesIn = BigInt(Math.floor(position.shares * 1e6)) * 10n ** 12n;
    const quote = await dependencies.client.quoteSell({
      marketAddress: market.id,
      outcomeIdx: position.outcomeIndex,
      sharesIn,
    });
    const minimumProceedsAtomic = quote.tokensOut *
      BigInt(Math.floor((100 - (policy.exitSlippagePct ?? policy.slippagePct)) * 100)) /
      10_000n;
    projectedAvailableTst += Number(minimumProceedsAtomic) / 1e6;
    projectedDeployedValueTst = Math.max(
      0,
      projectedDeployedValueTst - position.shares * position.markPrice,
    );
  }
  const projectedBook: Book = {
    ...book,
    availableTst: projectedAvailableTst,
    deployedValueTst: projectedDeployedValueTst,
    positions: book.positions.filter((position) => !opposingPositions.includes(position)),
  };
  const candidates = dependencies.selectCandidates({
    now: quoteNow,
    policy,
    markets: book.markets,
    positions: projectedBook.positions,
    assessments: activeAssessments,
    opportunities,
  });
  const capacity = await dependencies.quoteCandidates({
    client: dependencies.client,
    candidates,
    policy,
    book: projectedBook,
    mode: "full",
  });
  if (opposingPositions.length > 0) {
    // Exact contrary evidence justifies closing the losing side, but the
    // tournament entry waits for the next cycle so its book and official PnL
    // can reconcile flat before sizing.
    await dependencies.saveAssessments(activeAssessments);
    const management = await dependencies.managePositions(
      dependencies.client,
      dependencies.now(),
      { allowStaleProfitTake: true },
    );
    const completedAt = dependencies.now();
    return {
      status: "EVENT_POSITION_EXIT_ONLY",
      startedAt: timestamp(startedAt),
      completedAt: timestamp(completedAt),
      latencyMs: { total: completedAt - startedAt },
      quoteFailures: capacity.quoteFailures,
      management,
    };
  }
  if (capacity.plans.length === 0) {
    const completedAt = dependencies.now();
    return {
      status: "EVENT_WITHOUT_EXECUTABLE_EDGE",
      startedAt: timestamp(startedAt),
      completedAt: timestamp(completedAt),
      latencyMs: { total: completedAt - startedAt },
      quoteFailures: capacity.quoteFailures,
    };
  }

  const guarded = await dependencies.preflightTournamentPlans({
    plans: capacity.plans,
    policy,
  });
  if (guarded.plans.length === 0) {
    const completedAt = dependencies.now();
    return {
      status: "EVENT_BLOCKED_BY_TOURNAMENT_GUARD",
      startedAt: timestamp(startedAt),
      completedAt: timestamp(completedAt),
      latencyMs: { total: completedAt - startedAt },
      quoteFailures: [...capacity.quoteFailures, ...guarded.failures],
    };
  }

  const allowedOutcomes = new Set(guarded.plans.map((plan) =>
    `${plan.market.id.toLowerCase()}:${plan.assessment.outcomeIndex}`
  ));
  const guardedAssessments = activeAssessments.filter((assessment) =>
    allowedOutcomes.has(`${assessment.marketId.toLowerCase()}:${assessment.outcomeIndex}`)
  );
  await dependencies.saveAssessments(guardedAssessments);
  const assessedAt = dependencies.now();
  const management = { status: "NO_EXIT" as const, reason: "flat tournament book" };
  const managedAt = dependencies.now();
  const trading = await dependencies.trade(dependencies.client, managedAt);
  const completedAt = dependencies.now();

  return {
    status: "EVENT_CYCLE_COMPLETE",
    startedAt: timestamp(startedAt),
    assessedAt: timestamp(assessedAt),
    managedAt: timestamp(managedAt),
    completedAt: timestamp(completedAt),
    latencyMs: {
      assessment: assessedAt - startedAt,
      management: managedAt - assessedAt,
      trading: completedAt - managedAt,
      total: completedAt - startedAt,
    },
    assessments: activeAssessments.map((assessment) => ({
      marketId: assessment.marketId,
      outcomeIndex: assessment.outcomeIndex,
      evidenceClass: assessment.evidenceClass,
      observedAt: assessment.observedAt,
      expiresAt: assessment.expiresAt,
    })),
    management,
    trading,
  };
}
