import { resolve } from "node:path";
import { sendAlert } from "../alerts.js";
import { stateDirectory } from "../config.js";
import { client, assertSignerIdentity } from "../delphi.js";
import { loadOpportunities } from "../opportunity-audit.js";
import {
  loadPreviouslyUnclassified,
  saveUnclassified,
  unclassifiedMarkets,
} from "../opportunity-monitor.js";
import { readBook } from "../runtime.js";

await assertSignerIdentity();
const [book, definitions] = await Promise.all([
  readBook(client),
  loadOpportunities(resolve("config/opportunities.json")),
]);
const markerPath = resolve(stateDirectory(), "unclassified-markets.json");
const previous = await loadPreviouslyUnclassified(markerPath);
const unclassified = unclassifiedMarkets(book.markets, definitions);
const newListings = unclassified.filter((market) => !previous.has(market.id.toLowerCase()));
let alertSent = false;
if (newListings.length > 0) {
  alertSent = await sendAlert(
    "UNCLASSIFIED MARKET - ABSTAINING",
    newListings.map((market) => `${market.question}\n${market.id}\ncloses ${market.resolvesAt ?? "unknown"}`).join("\n\n"),
  );
}
if (newListings.length === 0 || alertSent) {
  await saveUnclassified(markerPath, unclassified.map((market) => market.id));
}
process.stdout.write(`${JSON.stringify({
  status: unclassified.length === 0 ? "ALL_CLASSIFIED" : "ABSTAINING_UNCLASSIFIED",
  unclassified: unclassified.map((market) => ({
    marketId: market.id,
    question: market.question,
    tradingClosesAt: market.resolvesAt,
  })),
  newListings: newListings.map((market) => market.id),
  alertSent,
}, null, 2)}\n`);
