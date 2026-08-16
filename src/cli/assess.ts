import { saveAssessments } from "../assessments.js";
import { client, assertSignerIdentity } from "../delphi.js";
import { generateOfficialAssessments } from "../official-assessors.js";
import { readBook } from "../runtime.js";

await assertSignerIdentity();
const book = await readBook(client);
const assessments = await generateOfficialAssessments(book.markets);
await saveAssessments(assessments);
process.stdout.write(`${JSON.stringify({ status: "ASSESSED", assessments }, null, 2)}\n`);
