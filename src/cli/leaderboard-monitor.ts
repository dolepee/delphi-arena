import { resolve } from "node:path";
import { sendAlert } from "../alerts.js";
import { EXPECTED_WALLET, stateDirectory } from "../config.js";
import { assertSignerIdentity, client } from "../delphi.js";
import {
  buildLeaderboard,
  chunkLeaderboardAlert,
  filterEventsToCompetitionMarkets,
  leaderboardChanges,
  loadCompetitionEvents,
  loadLeaderboardSnapshot,
  saveLeaderboardSnapshot,
  shouldAdvanceLeaderboardSnapshot,
  type MarketMark,
} from "../leaderboard-monitor.js";

const BALANCE_OF_ABI = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

const DECIMALS_ABI = [{
  type: "function",
  name: "decimals",
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "", type: "uint8" }],
}] as const;

const SPOT_PRICES_ABI = [{
  type: "function",
  name: "spotPrices",
  stateMutability: "view",
  inputs: [
    { name: "marketProxy", type: "address" },
    { name: "outcomeIndices", type: "uint256[]" },
  ],
  outputs: [{ name: "", type: "uint256[]" }],
}] as const;
const COMPETITION_GATEWAY = (
  process.env.DELPHI_GATEWAY_CONTRACT?.trim() || "0x097599c9D966fF496284b892A8F13BF885b258ef"
) as `0x${string}`;

async function loadMarketMarks(
  publicClient: Awaited<ReturnType<typeof client.getSigner>>["publicClient"],
  blockNumber: bigint,
): Promise<MarketMark[]> {
  const markets = [];
  for (let skip = 0; ; skip += 100) {
    const response = await client.listMarkets({ skip, limit: 100 });
    const page = response.markets ?? [];
    markets.push(...page);
    if (page.length < 100) break;
  }
  const decimals = await publicClient.readContract({
    address: client.getTokenAddress(),
    abi: DECIMALS_ABI,
    functionName: "decimals",
    blockNumber,
  });
  const divisor = 10 ** Number(decimals);
  return Promise.all(markets.map(async (market): Promise<MarketMark> => {
    const outcomeCount = market.metadata?.outcomes?.length ?? 0;
    let prices: number[] = [];
    if (outcomeCount > 0) {
      try {
        const rawPrices = await publicClient.readContract({
          address: COMPETITION_GATEWAY,
          abi: SPOT_PRICES_ABI,
          functionName: "spotPrices",
          args: [
            market.id as `0x${string}`,
            Array.from({ length: outcomeCount }, (_, index) => BigInt(index)),
          ],
          blockNumber,
        });
        prices = rawPrices.map((price) => Number(price) / divisor);
      } catch {
        // A market added to REST after the pinned subgraph block has no state at
        // that block. It is harmless unless reconstructed holdings reference it,
        // in which case buildLeaderboard fails closed as unpriced.
      }
    }
    return {
      id: market.id,
      question: market.metadata?.question ?? market.id,
      status: market.status,
      prices,
      winningOutcomeIndex: market.winningOutcomeIdx === null || market.winningOutcomeIdx === undefined
        ? null
        : Number(market.winningOutcomeIdx),
    };
  }));
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
  const { publicClient } = await client.getSigner();
  const pinnedBlock = BigInt(rawEvents.blockNumber);
  const marks = await loadMarketMarks(publicClient, pinnedBlock);
  const { events, ignoredEvents } = filterEventsToCompetitionMarkets(rawEvents, marks.map((market) => market.id));
  const wallets = eventWallets(events);
  const balances = await publicClient.multicall({
    allowFailure: true,
    blockNumber: pinnedBlock,
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
  let allAlertsSent = true;
  if (changes.length > 0) {
    const conviction = snapshot.conviction;
    const detail = [
      ...changes,
      `Conviction rank ${conviction?.rank ?? "unknown"}`,
      `value ${conviction?.accountValueTst.toFixed(2) ?? "unknown"} TST`,
      `gap to third ${snapshot.gapToThirdTst?.toFixed(2) ?? "unknown"} TST`,
    ].join("\n");
    for (const chunk of chunkLeaderboardAlert(detail)) {
      const sent = await sendAlert("LEADERBOARD", chunk);
      allAlertsSent = sent && allAlertsSent;
    }
  }
  if (shouldAdvanceLeaderboardSnapshot(changes.length, allAlertsSent)) {
    await saveLeaderboardSnapshot(latestPath, snapshot);
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
