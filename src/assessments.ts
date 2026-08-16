import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Assessment } from "./model.js";

export function selectEventAssessments(assessments: Assessment[]): Assessment[] {
  return assessments.filter((assessment) =>
    assessment.evidenceClass === "published_result" &&
    assessment.confidence === "high" &&
    assessment.probability === 0.99 &&
    assessment.status === "actionable"
  );
}

export async function saveAssessments(assessments: Assessment[]): Promise<void> {
  const path = resolve(process.env.DELPHI_ASSESSMENTS_PATH?.trim() || "config/assessments.json");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, assessments }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
