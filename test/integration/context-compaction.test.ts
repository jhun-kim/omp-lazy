import { describe, expect, test } from "bun:test"
import type { AgentMessage } from "@oh-my-pi/pi-agent-core"
import { TierBudgets } from "../../src/contracts/task-packet"
import {
  ModelCallObserver,
  PROXY_CALL_ID_HEADER,
  PROXY_SCOPE_HEADER,
  PROXY_TERMINAL_HEADER,
} from "../../src/observers/model-call-observer"
import {
  compactStepContext,
  compileStepContext,
  TASK_PACKET_CUSTOM_TYPE,
} from "../../src/workflows/task-packet-compiler"

function stepContext() {
  const result = compileStepContext({
    version: 1,
    runId: "run-t07",
    taskId: "T07",
    generation: 2,
    objective: "Keep one current packet",
    deliverable: "Compact provider context",
    allowedPaths: ["src/extension/register-extension.ts"],
    referenceIds: ["T04"],
    dependencyIds: ["T06"],
    criteria: [
      {
        id: "current",
        scenario: "old packet injection",
        observable: "only generation two remains",
        expected: "generation one is removed",
        evidenceLogicalId: "T07.compaction",
      },
    ],
    boundaryTags: ["none"],
    publicBehavior: false,
    tier: "FAST",
    budgets: TierBudgets.FAST,
    evidenceRequirements: [{ logicalId: "T07.compaction", kind: "test", required: true }],
  })
  if (!result.ok) throw new Error(result.code)
  return result
}

describe("packet context and proxy-call observation", () => {
  test("Given an injected old packet When context compacts Then it is removed and the current packet appears once", () => {
    // Given
    const current = stepContext()
    const messages: AgentMessage[] = [
      { role: "user", content: "continue", timestamp: 1 },
      {
        role: "custom",
        customType: TASK_PACKET_CUSTOM_TYPE,
        content: "old-packet",
        display: false,
        details: { packetHash: "0".repeat(64), generation: 1 },
        timestamp: 2,
      },
      { ...current.message, role: "custom", timestamp: 3 },
    ]

    // When
    const compacted = compactStepContext(messages, current.message, 4)

    // Then
    expect(compacted.filter((message) => message.role === "custom")).toEqual([
      { ...current.message, role: "custom", timestamp: 4 },
    ])
    expect(JSON.stringify(compacted)).not.toContain("old-packet")
  })

  test("Given a static actor route When calls retry and terminate Then proxy call IDs reconcile in order", () => {
    // Given
    const observer = new ModelCallObserver()
    const model = {
      provider: "harness-worker-low",
      id: "worker-low",
      baseUrl: "http://127.0.0.1:43123/v1/actor/worker-low",
      headers: { [PROXY_SCOPE_HEADER]: "a".repeat(32) },
    }

    // When
    expect(observer.begin("session-a", stepContext().compiled.packetHash, model)).toMatchObject({
      kind: "accepted",
    })
    const first = observer.observeResponse("session-a", {
      status: 200,
      headers: new Headers({
        [PROXY_CALL_ID_HEADER]: "1",
        [PROXY_TERMINAL_HEADER]: "responded",
      }),
    })
    observer.retryStarted("session-a", { attempt: 1, maxAttempts: 1 })
    expect(observer.begin("session-a", stepContext().compiled.packetHash, model)).toMatchObject({
      kind: "accepted",
      retryAttempt: 1,
    })
    const second = observer.observeResponse("session-a", {
      status: 503,
      headers: new Headers({
        [PROXY_CALL_ID_HEADER]: "2",
        [PROXY_TERMINAL_HEADER]: "errored",
      }),
    })
    expect(observer.begin("session-a", stepContext().compiled.packetHash, model)).toMatchObject({
      kind: "accepted",
    })
    const third = observer.observeProxyTerminal("session-a", {
      scopeId: "a".repeat(32),
      configuredActorRoute: "/actor/worker-low",
      proxyCallId: 3,
      terminal: "transport_client_disconnected",
    })

    // Then
    expect(first).toMatchObject({ kind: "recorded", call: { proxyCallId: 1 } })
    expect(second).toMatchObject({ kind: "recorded", call: { proxyCallId: 2, retryAttempt: 1 } })
    expect(third).toMatchObject({ kind: "recorded", call: { proxyCallId: 3 } })
    expect(observer.snapshot("session-a")?.calls.map((call) => call.terminal)).toEqual([
      "responded",
      "errored",
      "transport_client_disconnected",
    ])
  })

  test("Given a repeated proxy call ID When observed Then reconciliation refuses the replay", () => {
    // Given
    const observer = new ModelCallObserver()
    const model = {
      provider: "harness-parent",
      id: "parent",
      baseUrl: "http://127.0.0.1:43123/v1/actor/parent",
      headers: { [PROXY_SCOPE_HEADER]: "b".repeat(32) },
    }
    const packetHash = stepContext().compiled.packetHash
    observer.begin("session-a", packetHash, model)
    observer.observeResponse("session-a", {
      status: 200,
      headers: new Headers({ [PROXY_CALL_ID_HEADER]: "1" }),
    })
    observer.begin("session-a", packetHash, model)

    // When
    const replay = observer.observeResponse("session-a", {
      status: 200,
      headers: new Headers({ [PROXY_CALL_ID_HEADER]: "1" }),
    })

    // Then
    expect(replay).toEqual({ kind: "refused", code: "proxy_call_id_replayed" })
  })
})
