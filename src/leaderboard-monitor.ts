import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const COMPETITION_SUBGRAPH_URL =
  "https://api.goldsky.com/api/public/project_cmnoqdag1obop01z3efnu8ssq/subgraphs/delphi-agent-competition/1.0.0/gn";

export interface BuyEvent {
  buyer: string;
  marketProxy: string;
  outcomeIdx: string;
  tokensIn: string;
  sharesOut: string;
  timestamp_: string;
}

export interface SellEvent {
  seller: string;
  marketProxy: string;
  outcomeIdx: string;
  tokensOut: string;
  sharesIn: string;
  timestamp_: string;
}

export interface RedemptionEvent {
  redeemer: string;
  marketProxy: string;
  sharesIn: string;
  tokensOut: string;
  timestamp_: string;
}

export interface LiquidationEvent {
  liquidator: string;
  marketProxy: string;
  outcomeIndices: string | string[];
  sharesIn: string | string[];
  totalTokensOut: string;
  timestamp_: string;
}

export interface SettlementEvent {
  marketProxy: string;
  winningOutcomeIdx: string;
}

export interface CompetitionEvents {
  buys: BuyEvent[];
  sells: SellEvent[];
  redemptions: RedemptionEvent[];
  liquidations: LiquidationEvent[];
  settlements: SettlementEvent[];
  blockNumber: number;
}

export interface MarketMark {
  id: string;
  question: string;
  status: string;
  prices: number[];
  winningOutcomeIndex: number | null;
}

export interface LeaderboardRow {
  rank: number;
  wallet: string;
  accountValueTst: number;
  pnlTst: number;
  cashTst: number;
  positionValueTst: number;
  tradeCount: number;
  volumeTst: number;
  activeMarketIds: string[];
  tradedMarketIds: string[];
  lastTradeAt: string | null;
}

export interface LeaderboardSnapshot {
  version: 1;
  observedAt: string;
  sourceBlock: number;
  initialTst: number;
  leaders: LeaderboardRow[];
  conviction: LeaderboardRow | null;
  thirdPlaceValueTst: number | null;
  gapToThirdTst: number | null;
}

interface GraphResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

async function graphQuery<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(process.env.DELPHI_COMPETITION_SUBGRAPH_URL?.trim() || COMPETITION_SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`competition subgraph returned HTTP ${response.status}`);
  const result = await response.json() as GraphResponse<T>;
  if (result.errors?.length || !result.data) {
    throw new Error(`competition subgraph query failed: ${result.errors?.map((item) => item.message).join("; ") || "missing data"}`);
  }
  return result.data;
}

async function paginate<T>(field: string, selection: string, blockNumber: number): Promise<T[]> {
  const values: T[] = [];
  for (let skip = 0; ; skip += 1_000) {
    const data = await graphQuery<Record<string, T[]>>(
      `query($first: Int!, $skip: Int!, $block: Int!) { ${field}(first: $first, skip: $skip, block: { number: $block }, orderBy: block_number, orderDirection: asc) { ${selection} } }`,
      { first: 1_000, skip, block: blockNumber },
    );
    const page = data[field] ?? [];
    values.push(...page);
    if (page.length < 1_000) return values;
  }
}

export async function loadCompetitionEvents(): Promise<CompetitionEvents> {
  const meta = await graphQuery<{ _meta: { block: { number: number } } }>("{ _meta { block { number } } }");
  const blockNumber = meta._meta.block.number;
  const [buys, sells, redemptions, liquidations, settlements] = await Promise.all([
    paginate<BuyEvent>("gatewayBuys", "buyer marketProxy outcomeIdx tokensIn sharesOut timestamp_", blockNumber),
    paginate<SellEvent>("gatewaySells", "seller marketProxy outcomeIdx tokensOut sharesIn timestamp_", blockNumber),
    paginate<RedemptionEvent>("gatewayRedemptions", "redeemer marketProxy sharesIn tokensOut timestamp_", blockNumber),
    paginate<LiquidationEvent>("gatewayLiquidations", "liquidator marketProxy outcomeIndices sharesIn totalTokensOut timestamp_", blockNumber),
    paginate<SettlementEvent>("gatewayMarketSettleds", "marketProxy winningOutcomeIdx", blockNumber),
  ]);
  return { buys, sells, redemptions, liquidations, settlements, blockNumber };
}

