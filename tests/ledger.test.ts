import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TradeLedger } from "../src/ledger.js";

describe("trade ledger", () => {
  it("persists one intent, blocks overlap, and confirms immutably", async () => {
    const directory = await mkdtemp(join(tmpdir(), "delphi-ledger-"));
    const ledger = new TradeLedger(join(directory, "ledger.json"));
    const record = {
      decisionId: "a".repeat(64),
      marketId: "0x1111111111111111111111111111111111111111",
      outcomeIndex: 0,
      shares: 1,
      quotedCostTst: 0.6,
      assessmentFingerprint: "d".repeat(64),
      assessmentProbability: 0.91,
      assessmentEvidenceClass: "forecast" as const,
      assessmentObservedAt: "2026-08-16T20:00:00.000Z",
      assessmentExpiresAt: "2026-08-16T20:10:00.000Z",
      createdAt: 1,
    };
    await ledger.prepare(record);
    await expect(ledger.prepare({ ...record, decisionId: "b".repeat(64) })).rejects.toThrow("unresolved");
    await ledger.confirm(record.decisionId, `0x${"c".repeat(64)}`);
    expect(await ledger.pending()).toBeNull();
    expect((await ledger.get(record.decisionId))?.status).toBe("CONFIRMED");
    expect((await ledger.get(record.decisionId))?.assessmentProbability).toBe(0.91);
  });
});

describe("prepared intent cleanup", () => {
  it("can discard an expired intent before submission but never a confirmed trade", async () => {
    const directory = await mkdtemp(join(tmpdir(), "delphi-ledger-discard-"));
    const ledger = new TradeLedger(join(directory, "ledger.json"));
    const record = {
      decisionId: "b".repeat(64),
      marketId: "0xmarket",
      outcomeIndex: 0,
      shares: 1,
      quotedCostTst: 0.5,
      createdAt: 1,
    };
    await ledger.prepare(record);
    await ledger.discardPrepared(record.decisionId);
    expect(await ledger.get(record.decisionId)).toBeNull();

    await ledger.prepare(record);
    await ledger.confirm(record.decisionId, "0xtx");
    await expect(ledger.discardPrepared(record.decisionId)).rejects.toThrow("only an unsubmitted");
  });
});
