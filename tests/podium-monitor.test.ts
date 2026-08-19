import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPodiumSnapshot,
  loadFreshPodiumSnapshot,
  parseOfficialRankings,
  savePodiumSnapshot,
} from "../src/podium-monitor.js";

const CONVICTION = "0x86bE235Bb9Aa6D9E2Cf89b2f4E9c90e1ecb7C781";
const rankings = [
  { rank: 1, address: "0x1111111111111111111111111111111111111111", name: "One", accountValue: 6000, cash: 1000, pnl: 5000, tradesVolume: 20, tradesCount: 2 },
  { rank: 2, address: "0x2222222222222222222222222222222222222222", name: "Two", accountValue: 5500, cash: 1000, pnl: 4500, tradesVolume: 30, tradesCount: 3 },
  { rank: 3, address: "0x3333333333333333333333333333333333333333", name: "Three [verified]", accountValue: 4750, cash: 1000, pnl: 3750, tradesVolume: 40, tradesCount: 4 },
  { rank: 29, address: CONVICTION, name: "Conviction", accountValue: 1422.5, cash: 1422.5, pnl: 422.5, tradesVolume: 2100, tradesCount: 26 },
];

function page(rows = rankings): string {
  const payload = JSON.stringify(`0:{"competition":{"state":"active"},"rankings":${JSON.stringify(rows)},"stats":{"agents":153}}`);
  return `<html><script>self.__next_f.push([0])</script><script>self.__next_f.push([1,${payload}])</script></html>`;
}

describe("official podium monitor", () => {
  it("extracts the unique server-rendered rankings payload without breaking on brackets in names", () => {
    expect(parseOfficialRankings(page())).toEqual(rankings);
  });

  it("fails closed when rankings are absent, duplicated, or malformed", () => {
    expect(() => parseOfficialRankings("<html></html>")).toThrow(/found 0/u);
    expect(() => parseOfficialRankings(`${page()}${page()}`)).toThrow(/found 2/u);
    expect(() => parseOfficialRankings(page(rankings.slice(0, 2)))).toThrow();
  });

  it("builds, atomically persists, and freshness-gates the registered wallet snapshot", async () => {
    const now = Date.parse("2026-08-19T16:00:00.000Z");
    const snapshot = buildPodiumSnapshot({
      rankings,
      convictionWallet: CONVICTION,
      observedAt: new Date(now).toISOString(),
    });
    expect(snapshot.third.accountValue).toBe(4750);
    expect(snapshot.conviction.rank).toBe(29);
    expect(snapshot.thirdPlacePnlTst).toBe(3750);
    expect(snapshot.gapToThirdPnlTst).toBe(3327.5);
    const directory = await mkdtemp(resolve(tmpdir(), "podium-monitor-"));
    const path = resolve(directory, "nested", "latest.json");
    await savePodiumSnapshot(path, snapshot);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(snapshot);
    await expect(loadFreshPodiumSnapshot(path, now + 29_999, 30_000, CONVICTION)).resolves.toEqual(snapshot);
    await expect(loadFreshPodiumSnapshot(path, now + 30_001, 30_000, CONVICTION)).rejects.toThrow(/stale/u);
    await expect(loadFreshPodiumSnapshot(
      path,
      now + 1,
      30_000,
      "0x4444444444444444444444444444444444444444",
    )).rejects.toThrow(/wrong wallet/u);
  });

  it("rejects internally inconsistent duplicated PnL fields", async () => {
    const now = Date.parse("2026-08-19T16:00:00.000Z");
    const directory = await mkdtemp(resolve(tmpdir(), "podium-monitor-corrupt-"));
    const path = resolve(directory, "latest.json");
    const snapshot = buildPodiumSnapshot({
      rankings,
      convictionWallet: CONVICTION,
      observedAt: new Date(now).toISOString(),
    });
    await savePodiumSnapshot(path, snapshot);
    const corrupted = { ...snapshot, thirdPlacePnlTst: snapshot.thirdPlacePnlTst - 1000 };
    await writeFile(path, `${JSON.stringify(corrupted)}\n`, { mode: 0o600 });
    await expect(loadFreshPodiumSnapshot(path, now, 30_000, CONVICTION)).rejects.toThrow(
      /third-place PnL/u,
    );
  });
});
