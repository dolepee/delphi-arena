import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { client, assertSignerIdentity } from "../delphi.js";
import { generateOfficialAssessments } from "../official-assessors.js";
import { readBook } from "../runtime.js";

await assertSignerIdentity();
const book = await readBook(client);
const assessments = await generateOfficialAssessments(book.markets);
const path = resolve(process.env.DELPHI_ASSESSMENTS_PATH?.trim() || "config/assessments.json");
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
const temporary = `${path}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify({ version: 1, assessments }, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, path);
process.stdout.write(`${JSON.stringify({ status: "ASSESSED", assessments }, null, 2)}\n`);
