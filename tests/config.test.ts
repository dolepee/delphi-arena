import { afterEach, describe, expect, it } from "vitest";
import { eventExecutionEnabled } from "../src/config.js";

describe("event execution activation", () => {
  const original = process.env.DELPHI_EVENT_EXECUTION_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.DELPHI_EVENT_EXECUTION_ENABLED;
    else process.env.DELPHI_EVENT_EXECUTION_ENABLED = original;
  });

  it("fails closed unless explicitly enabled", () => {
    delete process.env.DELPHI_EVENT_EXECUTION_ENABLED;
    expect(eventExecutionEnabled()).toBe(false);
    process.env.DELPHI_EVENT_EXECUTION_ENABLED = "false";
    expect(eventExecutionEnabled()).toBe(false);
    process.env.DELPHI_EVENT_EXECUTION_ENABLED = "true";
    expect(eventExecutionEnabled()).toBe(true);
  });
});
