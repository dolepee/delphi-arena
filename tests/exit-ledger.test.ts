import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessmentEvidenceFingerprint, blocksEntryForAssessment, ExitLedger, pendingRotationDestination } from "../src/exit-ledger.js";

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

  it("blocks immediate re-entry while refreshed evidence has the same content", () => {
    const assessment = {
      marketId: "0x1111111111111111111111111111111111111111",
      outcomeIndex: 0,
      evidenceClass: "published_result" as const,
      sources: [{
        url: "https://example.com/result",
        kind: "authoritative" as const,
        observedAt: "2026-08-13T20:00:00.000Z",
        valueHash: "a".repeat(64),
      }],
    };
    const fingerprint = assessmentEvidenceFingerprint(assessment);
    const exits = [{
      decisionId: "a".repeat(64), marketId: assessment.marketId, outcomeIndex: 0,
      shares: 10, quotedProceedsTst: 8, minimumProceedsTst: 7.84,
      reason: "PROFIT_TAKE" as const, status: "CONFIRMED" as const, createdAt: 1,
      transactionHash: `0x${"b".repeat(64)}`, assessmentFingerprint: fingerprint,
    }];
    expect(blocksEntryForAssessment(exits, assessment.marketId, 0, fingerprint)).toBe(true);
    expect(blocksEntryForAssessment(exits, assessment.marketId, 1, fingerprint)).toBe(false);
    expect(assessmentEvidenceFingerprint({
      ...assessment,
      sources: [{ ...assessment.sources[0]!, observedAt: "2026-08-13T20:05:00.000Z" }],
    })).toBe(fingerprint);
    const secondSource = {
      url: "https://example.com/second", kind: "authoritative" as const,
      observedAt: "2026-08-13T20:00:00.000Z", valueHash: "b".repeat(64),
    };
    expect(assessmentEvidenceFingerprint({
      ...assessment,
      sources: [assessment.sources[0]!, secondSource],
    })).toBe(assessmentEvidenceFingerprint({
      ...assessment,
      sources: [secondSource, assessment.sources[0]!],
    }));
    expect(blocksEntryForAssessment(exits, assessment.marketId, 0, "c".repeat(64))).toBe(false);
  });

  it("binds the next confirmed buy to a recorded rotation destination", () => {
    const exits = [{
      decisionId: "a".repeat(64), marketId: "0x1111111111111111111111111111111111111111",
      outcomeIndex: 0, shares: 10, quotedProceedsTst: 8, minimumProceedsTst: 7.84,
      reason: "OPPORTUNITY_ROTATION" as const, status: "CONFIRMED" as const, createdAt: 10,
      transactionHash: `0x${"b".repeat(64)}`,
      rotationDestinationMarketId: "0x2222222222222222222222222222222222222222",
      rotationDestinationOutcomeIndex: 1,
      rotationDestinationAssessmentFingerprint: "c".repeat(64),
      rotationDestinationExpiresAt: "2026-08-13T20:10:00.000Z",
    }];
    const beforeExpiry = Date.parse("2026-08-13T20:09:59.999Z");
    expect(pendingRotationDestination(exits, [], beforeExpiry)).toEqual({
      marketId: exits[0]!.rotationDestinationMarketId,
      outcomeIndex: 1,
      assessmentFingerprint: "c".repeat(64),
    });
    expect(pendingRotationDestination(exits, [], beforeExpiry + 1)).toBeNull();
    expect(pendingRotationDestination(
      exits,
      [{
        status: "CONFIRMED", createdAt: 11,
        marketId: exits[0]!.rotationDestinationMarketId!, outcomeIndex: 1,
        assessmentFingerprint: "c".repeat(64),
      }],
      beforeExpiry,
    )).toBeNull();
  });
});
