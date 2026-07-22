import { z } from "zod"

export const QualityPredicateSchema = z
  .object({
    id: z.enum(["outcome", "scope_safety", "evidence_cleanup", "bounded_process"]),
    passed: z.boolean(),
    hard: z.boolean(),
  })
  .strict()
export type QualityPredicate = z.infer<typeof QualityPredicateSchema>

const qualityPredicatesSchema = z
  .array(QualityPredicateSchema)
  .length(4)
  .superRefine((predicates, context) => {
    const ids = predicates.map((predicate) => predicate.id)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "quality predicates must be unique" })
    }
    if (
      !predicates.some((predicate) => predicate.id === "outcome" && predicate.hard) ||
      !predicates.some((predicate) => predicate.id === "scope_safety" && predicate.hard)
    ) {
      context.addIssue({ code: "custom", message: "outcome and scope safety must be hard" })
    }
  })

export const QualityScoreSchema = z
  .object({
    version: z.literal(1),
    score: z.number().int().min(0).max(100),
    hardGatePassed: z.boolean(),
  })
  .strict()
  .superRefine((score, context) => {
    if (!score.hardGatePassed && score.score !== 0) {
      context.addIssue({ code: "custom", message: "hard gate failure forces zero score" })
    }
  })
export type QualityScore = z.infer<typeof QualityScoreSchema>

const weights = {
  outcome: 60,
  scope_safety: 20,
  evidence_cleanup: 10,
  bounded_process: 10,
} as const

export function calculateQualityScore(value: unknown): QualityScore {
  const predicates = qualityPredicatesSchema.parse(value)
  const hardGatePassed = predicates.every((predicate) => !predicate.hard || predicate.passed)
  if (!hardGatePassed) return { version: 1, score: 0, hardGatePassed: false }
  return {
    version: 1,
    score: predicates.reduce(
      (total, predicate) => total + (predicate.passed ? weights[predicate.id] : 0),
      0,
    ),
    hardGatePassed: true,
  }
}
