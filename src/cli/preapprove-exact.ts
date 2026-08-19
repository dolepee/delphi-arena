import { loadOpportunityDefinitions, loadPolicy } from "../config.js";
import { client, assertSignerIdentity } from "../delphi.js";
import { tournamentPreapprovalMarketIds } from "../preapproval.js";
import { assertMaintenanceReadiness, readBook } from "../runtime.js";
import { tournamentSettings } from "../tournament-guard.js";

await assertSignerIdentity();
const [policy, opportunities, book] = await Promise.all([
  loadPolicy(),
  loadOpportunityDefinitions(),
  readBook(client),
]);
await assertMaintenanceReadiness(book);
const tournament = tournamentSettings(policy);
if (!tournament) throw new Error("tournament exact-result policy is missing or invalid");
const amount = BigInt(Math.floor(tournament.orderCapTst * 1e6));
const results = [];
for (const marketAddress of tournamentPreapprovalMarketIds({
  markets: book.markets,
  opportunities,
})) {
  const approval = await client.ensureTokenApproval({
    marketAddress,
    minimumAmount: amount,
    approveAmount: amount,
  });
  results.push({
    marketAddress,
    approvalNeeded: approval.approvalNeeded,
    allowanceAtomic: approval.allowance.toString(),
    transactionHash: approval.transactionHash ?? null,
  });
}
process.stdout.write(`${JSON.stringify({
  status: "TOURNAMENT_EXACT_PREAPPROVAL_COMPLETE",
  amountAtomic: amount.toString(),
  results,
}, null, 2)}\n`);
