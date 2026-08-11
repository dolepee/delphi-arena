import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { client, assertSignerIdentity } from "../delphi.js";
import { stateDirectory } from "../config.js";
import { readBook } from "../runtime.js";

await assertSignerIdentity();
const book = await readBook(client);
const snapshot = {
  version: 1,
  observedAt: new Date().toISOString(),
  wallet: "0x86bE235Bb9Aa6D9E2Cf89b2f4E9c90e1ecb7C781",
  availableTst: book.availableTst,
  gasEth: book.gasEth,
  deployedValueTst: book.deployedValueTst,
  totalEquityTst: book.totalEquityTst,
  markets: book.markets,
  positions: book.positions,
};
await mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
const path = resolve(stateDirectory(), "latest-snapshot.json");
const temporary = `${path}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, path);
process.stdout.write(`${JSON.stringify({ status: "SNAPSHOT", ...snapshot }, null, 2)}\n`);
