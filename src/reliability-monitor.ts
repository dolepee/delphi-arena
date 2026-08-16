import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ServiceState {
  id: string;
  activeState: string;
  result: string;
  execMainStatus: number;
  execMainStartAt: number | null;
  execMainExitAt: number | null;
  inactiveEnterAt: number | null;
}

export interface SourceState {
  observedAt: number | null;
  healthyMarketIds: Set<string>;
}

export interface ReliabilityBaseline {
  version: 1;
  releaseTarget: string;
  policyHash: string;
  recordedAt: string;
}

export interface ReliabilityIssue {
  code: string;
  detail: string;
}

export function batchReliabilityIssues(
  issues: ReliabilityIssue[],
  maximumLength = 3_600,
): ReliabilityIssue[][] {
  const batches: ReliabilityIssue[][] = [];
  let current: ReliabilityIssue[] = [];
  let currentLength = 0;
  for (const issue of issues) {
    const renderedLength = `${issue.code}\n${issue.detail}`.length;
    if (renderedLength > maximumLength) {
      throw new Error(`reliability issue ${issue.code} exceeds alert limit`);
    }
    const separatorLength = current.length > 0 ? 2 : 0;
    if (current.length > 0 && currentLength + separatorLength + renderedLength > maximumLength) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(issue);
    currentLength += (current.length > 1 ? 2 : 0) + renderedLength;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function latestTimestamp(state: ServiceState): number | null {
  const values = [state.execMainExitAt, state.inactiveEnterAt]
    .filter((value): value is number => value !== null);
  if (state.activeState === "activating" && state.execMainStartAt !== null) {
    values.push(state.execMainStartAt);
  }
  return values.length > 0 ? Math.max(...values) : null;
}

export function parseSystemdTimestamp(value: string | undefined): number | null {
  if (!value || value === "n/a") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function parseSystemdShow(output: string): Map<string, ServiceState> {
  const states = new Map<string, ServiceState>();
  for (const block of output.trim().split(/\n\s*\n/u)) {
    if (!block.trim()) continue;
    const values = new Map(block.split("\n").flatMap((line) => {
      const separator = line.indexOf("=");
      return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)] as const];
    }));
    const id = values.get("Id");
    if (!id) continue;
    states.set(id, {
      id,
      activeState: values.get("ActiveState") ?? "unknown",
      result: values.get("Result") ?? "unknown",
      execMainStatus: Number(values.get("ExecMainStatus") ?? "-1"),
      execMainStartAt: parseSystemdTimestamp(values.get("ExecMainStartTimestamp")),
      execMainExitAt: parseSystemdTimestamp(values.get("ExecMainExitTimestamp")),
      inactiveEnterAt: parseSystemdTimestamp(values.get("InactiveEnterTimestamp")),
    });
  }
  return states;
}

export function evaluateReliability(input: {
  now: number;
  services: Map<string, ServiceState>;
  sourceState: SourceState;
  resultCapableMarketIds: string[];
  pendingTradeId: string | null;
  pendingExitId: string | null;
  gasEth: number;
  minimumGasEth: number;
  releaseTarget: string;
  policyHash: string;
  baseline: ReliabilityBaseline;
}): ReliabilityIssue[] {
  const issues: ReliabilityIssue[] = [];
  const checkUnit = (id: string, maximumAgeMs: number) => {
    const state = input.services.get(id);
    if (!state) {
      issues.push({ code: `unit_missing:${id}`, detail: `${id} is missing from systemd` });
      return;
    }
    if (state.result !== "success" || state.execMainStatus !== 0) {
      issues.push({ code: `unit_failed:${id}`, detail: `${id} result=${state.result} status=${state.execMainStatus}` });
      return;
    }
    const latest = latestTimestamp(state);
    if (latest === null || input.now - latest > maximumAgeMs) {
      issues.push({ code: `unit_stale:${id}`, detail: `${id} has no successful activity inside ${maximumAgeMs / 1_000}s` });
    }
  };
  const checkTimer = (id: string) => {
    const state = input.services.get(id);
    if (!state || state.activeState !== "active") {
      issues.push({ code: `timer_inactive:${id}`, detail: `${id} is ${state?.activeState ?? "missing"}` });
    }
  };
  checkTimer("delphi-event.timer");
  checkUnit("delphi-event.service", 60_000);
  checkTimer("delphi-opportunities.timer");
  checkUnit("delphi-opportunities.service", 180_000);

  if (input.resultCapableMarketIds.length > 0) {
    if (input.sourceState.observedAt === null || input.now - input.sourceState.observedAt > 10 * 60_000) {
      issues.push({ code: "source_observations_stale", detail: "authoritative source observations are older than ten minutes" });
    }
    for (const marketId of input.resultCapableMarketIds) {
      if (!input.sourceState.healthyMarketIds.has(marketId.toLowerCase())) {
        issues.push({ code: `source_unhealthy:${marketId.toLowerCase()}`, detail: `no healthy authoritative source for ${marketId}` });
      }
    }
  }
  if (input.pendingTradeId) {
    issues.push({ code: "pending_trade_intent", detail: `unresolved trade intent ${input.pendingTradeId}` });
  }
  if (input.pendingExitId) {
    issues.push({ code: "pending_exit_intent", detail: `unresolved exit intent ${input.pendingExitId}` });
  }
  if (input.gasEth < input.minimumGasEth) {
    issues.push({ code: "gas_below_reserve", detail: `${input.gasEth} ETH is below ${input.minimumGasEth} ETH` });
  }
  if (input.releaseTarget !== input.baseline.releaseTarget) {
    issues.push({ code: "release_drift", detail: `release changed from ${input.baseline.releaseTarget} to ${input.releaseTarget}` });
  }
  if (input.policyHash !== input.baseline.policyHash) {
    issues.push({ code: "policy_drift", detail: `policy hash changed from ${input.baseline.policyHash} to ${input.policyHash}` });
  }
  return issues;
}

export async function loadJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function savePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
