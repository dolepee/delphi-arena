import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { sendAlert } from "../alerts.js";
import { loadPolicy, stateDirectory } from "../config.js";
import { client, assertSignerIdentity } from "../delphi.js";
import { ExitLedger } from "../exit-ledger.js";
import { TradeLedger } from "../ledger.js";
import {
  evaluateReliability,
  loadJsonFile,
  parseSystemdShow,
  savePrivateJson,
  type ReliabilityBaseline,
} from "../reliability-monitor.js";
import { readBook } from "../runtime.js";

const execFileAsync = promisify(execFile);

interface SourceObservationFile {
  observedAt?: string;
  observations?: Array<{ marketId?: string; ok?: boolean }>;
}

interface OpportunitiesFile {
  markets?: Array<{ marketId?: string; resultCapableOutcomes?: number[] }>;
}

interface AlertState {
  version: 1;
  activeCodes: string[];
  observedAt: string;
}

async function main(): Promise<void> {
  await assertSignerIdentity();
  const now = Date.now();
  const directory = stateDirectory();
  const policyPath = resolve(process.env.DELPHI_POLICY_PATH?.trim() || "config/policy.json");
  const sourcePath = resolve(directory, "latest-source-observations.json");
  const opportunitiesPath = resolve("config/opportunities.json");
  const [policy, book, systemd, sourceFile, opportunitiesFile, policyBody] = await Promise.all([
    loadPolicy(),
    readBook(client),
    execFileAsync("systemctl", [
      "show",
      "delphi-event.service",
      "delphi-event.timer",
      "delphi-opportunities.service",
      "delphi-opportunities.timer",
      "--property=Id,ActiveState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,InactiveEnterTimestamp",
      "--no-pager",
    ]),
    loadJsonFile<SourceObservationFile>(sourcePath),
    loadJsonFile<OpportunitiesFile>(opportunitiesPath),
    readFile(policyPath),
  ]);
  const releaseTarget = await readlink(process.env.DELPHI_RELEASE_LINK?.trim() || "/opt/delphi-arena/current");
  const policyHash = createHash("sha256").update(policyBody).digest("hex");
  const baselinePath = resolve(directory, "reliability-baseline.json");
  let baseline = await loadJsonFile<ReliabilityBaseline>(baselinePath);
  if (!baseline) {
    baseline = { version: 1, releaseTarget, policyHash, recordedAt: new Date(now).toISOString() };
    await savePrivateJson(baselinePath, baseline);
  }
  const tradeLedger = new TradeLedger(resolve(directory, "trade-ledger.json"));
  const exitLedger = new ExitLedger(resolve(directory, "exit-ledger.json"));
  const [pendingTrade, pendingExit] = await Promise.all([tradeLedger.pending(), exitLedger.pending()]);
  const healthyMarketIds = new Set(
    (sourceFile?.observations ?? [])
      .filter((item) => item.ok === true && typeof item.marketId === "string")
      .map((item) => item.marketId!.toLowerCase()),
  );
  const resultCapableMarketIds = (opportunitiesFile?.markets ?? [])
    .filter((market) => (market.resultCapableOutcomes?.length ?? 0) > 0 && typeof market.marketId === "string")
    .map((market) => market.marketId!);
  const issues = evaluateReliability({
    now,
    services: parseSystemdShow(systemd.stdout),
    sourceState: {
      observedAt: sourceFile?.observedAt ? Date.parse(sourceFile.observedAt) : null,
      healthyMarketIds,
    },
    resultCapableMarketIds,
    pendingTradeId: pendingTrade?.decisionId ?? null,
    pendingExitId: pendingExit?.decisionId ?? null,
    gasEth: book.gasEth,
    minimumGasEth: policy.minimumGasEth,
    releaseTarget,
    policyHash,
    baseline,
  });

  const alertStatePath = resolve(directory, "reliability-alerts.json");
  const previousAlerts = await loadJsonFile<AlertState>(alertStatePath);
  const previousCodes = new Set(previousAlerts?.activeCodes ?? []);
  const newIssues = issues.filter((issue) => !previousCodes.has(issue.code));
  let reliabilityAlertSent = false;
  if (newIssues.length > 0) {
    reliabilityAlertSent = await sendAlert(
      "RELIABILITY",
      newIssues.map((issue) => `${issue.code}\n${issue.detail}`).join("\n\n"),
    );
  }
  if (newIssues.length === 0 || reliabilityAlertSent) {
    await savePrivateJson(alertStatePath, {
      version: 1,
      activeCodes: issues.map((issue) => issue.code).sort(),
      observedAt: new Date(now).toISOString(),
    } satisfies AlertState);
  }

  const fundingMarkerPath = resolve(directory, "funding-alert.json");
  const fundingMarker = await loadJsonFile<{ alerted?: boolean }>(fundingMarkerPath);
  const funded = book.totalEquityTst >= policy.minimumStartingTst;
  let fundingAlertSent = false;
  if (funded && fundingMarker?.alerted !== true) {
    fundingAlertSent = await sendAlert(
      "ORGANIZER FUNDING DETECTED",
      `${book.totalEquityTst.toFixed(6)} TST is visible for the registered wallet.`,
    );
    if (fundingAlertSent) {
      await savePrivateJson(fundingMarkerPath, {
        alerted: true,
        observedAt: new Date(now).toISOString(),
        totalEquityTst: book.totalEquityTst,
      });
    }
  }

  process.stdout.write(`${JSON.stringify({
    status: issues.length === 0 ? "RELIABILITY_OK" : "RELIABILITY_ISSUES",
    issues,
    reliabilityAlertSent,
    fundingAlertSent,
    funded,
    totalEquityTst: book.totalEquityTst,
    gasEth: book.gasEth,
    openMarkets: book.markets.length,
    positions: book.positions.length,
    releaseTarget,
    policyHash,
  }, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  await sendAlert("RELIABILITY MONITOR FAILED", detail);
  process.stderr.write(`${detail}\n`);
  process.exitCode = 1;
}
