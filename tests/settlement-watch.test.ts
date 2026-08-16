import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  SETTLEMENT_ALERT_GRACE_MS,
  awaitingSettlementIsOverdue,
  loadAlertedSettlementMarkets,
  saveAlertedSettlementMarkets,
  settlementStartsAt,
} from "../src/settlement-watch.js";

describe("settlement watch", () => {
  it("parses the organizer settlement start from object or serialized metadata", () => {
    const value = "2026-08-17T02:00:00.000Z";
    expect(settlementStartsAt({ settlement_starts: value })).toBe(Date.parse(value));
    expect(settlementStartsAt(JSON.stringify({ settlement_starts: value }))).toBe(Date.parse(value));
    expect(settlementStartsAt({ settlement_starts: "not-a-date" })).toBeNull();
  });

  it("waits through the settlement window and one-hour operational grace period", () => {
    const startsAt = Date.parse("2026-08-17T02:00:00.000Z");
    expect(awaitingSettlementIsOverdue({
      chainStatus: "awaiting_settlement",
      settlementStartsAt: startsAt,
      now: startsAt + SETTLEMENT_ALERT_GRACE_MS,
    })).toBe(false);
    expect(awaitingSettlementIsOverdue({
      chainStatus: "awaiting_settlement",
      settlementStartsAt: startsAt,
      now: startsAt + SETTLEMENT_ALERT_GRACE_MS + 1,
    })).toBe(true);
  });

  it("never flags a terminal market or metadata without a valid start", () => {
    expect(awaitingSettlementIsOverdue({
      chainStatus: "settled",
      settlementStartsAt: Date.now() - 10_000_000,
      now: Date.now(),
    })).toBe(false);
    expect(awaitingSettlementIsOverdue({
      chainStatus: "awaiting_settlement",
      settlementStartsAt: null,
      now: Date.now(),
    })).toBe(false);
  });

  it("persists normalized market ids for deduplicated alerts", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "delphi-settlement-watch-"));
    const path = resolve(directory, "nested", "alerts.json");
    try {
      expect(await loadAlertedSettlementMarkets(path)).toEqual(new Set());
      await saveAlertedSettlementMarkets(path, ["0xAbC", "0xDEF"]);
      expect(await loadAlertedSettlementMarkets(path)).toEqual(new Set(["0xabc", "0xdef"]));
      const stored = JSON.parse(await readFile(path, "utf8")) as { version: number; marketIds: string[] };
      expect(stored.version).toBe(1);
      expect(stored.marketIds).toEqual(["0xabc", "0xdef"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
