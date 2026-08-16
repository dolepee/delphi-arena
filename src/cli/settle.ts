import { client, assertSignerIdentity } from "../delphi.js";
import { assertMaintenanceReadiness, readBook } from "../runtime.js";
import { sendAlert } from "../alerts.js";
import { resolve } from "node:path";
import { stateDirectory } from "../config.js";
import {
  awaitingSettlementIsOverdue,
  loadAlertedSettlementMarkets,
  saveAlertedSettlementMarkets,
  settlementStartsAt,
} from "../settlement-watch.js";

await assertSignerIdentity();
const book = await readBook(client);
await assertMaintenanceReadiness(book);
const results: unknown[] = [];
const awaiting: Array<{
  marketAddress: string;
  question: string;
  settlementStartsAt: string | null;
  overdue: boolean;
}> = [];
const positionsByMarket = new Map<string, Set<number>>();
for (const position of book.rawPositions) {
  const key = position.marketProxy.toLowerCase();
  const outcomes = positionsByMarket.get(key) ?? new Set<number>();
  outcomes.add(Number(position.outcomeIdx));
  positionsByMarket.set(key, outcomes);
}
for (const [marketAddressValue, outcomeIndices] of positionsByMarket) {
  const marketAddress = marketAddressValue as `0x${string}`;
  const status = await client.getMarketStatus(marketAddress);
  if (status === "settled") {
    try {
      const result = await client.redeemMarket({ marketAddress });
      results.push({ action: "REDEEM", ...result });
    } catch (error) {
      results.push({ action: "REDEEM", marketAddress, error: String(error) });
    }
  } else if (status === "expired" || status === "failed") {
    try {
      const result = await client.liquidate({ marketAddress, outcomeIndices: [...outcomeIndices] });
      results.push({ action: "LIQUIDATE", ...result });
    } catch (error) {
      results.push({ action: "LIQUIDATE", marketAddress, error: String(error) });
    }
  } else if (status === "awaiting_settlement") {
    const market = book.rawMarkets.find((item) => item.id.toLowerCase() === marketAddressValue);
    const startsAt = settlementStartsAt(market?.metadata);
    awaiting.push({
      marketAddress,
      question: market?.metadata?.question ?? marketAddress,
      settlementStartsAt: startsAt === null ? null : new Date(startsAt).toISOString(),
      overdue: awaitingSettlementIsOverdue({
        chainStatus: status,
        settlementStartsAt: startsAt,
        now: Date.now(),
      }),
    });
  }
}
if (results.length > 0) await sendAlert("SETTLEMENT", JSON.stringify(results));
const markerPath = resolve(stateDirectory(), "settlement-overdue-alerts.json");
const alerted = await loadAlertedSettlementMarkets(markerPath);
const newlyOverdue = awaiting.filter((item) => item.overdue && !alerted.has(item.marketAddress.toLowerCase()));
const overdueAlertsSent: string[] = [];
for (const item of newlyOverdue) {
  const sent = await sendAlert(
    "SETTLEMENT OVERDUE",
    `${item.marketAddress}\nsettlement window started ${item.settlementStartsAt ?? "unknown"}\nstill awaiting on-chain\n${item.question}`,
  );
  if (!sent) continue;
  const normalizedMarketAddress = item.marketAddress.toLowerCase();
  alerted.add(normalizedMarketAddress);
  overdueAlertsSent.push(normalizedMarketAddress);
  await saveAlertedSettlementMarkets(markerPath, alerted);
}
process.stdout.write(`${JSON.stringify({
  status: "SETTLEMENT_SWEEP",
  results,
  awaiting,
  overdueAlertsSent,
}, null, 2)}\n`);
