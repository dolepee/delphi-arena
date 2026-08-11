import { client, assertSignerIdentity } from "../delphi.js";
import { stateDirectory } from "../config.js";
import { readBook } from "../runtime.js";
import { observeSources } from "../source-monitor.js";

await assertSignerIdentity();
const book = await readBook(client);
const observations = await observeSources(book.markets, stateDirectory());
process.stdout.write(`${JSON.stringify({
  status: "SOURCES_OBSERVED",
  total: observations.length,
  healthy: observations.filter((item) => item.ok).length,
  failed: observations.filter((item) => !item.ok).length,
}, null, 2)}\n`);
