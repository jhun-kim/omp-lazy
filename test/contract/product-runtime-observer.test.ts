import { describe, expect, test } from "bun:test"
import { TierBudgets } from "../../src/contracts/task-packet"
import { ProductRuntimeObserver } from "../../src/observers/product-runtime-observer"
import { compileStepContext } from "../../src/workflows/task-packet-compiler"

function activeObserver(): ProductRuntimeObserver {
  const compiled = compileStepContext({
    version: 1,
    runId: "run-t07-observer",
    taskId: "T07",
    generation: 1,
    objective: "Meter public observer retrieval results",
    deliverable: "Semantic result accounting",
    allowedPaths: ["src/observers/product-runtime-observer.ts"],
    referenceIds: ["T04"],
    dependencyIds: [],
    criteria: [
      {
        id: "observer-metering",
        scenario: "tool result delivery",
        observable: "substantive bytes are metered once",
        expected: "status acknowledgements alone remain exempt",
        evidenceLogicalId: "T07.observer",
      },
    ],
    boundaryTags: ["none"],
    publicBehavior: false,
    tier: "FAST",
    budgets: TierBudgets.FAST,
    evidenceRequirements: [{ logicalId: "T07.observer", kind: "test", required: true }],
  })
  if (!compiled.ok) throw new Error(compiled.code)
  const observer = new ProductRuntimeObserver()
  observer.activate("session-a", compiled)
  return observer
}

const deliveredResults = [
  {
    toolCallId: "hub-delivered",
    toolName: "hub",
    details: {
      op: "wait",
      waited: { id: "message-1", from: "worker", to: "main", body: "허브", ts: 1 },
    },
    content: [{ type: "text", text: "허브" }],
    deliveredBytes: Buffer.byteLength("허브", "utf8"),
  },
  {
    toolCallId: "job-delivered",
    toolName: "job",
    details: {
      op: "wait",
      jobs: [
        {
          id: "worker",
          type: "task",
          status: "completed",
          label: "worker",
          durationMs: 1,
          resultText: "abc",
        },
      ],
    },
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    deliveredBytes: Buffer.byteLength("YWJj", "utf8"),
  },
  {
    toolCallId: "irc-delivered",
    toolName: "irc",
    details: { op: "inbox", messages: [{ from: "worker", body: "IRC ✓" }] },
    content: [{ type: "text", text: "IRC ✓" }],
    deliveredBytes: Buffer.byteLength("IRC ✓", "utf8"),
  },
] as const

const statusOnlyResults = [
  {
    toolCallId: "hub-status",
    toolName: "hub",
    details: { op: "wait", waited: null },
    content: [{ type: "text", text: "No peer message available" }],
  },
  {
    toolCallId: "job-status",
    toolName: "job",
    details: {
      op: "jobs",
      jobs: [
        {
          id: "worker",
          type: "task",
          status: "running",
          label: "worker",
          durationMs: 1,
        },
      ],
    },
    content: [{ type: "text", text: "worker is running" }],
  },
  {
    toolCallId: "irc-status",
    toolName: "irc",
    details: { op: "send", receipts: [{ to: "worker", outcome: "injected" }] },
    content: [{ type: "text", text: "message injected" }],
  },
] as const

describe("public product runtime observer retrieval metering", () => {
  for (const delivered of deliveredResults) {
    test(`Given a nonempty ${delivered.toolName} payload When delivered Then one retrieval call and exact bytes are charged`, () => {
      // Given
      const observer = activeObserver()
      expect(observer.toolCall("session-a", delivered.toolCallId)).toBeUndefined()

      // When
      const result = observer.toolResult({ sessionId: "session-a", ...delivered })

      // Then
      expect(result).toBeUndefined()
      expect(observer.retrievalSnapshot("session-a")).toMatchObject({
        budget: {
          generalCalls: 1,
          retrievalCalls: 1,
          retrievalBytes: delivered.deliveredBytes,
        },
        observations: [
          {
            toolCallId: delivered.toolCallId,
            deliveredBytes: delivered.deliveredBytes,
            outcome: "delivered",
          },
        ],
      })
    })
  }

  test("Given genuinely empty content When observed Then it consumes only one general call", () => {
    // Given
    const observer = activeObserver()
    expect(observer.toolCall("session-a", "empty-result")).toBeUndefined()

    // When
    observer.toolResult({
      sessionId: "session-a",
      toolCallId: "empty-result",
      toolName: "read",
      content: [{ type: "text", text: "" }],
      details: { payload: "details do not make empty delivered content nonempty" },
    })

    // Then
    expect(observer.retrievalSnapshot("session-a")).toMatchObject({
      budget: { generalCalls: 1, retrievalCalls: 0, retrievalBytes: 0 },
      observations: [{ toolCallId: "empty-result", deliveredBytes: 0, outcome: "empty" }],
    })
  })

  for (const status of statusOnlyResults) {
    test(`Given an explicit ${status.toolName} status acknowledgement When observed Then retrieval metering is exempt`, () => {
      // Given
      const observer = activeObserver()
      expect(observer.toolCall("session-a", status.toolCallId)).toBeUndefined()

      // When
      observer.toolResult({ sessionId: "session-a", ...status })

      // Then
      expect(observer.retrievalSnapshot("session-a")).toMatchObject({
        budget: { generalCalls: 1, retrievalCalls: 0, retrievalBytes: 0 },
        observations: [
          {
            toolCallId: status.toolCallId,
            deliveredBytes: Buffer.byteLength(status.content[0].text, "utf8"),
            outcome: "status",
          },
        ],
      })
    })
  }

  test("Given a substantive terminal payload When refused Then its call ID and exact accounting remain stable", () => {
    // Given
    const observer = activeObserver()
    const text = "한".repeat(TierBudgets.FAST.maxRetrievalBytes)
    expect(observer.toolCall("session-a", "terminal-job")).toBeUndefined()

    // When
    const refusal = observer.toolResult({
      sessionId: "session-a",
      toolCallId: "terminal-job",
      toolName: "job",
      content: [{ type: "text", text }],
      details: {
        op: "wait",
        jobs: [
          {
            id: "worker",
            type: "task",
            status: "completed",
            label: "worker",
            durationMs: 1,
            resultText: text,
          },
        ],
      },
    })

    // Then
    expect(refusal).toMatchObject({
      details: { code: "retrieval_byte_budget_exceeded" },
      isError: true,
    })
    expect(observer.retrievalSnapshot("session-a")).toMatchObject({
      budget: { generalCalls: 0, retrievalCalls: 0, retrievalBytes: 0 },
      terminalCode: "retrieval_byte_budget_exceeded",
      observations: [
        {
          toolCallId: "terminal-job",
          deliveredBytes: Buffer.byteLength(text, "utf8"),
          outcome: "retrieval_byte_budget_exceeded",
        },
      ],
    })
    expect(observer.toolCall("session-a", "after-terminal")).toEqual({
      block: true,
      reason: "omp-lazy: retrieval_byte_budget_exceeded",
    })
  })
})
