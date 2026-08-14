import { describe, expect, it } from "vitest";
import { stringifyJson } from "../src/json.js";

describe("stringifyJson", () => {
  it("serializes nested bigint values without losing their exact value", () => {
    expect(stringifyJson({ plan: { maximumCostAtomic: 249_997_219n } }, 2))
      .toContain('"maximumCostAtomic": "249997219"');
  });
});
