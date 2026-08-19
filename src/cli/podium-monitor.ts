import { resolve } from "node:path";
import { EXPECTED_WALLET, stateDirectory } from "../config.js";
import {
  buildPodiumSnapshot,
  OFFICIAL_COMPETITION_URL,
  parseOfficialRankings,
  savePodiumSnapshot,
} from "../podium-monitor.js";

const response = await fetch(OFFICIAL_COMPETITION_URL, {
  headers: {
    accept: "text/html",
    "cache-control": "no-cache",
    "user-agent": "Conviction-Delphi-Arena/1.0",
  },
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`official leaderboard returned HTTP ${response.status}`);
const observedAt = new Date().toISOString();
const snapshot = buildPodiumSnapshot({
  rankings: parseOfficialRankings(await response.text()),
  convictionWallet: EXPECTED_WALLET,
  observedAt,
});
await savePodiumSnapshot(resolve(stateDirectory(), "podium", "latest.json"), snapshot);
process.stdout.write(`${JSON.stringify({ status: "PODIUM_SNAPSHOT", snapshot }, null, 2)}\n`);
