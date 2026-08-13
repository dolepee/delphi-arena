import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const recordSchema = z.object({
  decisionId: z.string().length(64),
  marketId: z.string(),
  outcomeIndex: z.number().int().nonnegative(),
  shares: z.number().positive(),
  quotedCostTst: z.number().positive(),
  maximumCostTst: z.number().positive().optional(),
  actualCostTst: z.number().positive().optional(),
  status: z.enum(["PREPARED", "CONFIRMED"]),
  createdAt: z.number().int().nonnegative(),
  transactionHash: z.string().optional(),
});

const stateSchema = z.object({ version: z.literal(1), records: z.array(recordSchema) });
export type TradeRecord = z.infer<typeof recordSchema>;

export class TradeLedger {
  constructor(private readonly path: string) {}

  private async read() {
    try {
      return stateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 as const, records: [] };
      throw error;
    }
  }

  private async write(state: z.infer<typeof stateSchema>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  async records(): Promise<TradeRecord[]> {
    return (await this.read()).records;
  }

  async pending(): Promise<TradeRecord | null> {
    return (await this.read()).records.find((record) => record.status === "PREPARED") ?? null;
  }

  async get(decisionId: string): Promise<TradeRecord | null> {
    return (await this.read()).records.find((record) => record.decisionId === decisionId) ?? null;
  }

  async prepare(record: Omit<TradeRecord, "status" | "transactionHash">): Promise<void> {
    const state = await this.read();
    if (state.records.some((item) => item.decisionId === record.decisionId)) return;
    if (state.records.some((item) => item.status === "PREPARED")) {
      throw new Error("a previous trade intent is unresolved");
    }
    state.records.push({ ...record, status: "PREPARED" });
    await this.write(state);
  }

  async confirm(decisionId: string, transactionHash: string): Promise<void> {
    const state = await this.read();
    const record = state.records.find((item) => item.decisionId === decisionId);
    if (!record) throw new Error("trade intent is missing");
    record.status = "CONFIRMED";
    record.transactionHash = transactionHash;
    await this.write(state);
  }

  async discardPrepared(decisionId: string): Promise<void> {
    const state = await this.read();
    const record = state.records.find((item) => item.decisionId === decisionId);
    if (!record) return;
    if (record.status !== "PREPARED") {
      throw new Error("only an unsubmitted trade intent can be discarded");
    }
    state.records = state.records.filter((item) => item.decisionId !== decisionId);
    await this.write(state);
  }
}
