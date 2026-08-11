import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DelphiClient, Market, Position } from "@gensyn-ai/gensyn-delphi-sdk";
import { EXPECTED_WALLET, liveConfirmation, stateDirectory } from "./config.js";
import { marketToView, positionToView } from "./delphi.js";
import type { MarketView, Policy, PositionView } from "./model.js";

export interface Book {
  rawMarkets: Market[];
  rawPositions: Position[];
  markets: MarketView[];
  positions: PositionView[];
  availableTst: number;
  gasEth: number;
  deployedValueTst: number;
  totalEquityTst: number;
}

export async function readBook(client: DelphiClient): Promise<Book> {
  const [{ markets: rawMarkets }, { positions: rawPositions }, tst, eth] = await Promise.all([
    client.listMarkets({ status: "open", limit: 50, pricesAndImpliedProbabilities: true }),
    client.listPositions({ wallet: EXPECTED_WALLET, redeemedOrLiquidated: false, limit: 100 }),
    client.getErc20Balance(),
    client.getEthBalance(),
  ]);
  const allRawMarkets = [...(rawMarkets ?? [])];
  const known = new Set(allRawMarkets.map((market) => market.id.toLowerCase()));
  const missingMarketIds = [...new Set((rawPositions ?? [])
    .map((position) => position.marketProxy)
    .filter((marketId) => !known.has(marketId.toLowerCase()))
  )];
  const missingMarkets = await Promise.all(missingMarketIds.map(async (id) =>
    client.getMarket({ id, pricesAndImpliedProbabilities: true })
  ));
  allRawMarkets.push(...missingMarkets);
  const markets = allRawMarkets.map(marketToView);
  const marketMap = new Map(markets.map((market) => [market.id.toLowerCase(), market]));
  const positions = (rawPositions ?? []).flatMap((position) => {
    const market = marketMap.get(position.marketProxy.toLowerCase());
    return market ? [positionToView(position, market)] : [];
  });
  const availableTst = Number(tst) / 1e6;
  const deployedValueTst = positions.reduce(
    (total, position) => total + position.shares * position.markPrice,
    0,
  );
  return {
    rawMarkets: allRawMarkets,
    rawPositions: rawPositions ?? [],
    markets,
    positions,
    availableTst,
    gasEth: Number(eth) / 1e18,
    deployedValueTst,
    totalEquityTst: availableTst + deployedValueTst,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function activationMode(): Promise<"canary" | "full" | "disabled"> {
  if (process.env.DELPHI_LIVE_ENABLED !== "true") return "disabled";
  if (process.env.DELPHI_LIVE_CONFIRMATION !== liveConfirmation()) {
    throw new Error("live confirmation is missing or incorrect");
  }
  const directory = stateDirectory();
  const canaryApproved = await exists(resolve(directory, "canary-approved.json"));
  const canaryComplete = await exists(resolve(directory, "canary-complete.json"));
  const fullApproved = await exists(resolve(directory, "full-live-approved.json"));
  if (!canaryApproved) throw new Error("production canary is not approved");
  if (!canaryComplete) return "canary";
  if (!fullApproved) throw new Error("canary completed; full-live approval is still required");
  return "full";
}

export async function assertWriteReadiness(input: {
  now: number;
  policy: Policy;
  book: Book;
}): Promise<"canary" | "full"> {
  const mode = await activationMode();
  if (mode === "disabled") throw new Error("live writes are disabled");
  if (input.now >= Date.parse(input.policy.competitionEndsAt)) {
    throw new Error("competition trading window has closed");
  }
  if (input.book.gasEth < input.policy.minimumGasEth) throw new Error("insufficient gas reserve");
  const anchorPath = resolve(stateDirectory(), "initial-equity.json");
  try {
    const anchor = JSON.parse(await readFile(anchorPath, "utf8")) as { initialTst: number };
    if (anchor.initialTst < input.policy.minimumStartingTst) throw new Error("invalid initial equity anchor");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (input.book.totalEquityTst < input.policy.minimumStartingTst) {
      throw new Error("organizer starting balance has not been credited");
    }
    await mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(anchorPath, `${JSON.stringify({
      wallet: EXPECTED_WALLET,
      initialTst: input.book.totalEquityTst,
      anchoredAt: input.now,
    }, null, 2)}\n`, { mode: 0o600 });
  }
  return mode;
}

export async function assertMaintenanceReadiness(book: Book): Promise<void> {
  if (process.env.DELPHI_LIVE_ENABLED !== "true") throw new Error("live writes are disabled");
  if (process.env.DELPHI_LIVE_CONFIRMATION !== liveConfirmation()) {
    throw new Error("live confirmation is missing or incorrect");
  }
  if (book.gasEth < 0.0001) throw new Error("insufficient gas for position maintenance");
}
