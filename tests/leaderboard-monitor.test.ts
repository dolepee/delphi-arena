import { describe, expect, it } from "vitest";
import {
  buildLeaderboard,
  chunkLeaderboardAlert,
  filterEventsToCompetitionMarkets,
  leaderboardChanges,
  shouldAdvanceLeaderboardSnapshot,
  type CompetitionEvents,
  type LeaderboardSnapshot,
  type MarketMark,
} from "../src/leaderboard-monitor.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";
const M1 = "0x1111111111111111111111111111111111111111";
const M2 = "0x2222222222222222222222222222222222222222";

const events: CompetitionEvents = {
  blockNumber: 123,
  buys: [
    { buyer: A, marketProxy: M1, outcomeIdx: "0", tokensIn: "100000000", sharesOut: "200000000000000000000", timestamp_: "100" },
    { buyer: B, marketProxy: M2, outcomeIdx: "1", tokensIn: "100000000", sharesOut: "100000000000000000000", timestamp_: "101" },
    { buyer: C, marketProxy: M1, outcomeIdx: "1", tokensIn: "10000000", sharesOut: "20000000000000000000", timestamp_: "102" },
  ],
  sells: [
    { seller: A, marketProxy: M1, outcomeIdx: "0", tokensOut: "35000000", sharesIn: "50000000000000000000", timestamp_: "103" },
  ],
  redemptions: [],
  liquidations: [
    { liquidator: C, marketProxy: M1, outcomeIndices: "1", sharesIn: "20000000000000000000", totalTokensOut: "10000000", timestamp_: "104" },
  ],
  settlements: [{ marketProxy: M2, winningOutcomeIdx: "1" }],
};

const marks: MarketMark[] = [
  { id: M1, question: "Open", status: "open", prices: [0.6, 0.4], winningOutcomeIndex: null },
  { id: M2, question: "Settled", status: "settled", prices: [], winningOutcomeIndex: 1 },
];

describe("chain-derived leaderboard", () => {
  it("excludes gateway activity outside the official competition market catalog", () => {
    const extra = {
      ...events.buys[0]!,
      marketProxy: "0xffffffffffffffffffffffffffffffffffffffff",
    };
    const filtered = filterEventsToCompetitionMarkets(
      { ...events, buys: [...events.buys, extra] },
      marks.map((item) => item.id),
    );
    expect(filtered.ignoredEvents).toBe(1);
    expect(filtered.events.buys).toEqual(events.buys);
  });

  it("accepts liquidation arrays as well as Goldsky comma-delimited scalars", () => {
    const arrayLiquidation = {
      ...events.liquidations[0]!,
      outcomeIndices: ["1"],
      sharesIn: ["20000000000000000000"],
    };
    expect(() => buildLeaderboard({
      events: { ...events, liquidations: [arrayLiquidation] },
      marks,
      cashAtomicByWallet: new Map([[A, 935_000_000n], [B, 900_000_000n], [C, 1_005_000_000n]]),
      convictionWallet: A,
      initialTst: 1000,
      observedAt: "2026-08-16T22:00:00.000Z",
    })).not.toThrow();
  });

  it("ranks current token balances plus reconstructed marked positions", () => {
    const snapshot = buildLeaderboard({
      events,
      marks,
      cashAtomicByWallet: new Map([[A, 935_000_000n], [B, 900_000_000n], [C, 1_005_000_000n]]),
      convictionWallet: A,
      initialTst: 1000,
      observedAt: "2026-08-16T22:00:00.000Z",
    });
    expect(snapshot.leaders.map((row) => row.wallet)).toEqual([A, C, B]);
    expect(snapshot.conviction).toMatchObject({
      rank: 1,
      cashTst: 935,
      positionValueTst: 90,
      accountValueTst: 1025,
      pnlTst: 25,
      tradeCount: 2,
      volumeTst: 135,
      activeMarketIds: [M1],
      tradedMarketIds: [M1],
    });
    expect(snapshot.thirdPlaceValueTst).toBe(1000);
    expect(snapshot.gapToThirdTst).toBe(0);
  });

  it("fails closed instead of ranking an unpriced position or missing balance", () => {
    const input = {
      events,
      marks,
      cashAtomicByWallet: new Map([[A, 935_000_000n], [B, 900_000_000n], [C, 1_005_000_000n]]),
      convictionWallet: A,
      initialTst: 1000,
      observedAt: "2026-08-16T22:00:00.000Z",
    };
    expect(() => buildLeaderboard({ ...input, marks: marks.filter((item) => item.id !== M1) }))
      .toThrow("unpriced market");
    expect(() => buildLeaderboard({ ...input, cashAtomicByWallet: new Map([[A, 935_000_000n]]) }))
      .toThrow("missing TST balance");
  });

  it("reports threshold and top-wallet market changes without affecting ranking", () => {
    const row = {
      rank: 1, wallet: A, accountValueTst: 1100, pnlTst: 100, cashTst: 1000,
      positionValueTst: 100, tradeCount: 1, volumeTst: 100, activeMarketIds: [M1], lastTradeAt: null,
      tradedMarketIds: [M1],
    };
    const previous = {
      version: 1, observedAt: "2026-08-16T18:00:00.000Z", sourceBlock: 100, initialTst: 1000,
      leaders: [row], conviction: row, thirdPlaceValueTst: 2000, gapToThirdTst: 900,
    } satisfies LeaderboardSnapshot;
    const current = {
      ...previous,
      observedAt: "2026-08-16T22:00:00.000Z",
      thirdPlaceValueTst: 2110,
      leaders: [{ ...row, tradedMarketIds: [M1, M2] }],
    } satisfies LeaderboardSnapshot;
    expect(leaderboardChanges(previous, current)).toEqual([
      "third-place threshold moved from 2000.00 to 2110.00 TST",
      `top-five wallets entered ${M2}`,
      "large podium move detected",
    ]);
  });

  it("chunks every leaderboard alert byte and retains the comparison snapshot until delivery", () => {
    const detail = `${"a".repeat(10)}\n${"b".repeat(10)}\n${"c".repeat(10)}`;
    const chunks = chunkLeaderboardAlert(detail, 12);
    expect(chunks.every((chunk) => chunk.length <= 12)).toBe(true);
    expect(chunks.join("\n")).toBe(detail);
    expect(shouldAdvanceLeaderboardSnapshot(1, false)).toBe(false);
    expect(shouldAdvanceLeaderboardSnapshot(1, true)).toBe(true);
    expect(shouldAdvanceLeaderboardSnapshot(0, false)).toBe(true);
  });
});
