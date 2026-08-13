import { client, assertSignerIdentity } from "../delphi.js";
import { runPositionManagementCycle } from "../position-manager.js";

await assertSignerIdentity();
const result = await runPositionManagementCycle(client);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
