import { resolve } from "node:path";
import { sendAlert } from "../alerts.js";
import { EXPECTED_WALLET, stateDirectory } from "../config.js";
import { assertSignerIdentity, client } from "../delphi.js";
import {
  buildLeaderboard,
  filterEventsToCompetitionMarkets,
  leaderboardChanges,
  loadCompetitionEvents,
  loadLeaderboardSnapshot,
  saveLeaderboardSnapshot,
  type MarketMark,
} from "../leaderboard-monitor.js";

const BALANCE_OF_ABI = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

async function loadMarketMarks(): Promise<MarketMark[]> {
  const values: MarketMark[] = [];
  for (let skip = 0; ; skip += 100) {
    const response = await client.listMarkets({ skip, limit: 100, pricesAndImpliedProbabilities: true });
    const page = response.markets ?? [];
    values.push(...page.map((market) => ({
      id: market.id,
      question: market.metadata?.question ?? market.id,
      status: market.status,
      prices: market.spotPrices ?? [],
      winningOutcomeIndex: market.winningOutcomeIdx === null || market.winningOutcomeIdx === undefined
        ? null
        : Number(market.winningOutcomeIdx),
    })));
    if (page.length < 100) break;
  }
  return values;
}

function eventWallets(events: Awaited<ReturnType<typeof loadCompetitionEvents>>): string[] {
  return [...new Set([
    ...events.buys.map((item) => item.buyer),
    ...events.sells.map((item) => item.seller),
    ...events.redemptions.map((item) => item.redeemer),
    ...events.liquidations.map((item) => item.liquidator),
  ].map((item) => item.toLowerCase()))].sort();
}

async function main(): Promise<void> {
  await assertSignerIdentity();
  const observedAt = new Date().toISOString();
  const rawEvents = await loadCompetitionEvents();
  const marks = await loadMarketMarks();
  const { events, ignoredEvents } = filterEventsToCompetitionMarkets(rawEvents, marks.map((market) => market.id));
  const wallets = eventWallets(events);
  const { publicClient } = await client.getSigner();
  const balances = await publicClient.multicall({
    allowFailure: true,
    contracts: wallets.map((wallet) => ({
      address: client.getTokenAddress(),
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [wallet as `0x${string}`],
    })),
  });
  const cashAtomicByWallet = new Map<string, bigint>();
  balances.forEach((result, index) => {
    const wallet = wallets[index];
    if (!wallet || result.status !== "success") {
      throw new Error(`TST balance lookup failed for ${wallet ?? `wallet index ${index}`}`);
    }
    cashAtomicByWallet.set(wallet, result.result);
  });
  const initialTst = Number(process.env.DELPHI_LEADERBOARD_INITIAL_TST?.trim() || "1000");
  if (!Number.isFinite(initialTst) || initialTst <= 0) throw new Error("invalid leaderboard initial TST baseline");
  const snapshot = buildLeaderboard({
    events,
    marks,
    cashAtomicByWallet,
    convictionWallet: EXPECTED_WALLET,
    initialTst,
    observedAt,
  });
  const directory = resolve(stateDirectory(), "leaderboard");
  const latestPath = resolve(directory, "latest.json");
  const previous = await loadLeaderboardSnapshot(latestPath);
  const changes = leaderboardChanges(previous, snapshot);
  const timestampPath = resolve(directory, `${observedAt.replaceAll(":", "-")}.json`);
  await saveLeaderboardSnapshot(timestampPath, snapshot);
  await saveLeaderboardSnapshot(latestPath, snapshot);
  if (changes.length > 0) {
    const conviction = snapshot.conviction;
    await sendAlert("LEADERBOARD", [
      ...changes,
      `Conviction rank ${conviction?.rank ?? "unknown"}`,
      `value ${conviction?.accountValueTst.toFixed(2) ?? "unknown"} TST`,
      `gap to third ${snapshot.gapToThirdTst?.toFixed(2) ?? "unknown"} TST`,
    ].join("\n"));
  }
  process.stdout.write(`${JSON.stringify({
    status: "LEADERBOARD_SNAPSHOT",
    snapshot,
    ignoredPreCompetitionEvents: ignoredEvents,
    changes,
  }, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  await sendAlert("LEADERBOARD MONITOR FAILED", detail);
  process.stderr.write(`${detail}\n`);
  process.exitCode = 1;
}
