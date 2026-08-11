import { client, assertSignerIdentity } from "../delphi.js";
import { runTradingCycle } from "../engine.js";
import { sendAlert } from "../alerts.js";

try {
  await assertSignerIdentity();
  const result = await runTradingCycle(client);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  await sendAlert("CYCLE FAILURE", String(error));
  throw error;
}
