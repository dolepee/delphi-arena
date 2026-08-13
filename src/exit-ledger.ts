import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Assessment } from "./model.js";

const exitRecordSchema = z.object({
  decisionId: z.string().length(64),
  marketId: z.string(),
  outcomeIndex: z.number().int().nonnegative(),
  shares: z.number().positive(),
  quotedProceedsTst: z.number().nonnegative(),
  minimumProceedsTst: z.number().nonnegative(),
  reason: z.enum(["EVIDENCE_FLIP", "PROFIT_TAKE", "OPPORTUNITY_ROTATION"]),
  assessmentObservedAt: z.string().datetime().optional(),
  assessmentFingerprint: z.string().length(64).optional(),
  rotationDestinationMarketId: z.string().optional(),
  rotationDestinationOutcomeIndex: z.number().int().nonnegative().optional(),
  rotationDestinationAssessmentFingerprint: z.string().length(64).optional(),
  rotationDestinationExpiresAt: z.string().datetime().optional(),
  status: z.enum(["PREPARED", "CONFIRMED"]),
  createdAt: z.number().int().nonnegative(),
  transactionHash: z.string().optional(),
});

const exitStateSchema = z.object({ version: z.literal(1), records: z.array(exitRecordSchema) });
export type ExitRecord = z.infer<typeof exitRecordSchema>;

export class ExitLedger {
  constructor(private readonly path: string) {}

  private async read() {
    try {
      return exitStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 as const, records: [] };
      throw error;
    }
  }

  private async write(state: z.infer<typeof exitStateSchema>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  async records(): Promise<ExitRecord[]> {
    return (await this.read()).records;
  }

  async pending(): Promise<ExitRecord | null> {
    return (await this.read()).records.find((record) => record.status === "PREPARED") ?? null;
  }

  async get(decisionId: string): Promise<ExitRecord | null> {
    return (await this.read()).records.find((record) => record.decisionId === decisionId) ?? null;
  }

  async prepare(record: Omit<ExitRecord, "status" | "transactionHash">): Promise<void> {
    const state = await this.read();
    if (state.records.some((item) => item.decisionId === record.decisionId)) return;
    if (state.records.some((item) => item.status === "PREPARED")) {
      throw new Error("a previous exit intent is unresolved");
    }
    state.records.push({ ...record, status: "PREPARED" });
    await this.write(state);
  }

  async confirm(decisionId: string, transactionHash: string): Promise<void> {
    const state = await this.read();
    const record = state.records.find((item) => item.decisionId === decisionId);
    if (!record) throw new Error("exit intent is missing");
    record.status = "CONFIRMED";
    record.transactionHash = transactionHash;
    await this.write(state);
  }
}

export function assessmentEvidenceFingerprint(
  assessment: Pick<Assessment, "marketId" | "outcomeIndex" | "evidenceClass" | "sources">,
): string {
  return createHash("sha256").update(JSON.stringify({
    marketId: assessment.marketId.toLowerCase(),
    outcomeIndex: assessment.outcomeIndex,
    evidenceClass: assessment.evidenceClass,
    sources: assessment.sources
      .map((source) => [source.url, source.kind, source.valueHash])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  })).digest("hex");
}

export function blocksEntryForAssessment(
  exits: ExitRecord[],
  marketId: string,
  outcomeIndex: number,
  assessmentFingerprint: string,
): boolean {
  return exits.some((record) =>
    record.status === "CONFIRMED" &&
    record.marketId.toLowerCase() === marketId.toLowerCase() &&
    record.outcomeIndex === outcomeIndex &&
    record.assessmentFingerprint === assessmentFingerprint
  );
}

export function pendingRotationDestination(
  exits: ExitRecord[],
  buys: Array<{
    status: "PREPARED" | "CONFIRMED";
    createdAt: number;
    marketId: string;
    outcomeIndex: number;
    assessmentFingerprint?: string | undefined;
  }>,
  now: number,
): { marketId: string; outcomeIndex: number; assessmentFingerprint: string } | null {
  const rotation = exits
    .filter((record) =>
      record.status === "CONFIRMED" &&
      record.reason === "OPPORTUNITY_ROTATION" &&
      record.rotationDestinationMarketId
    )
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  if (
    !rotation?.rotationDestinationMarketId ||
    rotation.rotationDestinationOutcomeIndex === undefined ||
    !rotation.rotationDestinationAssessmentFingerprint
  ) return null;
  const expiresAt = rotation.rotationDestinationExpiresAt
    ? Date.parse(rotation.rotationDestinationExpiresAt)
    : rotation.createdAt + 10 * 60_000;
  if (now >= expiresAt) return null;
  const replacementAlreadyBought = buys.some((record) =>
    record.status === "CONFIRMED" &&
    record.createdAt > rotation.createdAt &&
    record.marketId.toLowerCase() === rotation.rotationDestinationMarketId!.toLowerCase() &&
    record.outcomeIndex === rotation.rotationDestinationOutcomeIndex &&
    record.assessmentFingerprint === rotation.rotationDestinationAssessmentFingerprint
  );
  return replacementAlreadyBought ? null : {
    marketId: rotation.rotationDestinationMarketId,
    outcomeIndex: rotation.rotationDestinationOutcomeIndex,
    assessmentFingerprint: rotation.rotationDestinationAssessmentFingerprint,
  };
}
