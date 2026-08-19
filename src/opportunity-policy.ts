import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Assessment } from "./model.js";

const opportunitySchema = z.object({
  marketId: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
  classification: z.enum(["result_capable", "partial_result", "forecast_only", "abstain"]),
  resultCapableOutcomes: z.array(z.number().int().nonnegative()),
  earliestDecisiveAt: z.string().datetime().nullable(),
  rationale: z.string().min(20),
}).strict().superRefine((definition, context) => {
  if (new Set(definition.resultCapableOutcomes).size !== definition.resultCapableOutcomes.length) {
    context.addIssue({
      code: "custom",
      path: ["resultCapableOutcomes"],
      message: "result-capable outcomes must be unique",
    });
  }
  const supportsDecisiveEvidence = definition.classification === "result_capable" ||
    definition.classification === "partial_result";
  if (supportsDecisiveEvidence && definition.resultCapableOutcomes.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["resultCapableOutcomes"],
      message: "result-capable classifications require at least one mapped outcome",
    });
  }
  if (supportsDecisiveEvidence && definition.earliestDecisiveAt === null) {
    context.addIssue({
      code: "custom",
      path: ["earliestDecisiveAt"],
      message: "result-capable classifications require a decisive timestamp",
    });
  }
  if (!supportsDecisiveEvidence && definition.resultCapableOutcomes.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["resultCapableOutcomes"],
      message: "forecast-only and abstain classifications cannot map decisive outcomes",
    });
  }
});

const opportunitiesSchema = z.object({
  version: z.literal(1),
  markets: z.array(opportunitySchema),
}).strict().superRefine((file, context) => {
  const seen = new Set<string>();
  for (const [index, definition] of file.markets.entries()) {
    const marketId = definition.marketId.toLowerCase();
    if (seen.has(marketId)) {
      context.addIssue({
        code: "custom",
        path: ["markets", index, "marketId"],
        message: "market classifications must be unique",
      });
    }
    seen.add(marketId);
  }
});

export type OpportunityDefinition = z.infer<typeof opportunitySchema>;

export async function loadOpportunities(path: string): Promise<OpportunityDefinition[]> {
  return opportunitiesSchema.parse(JSON.parse(await readFile(path, "utf8"))).markets;
}

export function isAssessmentAllowedByOpportunity(
  assessment: Assessment,
  definitions: OpportunityDefinition[],
): boolean {
  const definition = definitions.find((candidate) =>
    candidate.marketId.toLowerCase() === assessment.marketId.toLowerCase()
  );
  if (!definition) return false;
  switch (definition.classification) {
    case "abstain":
      return false;
    case "forecast_only":
      return assessment.evidenceClass === "forecast";
    case "result_capable":
    case "partial_result":
      break;
    default:
      return false;
  }
  // Forecasts do not claim that a decisive fact exists, so the decisive-outcome
  // map and timing gate apply only to the elevated schedule/result lanes.
  if (assessment.evidenceClass === "forecast") return true;
  if (!definition.resultCapableOutcomes.includes(assessment.outcomeIndex)) return false;
  if (definition.earliestDecisiveAt === null) return false;
  const observedAt = Date.parse(assessment.observedAt);
  const earliestDecisiveAt = Date.parse(definition.earliestDecisiveAt);
  return Number.isFinite(observedAt) && Number.isFinite(earliestDecisiveAt) &&
    observedAt >= earliestDecisiveAt;
}

export function allowedOpportunityAssessments(
  assessments: Assessment[],
  definitions: OpportunityDefinition[],
): Assessment[] {
  return assessments.filter((assessment) =>
    isAssessmentAllowedByOpportunity(assessment, definitions)
  );
}
