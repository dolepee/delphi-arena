import { z } from "zod";

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);

export const policySchema = z.object({
  competitionEndsAt: z.string().datetime(),
  minimumStartingTst: z.number().positive(),
  minimumGasEth: z.number().positive(),
  minimumNetEdge: z.number().positive().max(0.5),
  minimumPublishedResultNetEdge: z.number().positive().max(0.1),
  minimumOfficialScheduleNetEdge: z.number().positive().max(0.1),
  maximumMarketAllocationPct: z.number().positive().max(50),
  maximumPortfolioAllocationPct: z.number().positive().max(95),
  maximumOrderTst: z.number().positive(),
  maximumPublishedResultMarketAllocationPct: z.number().positive().max(95),
  maximumPublishedResultPortfolioAllocationPct: z.number().positive().max(95),
  maximumPublishedResultOrderTst: z.number().positive(),
  minimumFullOrderTst: z.number().positive().max(25),
  maximumPriceImpact: z.number().positive().max(0.2),
  maximumPublishedResultPriceImpact: z.number().positive().max(0.2),
  slippagePct: z.number().positive().max(5),
  exitSlippagePct: z.number().positive().max(5).optional(),
  minimumProfitTakeReturnPct: z.number().positive().max(50).optional(),
  maximumHoldEdgeForProfitTake: z.number().positive().max(0.2).optional(),
  minimumRotationEdgeAdvantage: z.number().positive().max(0.5).optional(),
  maximumNewTradesPerCycle: z.literal(1),
  minimumEvidenceSources: z.number().int().positive(),
  maximumAssessmentAgeMinutes: z.number().int().positive(),
  canaryMaximumTst: z.number().positive().max(5),
  qualificationFallback: z.literal("none"),
});

export type Policy = z.infer<typeof policySchema>;

export const evidenceSourceSchema = z.object({
  url: z.string().url(),
  kind: z.enum(["authoritative", "cross_market", "secondary"]),
  observedAt: z.string().datetime(),
  valueHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const assessmentSchema = z.object({
  marketId: addressSchema,
  outcomeIndex: z.number().int().nonnegative(),
  evidenceClass: z.enum(["forecast", "official_schedule", "published_result"]),
  probability: z.number().min(0.01).max(0.99),
  confidence: z.enum(["high", "medium", "low"]),
  status: z.enum(["actionable", "watch", "refuse"]),
  observedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  rationale: z.string().min(20).max(1_000),
  sources: z.array(evidenceSourceSchema),
});

export type Assessment = z.infer<typeof assessmentSchema>;

export const assessmentsFileSchema = z.object({
  version: z.literal(1),
  assessments: z.array(assessmentSchema),
});

export interface MarketView {
  id: `0x${string}`;
  question: string;
  outcomes: string[];
  status: string;
  resolvesAt: string | null;
  prices: number[];
  tradingFeePct: number;
  dataSources: unknown;
}

export interface PositionView {
  marketId: `0x${string}`;
  outcomeIndex: number;
  shares: number;
  markPrice: number;
}

export interface Candidate {
  assessment: Assessment;
  market: MarketView;
  spotPrice: number;
  rawEdge: number;
  existingMarketValue: number;
  existingMarketShares: number;
  existingPortfolioShares: number;
}

export interface QuotedPlan extends Candidate {
  shares: number;
  quotedCostTst: number;
  maximumCostTst: number;
  maximumCostAtomic: bigint;
  averagePrice: number;
  maximumAveragePrice: number;
  netEdge: number;
  priceImpact: number;
  worstCaseExpectedProfitTst: number;
  mode: "canary" | "full";
  decisionId: string;
}
