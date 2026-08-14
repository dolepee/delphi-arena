import { client, assertSignerIdentity } from "../delphi.js";
import { runTradingCycle } from "../engine.js";
import { sendAlert } from "../alerts.js";
import { stringifyJson } from "../json.js";

try {
  await assertSignerIdentity();
  const result = await runTradingCycle(client);
  process.stdout.write(`${stringifyJson(result, 2)}\n`);
} catch (error) {
  await sendAlert("CYCLE FAILURE", String(error));
  throw error;
}
