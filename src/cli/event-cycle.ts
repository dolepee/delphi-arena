import { saveAssessments, selectEventAssessments } from "../assessments.js";
import { eventExecutionEnabled, loadOpportunityDefinitions, loadPolicy } from "../config.js";
import { client, assertSignerIdentity } from "../delphi.js";
import { preflightTournamentPlans, quoteCandidates, runTradingCycle } from "../engine.js";
import { generateOfficialAssessments } from "../official-assessors.js";
import { selectCandidates } from "../planner.js";
import { runPositionManagementCycle } from "../position-manager.js";
import { readBook } from "../runtime.js";
import { assertNoPendingEventIntents, runEventCycle } from "../event-cycle.js";

await assertSignerIdentity();
const result = await runEventCycle({
  client,
  now: Date.now,
  readBook,
  generateOfficialAssessments,
  selectEventAssessments,
  loadOpportunityDefinitions,
  executionEnabled: eventExecutionEnabled,
  assertNoPendingIntents: assertNoPendingEventIntents,
  loadPolicy,
  selectCandidates,
  quoteCandidates,
  preflightTournamentPlans: ({ plans, policy }) => preflightTournamentPlans({
    client,
    plans,
    policy,
  }),
  saveAssessments,
  managePositions: runPositionManagementCycle,
  trade: runTradingCycle,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
