import { resolve } from "node:path";
import { loadPolicy } from "../config.js";
import { client, assertSignerIdentity } from "../delphi.js";
import { auditOpportunities, loadOpportunities } from "../opportunity-audit.js";
import { readBook } from "../runtime.js";

await assertSignerIdentity();
const [book, policy, definitions] = await Promise.all([
  readBook(client),
  loadPolicy(),
  loadOpportunities(resolve("config/opportunities.json")),
]);
const result = await auditOpportunities({ client, book, policy, definitions });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.unclassifiedMarketIds.length > 0) process.exitCode = 1;
