import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const sharedLock = "/var/lib/delphi-arena/write.lock";

describe("production systemd units", () => {
  it("serializes cycle, position management, and settlement writers through the same lock", async () => {
    const [cycle, manage, settle] = await Promise.all([
      readFile(new URL("../deploy/delphi-cycle.service", import.meta.url), "utf8"),
      readFile(new URL("../deploy/delphi-manage.service", import.meta.url), "utf8"),
      readFile(new URL("../deploy/delphi-settle.service", import.meta.url), "utf8"),
    ]);

    expect(cycle).toContain(`/usr/bin/flock -n -E 0 ${sharedLock}`);
    expect(manage).toContain(`/usr/bin/flock -w 20 -E 0 ${sharedLock}`);
    expect(settle).toContain(`/usr/bin/flock -w 20 -E 0 ${sharedLock}`);

    for (const unit of [cycle, manage, settle]) {
      expect(unit).toContain("ReadWritePaths=/var/lib/delphi-arena");
    }
  });

  it("runs position management after the settlement sweep", async () => {
    const timer = await readFile(
      new URL("../deploy/delphi-manage.timer", import.meta.url),
      "utf8",
    );
    expect(timer).toContain("OnCalendar=*-*-* *:*:45");
    expect(timer).toContain("AccuracySec=1s");
    expect(timer).toContain("Persistent=false");
  });

  it("sweeps terminal positions every minute without catch-up bursts", async () => {
    const timer = await readFile(
      new URL("../deploy/delphi-settle.timer", import.meta.url),
      "utf8",
    );

    expect(timer).toContain("OnCalendar=*-*-* *:*:30");
    expect(timer).toContain("AccuracySec=1s");
    expect(timer).toContain("Persistent=false");
  });
});
