import { describe, expect, test } from "bun:test"
import {
  createRetrievalBudget,
  meterRetrievalResult,
  RetrievalBudgetSchema,
} from "../../src/contracts/retrieval-budget"

describe("retrieval budget contract", () => {
  test("Given an empty or status result When metered Then general calls increase without consuming retrieval budget", () => {
    // Given
    const budget = createRetrievalBudget("FAST")

    // When
    const empty = meterRetrievalResult(budget, { kind: "empty" })
    const status = meterRetrievalResult(empty.budget, { kind: "status" })

    // Then
    expect(status).toMatchObject({
      ok: true,
      budget: { generalCalls: 2, retrievalCalls: 0, retrievalBytes: 0 },
    })
  })

  test("Given a nonempty delivered result When metered Then one call and UTF-8 bytes are charged", () => {
    // Given
    const budget = createRetrievalBudget("FAST")

    // When
    const result = meterRetrievalResult(budget, { kind: "delivered", content: "test" })

    // Then
    expect(result).toMatchObject({
      ok: true,
      budget: { generalCalls: 1, retrievalCalls: 1, retrievalBytes: 4 },
    })
  })

  test("Given exhausted retrieval capacity When metered Then the refusal code is stable", () => {
    // Given
    const exhausted = {
      ...createRetrievalBudget("STANDARD"),
      generalCalls: 10,
      retrievalCalls: 10,
    }

    // When
    const result = meterRetrievalResult(exhausted, { kind: "delivered", content: "result" })

    // Then
    expect(result).toEqual({ ok: false, code: "retrieval_call_budget_exceeded", budget: exhausted })
  })

  test("Given a budget with more retrieval than general calls When parsed Then the impossible state is rejected", () => {
    // Given
    const impossible = { ...createRetrievalBudget("FAST"), generalCalls: 0, retrievalCalls: 1 }

    // When
    const result = RetrievalBudgetSchema.safeParse(impossible)

    // Then
    expect(result.success).toBe(false)
  })

  test("Given every tier's exact limits When a retrieval is delivered Then retrieval calls never exceed general calls", () => {
    // Given
    const tiers = ["FAST", "STANDARD", "DEEP"] as const

    // When
    const results = tiers.map((tier) =>
      meterRetrievalResult(createRetrievalBudget(tier), { kind: "delivered", content: tier }),
    )

    // Then
    for (const result of results) {
      expect(result).toMatchObject({ ok: true })
      expect(result.budget.retrievalCalls).toBeLessThanOrEqual(result.budget.generalCalls)
    }
  })
})
