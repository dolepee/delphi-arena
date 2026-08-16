import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { stringifyJson } from "../src/json.js";

describe("stringifyJson", () => {
  it("serializes nested bigint values without losing their exact value", () => {
    expect(stringifyJson({ plan: { maximumCostAtomic: 249_997_219n } }, 2))
      .toContain('"maximumCostAtomic": "249997219"');
  });

  it("uses the bigint-safe serializer for settlement alerts and output", async () => {
    const source = await readFile(new URL("../src/cli/settle.ts", import.meta.url), "utf8");
    expect(source).toContain('sendAlert("SETTLEMENT", stringifyJson(results))');
    expect(source).toContain("process.stdout.write(`${stringifyJson({");
  });

  it("captures reliability evaluation time after asynchronous state collection", async () => {
    const source = await readFile(new URL("../src/cli/monitor.ts", import.meta.url), "utf8");
    const systemdCollection = source.indexOf('const systemd = await execFileAsync("systemctl"');
    const evaluationTime = source.indexOf("const now = Date.now()", systemdCollection);
    const evaluation = source.indexOf("const issues = evaluateReliability({", evaluationTime);
    expect(systemdCollection).toBeGreaterThan(0);
    expect(evaluationTime).toBeGreaterThan(systemdCollection);
    expect(evaluation).toBeGreaterThan(evaluationTime);
  });
});
