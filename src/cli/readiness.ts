import { resolve } from "node:path";
import { client, assertSignerIdentity } from "../delphi.js";
import { loadAssessments, loadPolicy, stateDirectory } from "../config.js";
import { TradeLedger } from "../ledger.js";
import { ExitLedger } from "../exit-ledger.js";
import { applyExitConstraints } from "../engine.js";
import { selectCandidates } from "../planner.js";
import { activationMode, readBook } from "../runtime.js";

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
try {
  await assertSignerIdentity();
  checks.push({ name: "signer", ok: true, detail: "registered wallet matches" });
} catch (error) {
  checks.push({ name: "signer", ok: false, detail: String(error) });
}
const [policy, assessments, book] = await Promise.all([loadPolicy(), loadAssessments(), readBook(client)]);
checks.push({ name: "api", ok: book.markets.length > 0, detail: `${book.markets.length} open markets` });
checks.push({ name: "gas", ok: book.gasEth >= policy.minimumGasEth, detail: `${book.gasEth} ETH` });
checks.push({ name: "funding", ok: book.totalEquityTst >= policy.minimumStartingTst, detail: `${book.totalEquityTst} TST` });
const tradeLedger = new TradeLedger(resolve(stateDirectory(), "trade-ledger.json"));
const exitLedger = new ExitLedger(resolve(stateDirectory(), "exit-ledger.json"));
const readinessNow = Date.now();
const [exitRecords, pendingTrade, pendingExit] = await Promise.all([
  exitLedger.records(), tradeLedger.pending(), exitLedger.pending(),
]);
const candidates = applyExitConstraints({
  candidates: selectCandidates({ now: readinessNow, policy, markets: book.markets, positions: book.positions, assessments }),
  exits: exitRecords,
  now: readinessNow,
});
checks.push({ name: "evidence", ok: candidates.length > 0, detail: `${candidates.length} actionable candidate(s)` });
const pending = pendingTrade ?? pendingExit;
checks.push({
  name: "ledger",
  ok: pending === null,
  detail: pending
    ? `pending ${pendingExit ? "exit" : "trade"} ${pending.decisionId}`
    : "no unresolved intent",
});
try {
  const mode = await activationMode();
  checks.push({ name: "activation", ok: mode !== "disabled", detail: mode });
} catch (error) {
  checks.push({ name: "activation", ok: false, detail: String(error) });
}
process.stdout.write(`${JSON.stringify({ ready: checks.every((check) => check.ok), checks }, null, 2)}\n`);
