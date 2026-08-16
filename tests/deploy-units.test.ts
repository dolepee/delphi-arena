import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const sharedLock = "/var/lib/delphi-arena/write.lock";

describe("production systemd units", () => {
  it("serializes cycle, position management, and settlement writers through the same lock", async () => {
    const [assess, cycle, event, manage, settle] = await Promise.all([
      readFile(new URL("../deploy/delphi-assess.service", import.meta.url), "utf8"),
      readFile(new URL("../deploy/delphi-cycle.service", import.meta.url), "utf8"),
      readFile(new URL("../deploy/delphi-event.service", import.meta.url), "utf8"),
      readFile(new URL("../deploy/delphi-manage.service", import.meta.url), "utf8"),
      readFile(new URL("../deploy/delphi-settle.service", import.meta.url), "utf8"),
    ]);

    expect(assess).toContain(`/usr/bin/flock -w 20 -E 0 ${sharedLock}`);
    expect(cycle).toContain(`/usr/bin/flock -n -E 0 ${sharedLock}`);
    expect(event).toContain(`/usr/bin/flock -w 20 -E 0 ${sharedLock}`);
    expect(manage).toContain(`/usr/bin/flock -w 20 -E 0 ${sharedLock}`);
    expect(settle).toContain(`/usr/bin/flock -w 20 -E 0 ${sharedLock}`);

    for (const unit of [assess, cycle, event, manage, settle]) {
      expect(unit).toContain("ReadWritePaths=/var/lib/delphi-arena");
    }
  });

  it("runs the event cycle without randomized latency", async () => {
    const timer = await readFile(new URL("../deploy/delphi-event.timer", import.meta.url), "utf8");
    expect(timer).toContain("OnBootSec=10s");
    expect(timer).toContain("OnUnitActiveSec=15s");
    expect(timer).toContain("RandomizedDelaySec=0");
    expect(timer).toContain("AccuracySec=1s");
  });

  it("checks production reliability every minute without timer jitter", async () => {
    const timer = await readFile(new URL("../deploy/delphi-monitor.timer", import.meta.url), "utf8");
    expect(timer).toContain("OnUnitActiveSec=1min");
    expect(timer).toContain("RandomizedDelaySec=0");
    expect(timer).toContain("AccuracySec=5s");
  });

  it("checks newly listed markets every minute and fails them closed", async () => {
    const [service, timer] = await Promise.all([
      readFile(new URL("../deploy/delphi-opportunities.service", import.meta.url), "utf8"),
      readFile(new URL("../deploy/delphi-opportunities.timer", import.meta.url), "utf8"),
    ]);
    expect(service).toContain("npm run opportunity-monitor");
    expect(service).toContain("ReadWritePaths=/var/lib/delphi-arena");
    expect(timer).toContain("OnUnitActiveSec=1min");
    expect(timer).toContain("RandomizedDelaySec=0");
  });

  it("runs leaderboard intelligence independently from trading every four hours", async () => {
    const [service, timer] = await Promise.all([
      readFile(new URL("../deploy/delphi-leaderboard.service", import.meta.url), "utf8"),
      readFile(new URL("../deploy/delphi-leaderboard.timer", import.meta.url), "utf8"),
    ]);
    expect(service).toContain("npm run leaderboard-monitor");
    expect(service).not.toContain(sharedLock);
    expect(service).toContain("ReadWritePaths=/var/lib/delphi-arena");
    expect(timer).toContain("OnUnitActiveSec=4h");
    expect(timer).toContain("Persistent=true");
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
