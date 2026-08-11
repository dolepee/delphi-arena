import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liveConfirmation } from "../src/config.js";
import { activationMode } from "../src/runtime.js";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("staged activation lock", () => {
  it("stays disabled unless live writes are explicitly enabled", async () => {
    process.env.DELPHI_LIVE_ENABLED = "false";
    expect(await activationMode()).toBe("disabled");
  });

  it("rejects an incorrect live confirmation", async () => {
    process.env.DELPHI_LIVE_ENABLED = "true";
    process.env.DELPHI_LIVE_CONFIRMATION = "wrong";
    await expect(activationMode()).rejects.toThrow("confirmation");
  });

  it("requires canary approval, then blocks full live until separately approved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "delphi-state-"));
    process.env.DELPHI_STATE_DIR = directory;
    process.env.DELPHI_LIVE_ENABLED = "true";
    process.env.DELPHI_LIVE_CONFIRMATION = liveConfirmation();
    await expect(activationMode()).rejects.toThrow("canary is not approved");
    await writeFile(join(directory, "canary-approved.json"), "{}\n");
    expect(await activationMode()).toBe("canary");
    await writeFile(join(directory, "canary-complete.json"), "{}\n");
    await expect(activationMode()).rejects.toThrow("full-live approval");
    await writeFile(join(directory, "full-live-approved.json"), "{}\n");
    expect(await activationMode()).toBe("full");
  });
});
