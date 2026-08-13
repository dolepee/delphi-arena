import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExitLedger } from "../src/exit-ledger.js";

describe("exit ledger", () => {
  it("persists one exit intent, blocks overlap, and confirms it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "delphi-exit-ledger-"));
    const ledger = new ExitLedger(join(directory, "exit-ledger.json"));
    const record = {
      decisionId: "a".repeat(64),
      marketId: "0x1111111111111111111111111111111111111111",
      outcomeIndex: 0,
      shares: 10,
      quotedProceedsTst: 8,
      minimumProceedsTst: 7.84,
      reason: "OPPORTUNITY_ROTATION" as const,
      createdAt: 1,
    };
    await ledger.prepare(record);
    await expect(ledger.prepare({ ...record, decisionId: "b".repeat(64) })).rejects.toThrow("unresolved");
    await ledger.confirm(record.decisionId, `0x${"c".repeat(64)}`);
    expect(await ledger.pending()).toBeNull();
    expect((await ledger.get(record.decisionId))?.status).toBe("CONFIRMED");
  });
});