export function filterEventsToCompetitionMarkets(
  events: CompetitionEvents,
  marketIds: Iterable<string>,
): { events: CompetitionEvents; ignoredEvents: number } {
  const allowed = new Set([...marketIds].map(normalizedAddress));
  const keep = <T extends { marketProxy: string }>(items: T[]) =>
    items.filter((item) => allowed.has(normalizedAddress(item.marketProxy)));
  const filtered: CompetitionEvents = {
    ...events,
    buys: keep(events.buys),
    sells: keep(events.sells),
    redemptions: keep(events.redemptions),
    liquidations: keep(events.liquidations),
    settlements: keep(events.settlements),
  };
  const retained = filtered.buys.length + filtered.sells.length + filtered.redemptions.length +
    filtered.liquidations.length + filtered.settlements.length;
  const total = events.buys.length + events.sells.length + events.redemptions.length +
    events.liquidations.length + events.settlements.length;
  return { events: filtered, ignoredEvents: total - retained };
}

function normalizedAddress(value: string): string {
  return value.toLowerCase();
}

function positionKey(marketId: string, outcomeIndex: number): string {
  return `${normalizedAddress(marketId)}:${outcomeIndex}`;
}

function scalarValues(value: string | string[]): string[] {
  return Array.isArray(value) ? value : value.split(",");
}

function parseCsvBigInts(value: string | string[]): bigint[] {
  return scalarValues(value).filter(Boolean).map((item) => BigInt(item.trim()));
}

function parseCsvNumbers(value: string | string[]): number[] {
  return scalarValues(value).filter(Boolean).map((item) => Number(item.trim()));
}

export function buildLeaderboard(input: {
  events: CompetitionEvents;
  marks: MarketMark[];
  cashAtomicByWallet: Map<string, bigint>;
  convictionWallet: string;
  initialTst: number;
  observedAt: string;
}): LeaderboardSnapshot {
  const positions = new Map<string, Map<string, bigint>>();
  const tradeStats = new Map<string, { count: number; volumeAtomic: bigint; markets: Set<string>; lastTimestamp: number }>();
  const wallets = new Set<string>();
  const settlements = new Map(input.events.settlements.map((item) => [
    normalizedAddress(item.marketProxy), Number(item.winningOutcomeIdx),
  ]));

  const adjustPosition = (walletValue: string, marketValue: string, outcomeIndex: number, delta: bigint) => {
    const wallet = normalizedAddress(walletValue);
    const marketId = normalizedAddress(marketValue);
    wallets.add(wallet);
    const holdings = positions.get(wallet) ?? new Map<string, bigint>();
    const key = positionKey(marketId, outcomeIndex);
    const next = (holdings.get(key) ?? 0n) + delta;
    if (next < 0n) throw new Error(`negative reconstructed position for ${wallet} ${key}`);
    holdings.set(key, next);
    positions.set(wallet, holdings);
  };
  const recordTrade = (walletValue: string, marketValue: string, volumeAtomic: bigint, timestamp: string) => {
    const wallet = normalizedAddress(walletValue);
    const stats = tradeStats.get(wallet) ?? { count: 0, volumeAtomic: 0n, markets: new Set<string>(), lastTimestamp: 0 };
    stats.count += 1;
    stats.volumeAtomic += volumeAtomic;
    stats.markets.add(normalizedAddress(marketValue));
    stats.lastTimestamp = Math.max(stats.lastTimestamp, Number(timestamp));
    tradeStats.set(wallet, stats);
  };

  for (const event of input.events.buys) {
    adjustPosition(event.buyer, event.marketProxy, Number(event.outcomeIdx), BigInt(event.sharesOut));
    recordTrade(event.buyer, event.marketProxy, BigInt(event.tokensIn), event.timestamp_);
  }
  for (const event of input.events.sells) {
    adjustPosition(event.seller, event.marketProxy, Number(event.outcomeIdx), -BigInt(event.sharesIn));
    recordTrade(event.seller, event.marketProxy, BigInt(event.tokensOut), event.timestamp_);
  }
  for (const event of input.events.redemptions) {
    const winningOutcome = settlements.get(normalizedAddress(event.marketProxy));
    if (winningOutcome === undefined) throw new Error(`redemption lacks settlement for ${event.marketProxy}`);
    adjustPosition(event.redeemer, event.marketProxy, winningOutcome, -BigInt(event.sharesIn));
  }
  for (const event of input.events.liquidations) {
    const outcomes = parseCsvNumbers(event.outcomeIndices);
    const shares = parseCsvBigInts(event.sharesIn);
    if (outcomes.length !== shares.length) throw new Error(`invalid liquidation arrays for ${event.marketProxy}`);
    outcomes.forEach((outcome, index) => adjustPosition(
      event.liquidator,
      event.marketProxy,
      outcome,
      -(shares[index] ?? 0n),
    ));
  }

  const marks = new Map(input.marks.map((item) => [normalizedAddress(item.id), item]));
  const rows = [...wallets].map((wallet) => {
    const cashAtomic = input.cashAtomicByWallet.get(wallet);
    if (cashAtomic === undefined) throw new Error(`missing TST balance for ${wallet}`);
    let positionValueTst = 0;
    const activeMarkets = new Set<string>();
    for (const [key, sharesAtomic] of positions.get(wallet) ?? []) {
      if (sharesAtomic === 0n) continue;
      const separator = key.lastIndexOf(":");
      const marketId = key.slice(0, separator);
      const outcomeIndex = Number(key.slice(separator + 1));
      const mark = marks.get(marketId);
      if (!mark) throw new Error(`unpriced market ${marketId} held by ${wallet}`);
      const settledWinner = settlements.get(marketId);
      const price = settledWinner === undefined
        ? mark.prices[outcomeIndex]
        : Number(outcomeIndex === settledWinner);
      if (!Number.isFinite(price)) throw new Error(`unpriced outcome ${marketId}:${outcomeIndex}`);
      positionValueTst += Number(sharesAtomic) / 1e18 * price!;
      activeMarkets.add(marketId);
    }
    const stats = tradeStats.get(wallet) ?? { count: 0, volumeAtomic: 0n, markets: new Set<string>(), lastTimestamp: 0 };
    const cashTst = Number(cashAtomic) / 1e6;
    const accountValueTst = cashTst + positionValueTst;
    return {
      rank: 0,
      wallet,
      accountValueTst,
      pnlTst: accountValueTst - input.initialTst,
      cashTst,
      positionValueTst,
      tradeCount: stats.count,
      volumeTst: Number(stats.volumeAtomic) / 1e6,
      activeMarketIds: [...activeMarkets].sort(),
      tradedMarketIds: [...stats.markets].sort(),
      lastTradeAt: stats.lastTimestamp > 0 ? new Date(stats.lastTimestamp * 1_000).toISOString() : null,
    } satisfies LeaderboardRow;
  }).sort((left, right) => right.accountValueTst - left.accountValueTst || left.wallet.localeCompare(right.wallet));
  rows.forEach((row, index) => { row.rank = index + 1; });
  const leaders = rows.slice(0, 5);
  const conviction = rows.find((row) => row.wallet === normalizedAddress(input.convictionWallet)) ?? null;
  const thirdPlaceValueTst = rows[2]?.accountValueTst ?? null;
  return {
    version: 1,
    observedAt: input.observedAt,
    sourceBlock: input.events.blockNumber,
    initialTst: input.initialTst,
    leaders,
    conviction,
    thirdPlaceValueTst,
    gapToThirdTst: conviction && thirdPlaceValueTst !== null
      ? Math.max(0, thirdPlaceValueTst - conviction.accountValueTst)
      : null,
  };
}

