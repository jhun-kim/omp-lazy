import { describe, expect, test } from "bun:test"
import { TierBudgets } from "../../src/contracts/task-packet"
import { RetrievalBudgetGuard } from "../../src/gates/retrieval-budget-guard"
import { compileStepContext } from "../../src/workflows/task-packet-compiler"

function compiledFastPacket() {
  const result = compileStepContext({
    version: 1,
    runId: "run-t07",
    taskId: "T07",
    generation: 1,
    objective: "Meter retrieval",
    deliverable: "A bounded result stream",
    allowedPaths: ["src/gates/retrieval-budget-guard.ts"],
    referenceIds: ["T04"],
    dependencyIds: [],
    criteria: [
      {
        id: "budget",
        scenario: "retrieval result",
        observable: "delivered bytes are metered",
        expected: "FAST limits hold",
        evidenceLogicalId: "T07.retrieval",
      },
    ],
    boundaryTags: ["none"],
    publicBehavior: false,
    tier: "FAST",
    budgets: TierBudgets.FAST,
    evidenceRequirements: [{ logicalId: "T07.retrieval", kind: "test", required: true }],
  })
  if (!result.ok) throw new Error(result.code)
  return result.compiled
}

describe("product retrieval budget guard", () => {
  test("Given empty and status-only calls When observed Then only general calls are charged", () => {
    // Given
    const guard = new RetrievalBudgetGuard()
    guard.activate("session-a", compiledFastPacket())

    // When
    expect(guard.authorize("session-a", "call-empty")).toBeUndefined()
    const empty = guard.observe({
      sessionId: "session-a",
      toolCallId: "call-empty",
      statusOnly: false,
      content: [{ type: "text", text: "" }],
    })
    expect(guard.authorize("session-a", "call-status")).toBeUndefined()
    const status = guard.observe({
      sessionId: "session-a",
      toolCallId: "call-status",
      statusOnly: true,
      content: [{ type: "text", text: "running" }],
    })

    // Then
    expect(empty).toMatchObject({ kind: "metered" })
    expect(status).toMatchObject({ kind: "metered" })
    expect(guard.snapshot("session-a")?.budget).toMatchObject({
      generalCalls: 2,
      retrievalCalls: 0,
      retrievalBytes: 0,
    })
  })

  test("Given non-ASCII text and base64 When delivered Then exact UTF-8/base64 bytes are charged", () => {
    // Given
    const guard = new RetrievalBudgetGuard()
    guard.activate("session-a", compiledFastPacket())
    expect(guard.authorize("session-a", "call-utf8")).toBeUndefined()

    // When
    const result = guard.observe({
      sessionId: "session-a",
      toolCallId: "call-utf8",
      statusOnly: false,
      content: [
        { type: "text", text: "한" },
        { type: "image", data: "YWJj", mimeType: "image/png" },
      ],
    })

    // Then
    expect(result).toMatchObject({ kind: "metered" })
    expect(guard.snapshot("session-a")?.budget).toMatchObject({
      generalCalls: 1,
      retrievalCalls: 1,
      retrievalBytes: 7,
    })
  })

  test("Given a FAST result over sixteen KiB When delivered Then it is replaced by one stable terminal refusal", () => {
    // Given
    const guard = new RetrievalBudgetGuard()
    guard.activate("session-a", compiledFastPacket())
    expect(guard.authorize("session-a", "call-large")).toBeUndefined()

    // When
    const refused = guard.observe({
      sessionId: "session-a",
      toolCallId: "call-large",
      statusOnly: false,
      content: [{ type: "text", text: "x".repeat(TierBudgets.FAST.maxRetrievalBytes + 1) }],
    })
    const retry = guard.authorize("session-a", "call-retry")

    // Then
    expect(refused).toEqual({
      kind: "refused",
      code: "retrieval_byte_budget_exceeded",
      replacement: {
        content: [{ type: "text", text: "omp-lazy: retrieval_byte_budget_exceeded" }],
        details: {
          version: 1,
          packetHash: compiledFastPacket().packetHash,
          code: "retrieval_byte_budget_exceeded",
        },
        isError: true,
      },
    })
    expect(retry).toEqual({
      block: true,
      reason: "omp-lazy: retrieval_byte_budget_exceeded",
    })
    expect(guard.snapshot("session-a")?.observations.at(-1)).toMatchObject({
      toolCallId: "call-large",
      deliveredBytes: TierBudgets.FAST.maxRetrievalBytes + 1,
      outcome: "retrieval_byte_budget_exceeded",
    })
  })

  test("Given a reused tool call ID When authorized Then the replay is blocked before execution", () => {
    // Given
    const guard = new RetrievalBudgetGuard()
    guard.activate("session-a", compiledFastPacket())
    expect(guard.authorize("session-a", "call-1")).toBeUndefined()

    // When
    const replay = guard.authorize("session-a", "call-1")

    // Then
    expect(replay).toEqual({ block: true, reason: "omp-lazy: duplicate_tool_call_id" })
  })
})
