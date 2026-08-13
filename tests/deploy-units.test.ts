import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const sharedLock = "/var/lib/delphi-arena/write.lock";

describe("production systemd units", () => {
  it("serializes cycle and settlement writers through the same lock", async () => {
    const [cycle, settle] = await Promise.all([
      readFile(new URL("../deploy/delphi-cycle.service", import.meta.url), "utf8"),
      readFile(new URL("../deploy/delphi-settle.service", import.meta.url), "utf8"),
    ]);

    for (const unit of [cycle, settle]) {
      expect(unit).toContain(`/usr/bin/flock -n -E 0 ${sharedLock}`);
      expect(unit).toContain("ReadWritePaths=/var/lib/delphi-arena");
    }
  });

  it("sweeps terminal positions every minute without catch-up bursts", async () => {
    const timer = await readFile(
      new URL("../deploy/delphi-settle.timer", import.meta.url),
      "utf8",
    );

    expect(timer).toContain("OnUnitActiveSec=1min");
    expect(timer).toContain("Persistent=false");
  });
});
