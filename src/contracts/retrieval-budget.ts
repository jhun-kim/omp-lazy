import { z } from "zod"
import { type TaskTier, TaskTierSchema, TierBudgets } from "./task-packet"

export const RetrievalBudgetSchema = z
  .object({
    version: z.literal(1),
    tier: TaskTierSchema,
    generalCalls: z.number().int().nonnegative(),
    retrievalCalls: z.number().int().nonnegative(),
    retrievalBytes: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((budget, context) => {
    const limits = TierBudgets[budget.tier]
    if (
      budget.generalCalls > limits.maxCalls ||
      budget.retrievalCalls > limits.maxRetrievalCalls ||
      budget.retrievalBytes > limits.maxRetrievalBytes
    ) {
      context.addIssue({ code: "custom", message: "retrieval budget exceeds tier limits" })
    }
  })
export type RetrievalBudget = z.infer<typeof RetrievalBudgetSchema>

export const RetrievalResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("delivered"),
      content: z
        .string()
        .min(1)
        .max(160 * 1024),
    })
    .strict(),
  z.object({ kind: z.literal("empty") }).strict(),
  z.object({ kind: z.literal("status") }).strict(),
])
export type RetrievalResult = z.infer<typeof RetrievalResultSchema>

export type RetrievalMeterResult =
  | { readonly ok: true; readonly budget: RetrievalBudget }
  | {
      readonly ok: false
      readonly code:
        | "malformed_retrieval_budget"
        | "malformed_retrieval_result"
        | "general_call_budget_exceeded"
        | "retrieval_call_budget_exceeded"
        | "retrieval_byte_budget_exceeded"
      readonly budget: RetrievalBudget
    }

export function createRetrievalBudget(tier: TaskTier): RetrievalBudget {
  return { version: 1, tier, generalCalls: 0, retrievalCalls: 0, retrievalBytes: 0 }
}

export function meterRetrievalResult(
  budgetValue: unknown,
  resultValue: unknown,
): RetrievalMeterResult {
  const budget = RetrievalBudgetSchema.safeParse(budgetValue)
  if (!budget.success) {
    return { ok: false, code: "malformed_retrieval_budget", budget: createRetrievalBudget("FAST") }
  }
  const result = RetrievalResultSchema.safeParse(resultValue)
  if (!result.success) return { ok: false, code: "malformed_retrieval_result", budget: budget.data }
  const limits = TierBudgets[budget.data.tier]
  if (budget.data.generalCalls + 1 > limits.maxCalls) {
    return { ok: false, code: "general_call_budget_exceeded", budget: budget.data }
  }
  if (result.data.kind !== "delivered") {
    return { ok: true, budget: { ...budget.data, generalCalls: budget.data.generalCalls + 1 } }
  }
  if (budget.data.retrievalCalls + 1 > limits.maxRetrievalCalls) {
    return { ok: false, code: "retrieval_call_budget_exceeded", budget: budget.data }
  }
  const retrievalBytes = budget.data.retrievalBytes + Buffer.byteLength(result.data.content, "utf8")
  if (retrievalBytes > limits.maxRetrievalBytes) {
    return { ok: false, code: "retrieval_byte_budget_exceeded", budget: budget.data }
  }
  return {
    ok: true,
    budget: {
      ...budget.data,
      generalCalls: budget.data.generalCalls + 1,
      retrievalCalls: budget.data.retrievalCalls + 1,
      retrievalBytes,
    },
  }
}
