import { describe, expect, it } from "vitest";
import { sourceUrls } from "../src/source-monitor.js";

describe("source URL extraction", () => {
  it("extracts and preserves nested official URLs", () => {
    expect(sourceUrls({ primary: ["https://example.com/a", { fallback: "https://example.com/b" }] }))
      .toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("supports JSON-encoded metadata without interpreting arbitrary text", () => {
    expect(sourceUrls('["https://example.com/a"]')).toEqual(["https://example.com/a"]);
    expect(sourceUrls("not JSON or a URL")).toEqual([]);
  });
});
