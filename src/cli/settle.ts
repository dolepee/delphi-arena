import { client, assertSignerIdentity } from "../delphi.js";
import { assertMaintenanceReadiness, readBook } from "../runtime.js";
import { sendAlert } from "../alerts.js";

await assertSignerIdentity();
const book = await readBook(client);
await assertMaintenanceReadiness(book);
const results: unknown[] = [];
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
  }
}
if (results.length > 0) await sendAlert("SETTLEMENT", JSON.stringify(results));
process.stdout.write(`${JSON.stringify({ status: "SETTLEMENT_SWEEP", results }, null, 2)}\n`);
