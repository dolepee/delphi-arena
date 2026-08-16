import { describe, expect, it } from "vitest";
import {
  batchReliabilityIssues,
  evaluateReliability,
  parseSystemdShow,
  type ReliabilityBaseline,
} from "../src/reliability-monitor.js";

const NOW = Date.parse("2026-08-16T22:20:00.000Z");
const BASELINE: ReliabilityBaseline = {
  version: 1,
  releaseTarget: "/opt/delphi-arena/releases/good",
  policyHash: "a".repeat(64),
  recordedAt: "2026-08-16T22:00:00.000Z",
};

const SYSTEMD = `Id=delphi-event.service
ActiveState=inactive
Result=success
ExecMainStatus=0
ExecMainStartTimestamp=Sun 2026-08-16 22:19:57 UTC
ExecMainExitTimestamp=Sun 2026-08-16 22:19:59 UTC
InactiveEnterTimestamp=Sun 2026-08-16 22:19:59 UTC

Id=delphi-event.timer
ActiveState=active
Result=success
ExecMainStatus=0
ExecMainStartTimestamp=
ExecMainExitTimestamp=
InactiveEnterTimestamp=

Id=delphi-opportunities.service
ActiveState=inactive
Result=success
ExecMainStatus=0
ExecMainStartTimestamp=Sun 2026-08-16 22:19:00 UTC
ExecMainExitTimestamp=Sun 2026-08-16 22:19:02 UTC
InactiveEnterTimestamp=Sun 2026-08-16 22:19:02 UTC

Id=delphi-opportunities.timer
ActiveState=active
Result=success
ExecMainStatus=0
ExecMainStartTimestamp=
ExecMainExitTimestamp=
InactiveEnterTimestamp=`;

function input() {
  return {
    now: NOW,
    services: parseSystemdShow(SYSTEMD),
    sourceState: {
      observedAt: NOW - 60_000,
      healthyMarketIds: new Set(["0xmarket"]),
    },
    resultCapableMarketIds: ["0xMarket"],
    pendingTradeId: null,
    pendingExitId: null,
    gasEth: 0.01,
    minimumGasEth: 0.001,
    releaseTarget: BASELINE.releaseTarget,
    policyHash: BASELINE.policyHash,
    baseline: BASELINE,
  };
}

describe("production reliability evaluation", () => {
  it("batches alerts without hiding issue codes beyond Telegram's limit", () => {
    const batches = batchReliabilityIssues([
      { code: "first", detail: "a".repeat(40) },
      { code: "second", detail: "b".repeat(40) },
      { code: "third", detail: "c".repeat(40) },
    ], 60);
    expect(batches.map((batch) => batch.map((issue) => issue.code)))
      .toEqual([["first"], ["second"], ["third"]]);
  });

  it("accepts fresh successful units, sources, ledgers, gas and deployment identity", () => {
    expect(evaluateReliability(input())).toEqual([]);
  });

  it("detects timer, service, source, intent, gas, release and policy failures", () => {
    const value = input();
    value.services.get("delphi-event.timer")!.activeState = "inactive";
    value.services.get("delphi-event.service")!.result = "exit-code";
    const issues = evaluateReliability({
      ...value,
      sourceState: { observedAt: NOW - 11 * 60_000, healthyMarketIds: new Set() },
      pendingTradeId: "trade-1",
      pendingExitId: "exit-1",
      gasEth: 0.0001,
      releaseTarget: "/opt/delphi-arena/releases/drift",
      policyHash: "b".repeat(64),
    });
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "timer_inactive:delphi-event.timer",
      "unit_failed:delphi-event.service",
      "source_observations_stale",
      "source_unhealthy:0xmarket",
      "pending_trade_intent:trade-1",
      "pending_exit_intent:exit-1",
      "gas_below_reserve",
      "release_drift",
      "policy_drift",
    ]));
  });

  it("detects a stalled successful event service after sixty seconds", () => {
    const value = input();
    const event = value.services.get("delphi-event.service")!;
    event.execMainExitAt = NOW - 60_001;
    event.inactiveEnterAt = NOW - 60_001;
    expect(evaluateReliability(value).map((issue) => issue.code))
      .toContain("unit_stale:delphi-event.service");
  });

  it("rejects future-dated service activity beyond the clock-skew allowance", () => {
    const future = input();
    const futureEvent = future.services.get("delphi-event.service")!;
    futureEvent.execMainExitAt = NOW + 60_001;
    futureEvent.inactiveEnterAt = NOW + 60_001;
    expect(evaluateReliability(future).map((issue) => issue.code))
      .toContain("unit_stale:delphi-event.service");

    const tolerated = input();
    const toleratedEvent = tolerated.services.get("delphi-event.service")!;
    toleratedEvent.execMainExitAt = NOW + 60_000;
    toleratedEvent.inactiveEnterAt = NOW + 60_000;
    expect(evaluateReliability(tolerated).map((issue) => issue.code))
      .not.toContain("unit_stale:delphi-event.service");
  });

  it("fails stale-source validation closed on an unparseable timestamp", () => {
    const value = input();
    value.sourceState.observedAt = Number.NaN;
    expect(evaluateReliability(value).map((issue) => issue.code))
      .toContain("source_observations_stale");
  });

  it("rejects future-dated observations beyond the clock-skew allowance", () => {
    const future = input();
    future.sourceState.observedAt = NOW + 60_001;
    expect(evaluateReliability(future).map((issue) => issue.code))
      .toContain("source_observations_stale");

    const tolerated = input();
    tolerated.sourceState.observedAt = NOW + 60_000;
    expect(evaluateReliability(tolerated).map((issue) => issue.code))
      .not.toContain("source_observations_stale");
  });
});
