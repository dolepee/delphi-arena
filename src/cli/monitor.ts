import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sendAlert } from "../alerts.js";
import { loadPolicy, stateDirectory } from "../config.js";
import { client, assertSignerIdentity } from "../delphi.js";
import { readBook } from "../runtime.js";

await assertSignerIdentity();
const [policy, book] = await Promise.all([loadPolicy(), readBook(client)]);
const directory = stateDirectory();
const markerPath = resolve(directory, "funding-alert.json");
let alreadyAlerted = false;
try {
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as { alerted: boolean };
  alreadyAlerted = marker.alerted === true;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const funded = book.totalEquityTst >= policy.minimumStartingTst;
let alertSent = false;
if (funded && !alreadyAlerted) {
  alertSent = await sendAlert(
    "ORGANIZER FUNDING DETECTED",
    `${book.totalEquityTst.toFixed(6)} TST is visible for the registered wallet. Writes remain disabled; evidence review and the approved 1 TST canary are still required.`,
  );
  if (alertSent) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${markerPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ alerted: true, observedAt: new Date().toISOString(), totalEquityTst: book.totalEquityTst }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, markerPath);
  }
}

process.stdout.write(`${JSON.stringify({
  status: "MONITORED",
  funded,
  alertSent,
  totalEquityTst: book.totalEquityTst,
  gasEth: book.gasEth,
  openMarkets: book.markets.length,
  positions: book.positions.length,
}, null, 2)}\n`);
