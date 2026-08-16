import { saveAssessments, selectEventAssessments } from "../assessments.js";
import { eventExecutionEnabled, loadPolicy } from "../config.js";
import { client, assertSignerIdentity } from "../delphi.js";
import { quoteCandidates, runTradingCycle } from "../engine.js";
import { generateOfficialAssessments } from "../official-assessors.js";
import { selectCandidates } from "../planner.js";
import { runPositionManagementCycle } from "../position-manager.js";
import { readBook } from "../runtime.js";

await assertSignerIdentity();
const startedAt = Date.now();
const book = await readBook(client);
const assessments = selectEventAssessments(
  await generateOfficialAssessments(book.markets, startedAt),
);
if (assessments.length === 0) {
  const completedAt = Date.now();
  process.stdout.write(`${JSON.stringify({
    status: "NO_EVENT",
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    latencyMs: { total: completedAt - startedAt },
  }, null, 2)}\n`);
  process.exit(0);
}
if (!eventExecutionEnabled()) {
  const completedAt = Date.now();
  process.stdout.write(`${JSON.stringify({
    status: "EVENT_DETECTED_DRY_RUN",
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    latencyMs: { total: completedAt - startedAt },
    assessments: assessments.map((assessment) => ({
      marketId: assessment.marketId,
      outcomeIndex: assessment.outcomeIndex,
      evidenceClass: assessment.evidenceClass,
      observedAt: assessment.observedAt,
      expiresAt: assessment.expiresAt,
    })),
  }, null, 2)}\n`);
  process.exit(0);
}
const policy = await loadPolicy();
const exactOutcomes = new Map(assessments.map((assessment) => [
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
  const quote = await client.quoteSell({
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
const projectedBook = {
  ...book,
  availableTst: projectedAvailableTst,
  deployedValueTst: projectedDeployedValueTst,
  positions: book.positions.filter((position) => !opposingPositions.includes(position)),
};
const candidates = selectCandidates({
  now: Date.now(),
  policy,
  markets: book.markets,
  positions: projectedBook.positions,
  assessments,
});
const capacity = await quoteCandidates({
  client,
  candidates,
  policy,
  book: projectedBook,
  mode: "full",
});
if (capacity.plans.length === 0) {
  await saveAssessments(assessments);
  const management = opposingPositions.length > 0
    ? await runPositionManagementCycle(client, Date.now())
    : { status: "NO_EXIT" as const, reason: "no opposing exact-result position" };
  const completedAt = Date.now();
  process.stdout.write(`${JSON.stringify({
    status: "EVENT_WITHOUT_EXECUTABLE_EDGE",
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    latencyMs: { total: completedAt - startedAt },
    quoteFailures: capacity.quoteFailures,
    management,
  }, null, 2)}\n`);
  process.exit(0);
}
await saveAssessments(assessments);
const assessedAt = Date.now();
const management = await runPositionManagementCycle(client, assessedAt, { allowStaleProfitTake: true });
const managedAt = Date.now();
const trading = await runTradingCycle(client, managedAt);
const completedAt = Date.now();

process.stdout.write(`${JSON.stringify({
  status: "EVENT_CYCLE_COMPLETE",
  startedAt: new Date(startedAt).toISOString(),
  assessedAt: new Date(assessedAt).toISOString(),
  managedAt: new Date(managedAt).toISOString(),
  completedAt: new Date(completedAt).toISOString(),
  latencyMs: {
    assessment: assessedAt - startedAt,
    management: managedAt - assessedAt,
    trading: completedAt - managedAt,
    total: completedAt - startedAt,
  },
  assessments: assessments.map((assessment) => ({
    marketId: assessment.marketId,
    outcomeIndex: assessment.outcomeIndex,
    evidenceClass: assessment.evidenceClass,
    observedAt: assessment.observedAt,
    expiresAt: assessment.expiresAt,
  })),
  management,
  trading,
}, null, 2)}\n`);