export function leaderboardChanges(previous: LeaderboardSnapshot | null, current: LeaderboardSnapshot): string[] {
  if (!previous) return ["initial leaderboard snapshot"];
  const changes: string[] = [];
  if (
    previous.thirdPlaceValueTst !== null && current.thirdPlaceValueTst !== null &&
    Math.abs(current.thirdPlaceValueTst - previous.thirdPlaceValueTst) >= 1
  ) {
    changes.push(`third-place threshold moved from ${previous.thirdPlaceValueTst.toFixed(2)} to ${current.thirdPlaceValueTst.toFixed(2)} TST`);
  }
  const previousMarkets = new Set(previous.leaders.flatMap((row) => row.tradedMarketIds ?? row.activeMarketIds));
  const newMarkets = [...new Set(current.leaders.flatMap((row) => row.tradedMarketIds ?? row.activeMarketIds))]
    .filter((marketId) => !previousMarkets.has(marketId));
  if (newMarkets.length > 0) changes.push(`top-five wallets entered ${newMarkets.join(", ")}`);
  if (
    previous.thirdPlaceValueTst !== null && current.thirdPlaceValueTst !== null &&
    Math.abs(current.thirdPlaceValueTst - previous.thirdPlaceValueTst) >= 100
  ) changes.push("large podium move detected");
  return changes;
}

export function chunkLeaderboardAlert(detail: string, maximumLength = 3_400): string[] {
  if (!Number.isInteger(maximumLength) || maximumLength <= 0) {
    throw new Error("invalid leaderboard alert chunk length");
  }
  const chunks: string[] = [];
  let remaining = detail;
  while (remaining.length > maximumLength) {
    let boundary = remaining.lastIndexOf("\n", maximumLength);
    if (boundary <= 0) boundary = maximumLength;
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
    if (remaining.startsWith("\n")) remaining = remaining.slice(1);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function shouldAdvanceLeaderboardSnapshot(changeCount: number, allAlertsSent: boolean): boolean {
  return changeCount === 0 || allAlertsSent;
}

export async function loadLeaderboardSnapshot(path: string): Promise<LeaderboardSnapshot | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LeaderboardSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveLeaderboardSnapshot(path: string, snapshot: LeaderboardSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
