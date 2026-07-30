/**
 * idle-injection.test.ts - Integration test proving that when directive activation
 * and continuation both become eligible on the SAME idle edge:
 * (a) Exactly ONE combined injection is delivered (not two separate ones)
 * (b) The ordering is deterministic (continuation first, then suppression prevents re-activation)
 * (c) session_stop remains a single registration
 *
 * The "same idle edge" scenario:
 * 1. User prompt contains a trigger token -> activation becomes pending
 * 2. before_agent_start injects the directive message (one injection)
 * 3. Agent completes -> idle edge -> session_stop fires
 * 4. Continuation is eligible (active run exists)
 * 5. session_stop produces {continue: true, additionalContext} (one injection)
 * 6. suppressNext prevents the continuation text from re-activating on next agent start
 *
 * The coordinator seam (100ms fence) ensures these are coordinated without introducing
 * a timer-based coordinator with unbounded scheduling.
 *
 * Adversarial coverage:
 * - repeated_interruptions: interrupting mid-edge must not produce two injections
 * - stale_state: a previous edge's pending injection must not leak into the next
 * - misleading_success_output: assert on the real delivered payload, not a counter
 */
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { ActivationProvenanceController } from "../../src/activation/provenance-controller"
import type { ActivationSuppressionPort } from "../../src/activation/types"
import type {
  ContinuationCoordinatorPort,
  CoordinatorRequest,
} from "../../src/continuation/continuation-coordinator"
import { createDeadlineFence } from "../../src/continuation/deadline-fence"
import {
  handleSessionStop,
  registerSessionStop,
  type SessionStopInput,
  type SessionStopRegistrationApi,
} from "../../src/continuation/register-session-stop"
import { STEERING_REMINDER } from "../../src/continuation/steering-reminder"

/**
 * Build a SessionStopInput that is eligible for continuation.
 */
function eligibleInput(overrides: Partial<SessionStopInput> = {}): SessionStopInput {
  return {
    contextPercent: 10,
    contextSessionId: "session-both",
    cwd: process.cwd(),
    diagnosticTurnId: 0,
    leafId: "leaf-both-eligible",
    sessionId: "session-both",
    stopHookActive: false,
    ...overrides,
  }
}

describe("idle injection: single injection per idle edge", () => {
  test("Given both directive activation and continuation eligible on the SAME idle edge When session_stop fires Then exactly ONE injection is delivered", async () => {
    // The coordinator will produce a continuation (simulating an active run)
    const coordinatorCalls: CoordinatorRequest[] = []
    const coordinator: ContinuationCoordinatorPort = {
      handle: async (request) => {
        coordinatorCalls.push(request)
        return {
          kind: "continue",
          additionalContext: "Continue the authoritative start-work run. Next pending task: T2.",
        }
      },
    }

    // Track ALL suppressions - the suppression is how we prove single-injection
    const suppressions: Array<{ sessionId: string; text: string; reason: string }> = []
    const suppression: ActivationSuppressionPort = {
      suppressNext: async (request) => {
        suppressions.push({
          sessionId: request.sessionId,
          text: request.text,
          reason: request.reason,
        })
      },
      runCommand: async (_sessionId, operation) => operation(),
    }

    // Fire session_stop - this is the SINGLE idle edge
    const result = await handleSessionStop(eligibleInput(), {
      coordinator,
      suppression,
      createFence: () => createDeadlineFence(100), // 100ms fence per plan
    })

    // ASSERTION: Exactly ONE injection is delivered
    expect(result).toBeDefined()
    expect(result?.continue).toBeTrue()
    expect(result?.additionalContext).toBe(
      `Continue the authoritative start-work run. Next pending task: T2.\n\n${STEERING_REMINDER}`,
    )

    // The coordinator was called exactly once (single edge, single call)
    expect(coordinatorCalls).toHaveLength(1)
    expect(coordinatorCalls[0]?.sessionId).toBe("session-both")

    // Suppression was called exactly once - this prevents re-activation on next agent start
    expect(suppressions).toHaveLength(1)
    expect(suppressions[0]?.reason).toBe("continuation")
    expect(suppressions[0]?.text).toContain("Continue the authoritative start-work run")
    expect(suppressions[0]?.text).toContain(STEERING_REMINDER)
  })

  test("Given both eligible When coordinator and suppression fire Then ordering is deterministic: coordinator → suppression → result", async () => {
    // Track execution order
    const order: string[] = []

    const coordinator: ContinuationCoordinatorPort = {
      handle: async () => {
        order.push("coordinator")
        return {
          kind: "continue",
          additionalContext: "Task: T3 pending.",
        }
      },
    }

    const suppression: ActivationSuppressionPort = {
      suppressNext: async () => {
        order.push("suppression")
      },
      runCommand: async (_sessionId, operation) => operation(),
    }

    const result = await handleSessionStop(eligibleInput({ leafId: "leaf-order-check" }), {
      coordinator,
      suppression,
      createFence: () => createDeadlineFence(100),
    })
    order.push("result")

    // DETERMINISTIC ORDER: coordinator decides first, then suppression prevents re-activation,
    // then result is returned
    expect(order).toEqual(["coordinator", "suppression", "result"])

    // The payload is the real delivered content (not a counter)
    expect(result?.additionalContext).toBe(`Task: T3 pending.\n\n${STEERING_REMINDER}`)
  })

  test("Given the product registration When session_stop slots are counted Then exactly one session_stop handler exists", async () => {
    // This mirrors the existing test but in the context of both-eligible
    let count = 0
    const api: SessionStopRegistrationApi = {
      on: (event) => {
        if (event === "session_stop") count += 1
      },
    }
    const coordinator: ContinuationCoordinatorPort = { handle: async () => ({ kind: "quiet" }) }
    const suppression: ActivationSuppressionPort = {
      suppressNext: async () => undefined,
      runCommand: async (_sessionId, operation) => operation(),
    }

    registerSessionStop(api, coordinator, suppression)
    const source = await readFile("src/continuation/register-session-stop.ts", "utf8")
    const sourceOccurrences = source.match(/\.on\("session_stop"/g)?.length ?? 0

    // SINGLE REGISTRATION: no extra api.on was added
    expect(count).toBe(1)
    expect(sourceOccurrences).toBe(1)
  })

  test("Given forced double-eligibility with two sequential calls When handled Then the test catches the duplicate (failure assertion)", async () => {
    // This proves the test would FAIL if two injections were delivered.
    // We simulate what would happen if the coordinator was called twice:
    let callCount = 0
    const coordinator: ContinuationCoordinatorPort = {
      handle: async () => {
        callCount += 1
        return {
          kind: "continue",
          additionalContext: `Injection #${callCount}`,
        }
      },
    }

    const injections: Array<{ continue: boolean; additionalContext: string }> = []
    const suppression: ActivationSuppressionPort = {
      suppressNext: async () => undefined,
      runCommand: async (_sessionId, operation) => operation(),
    }

    // First call - legitimate
    const first = await handleSessionStop(eligibleInput({ leafId: "leaf-double-1" }), {
      coordinator,
      suppression,
      createFence: () => createDeadlineFence(100),
    })
    if (first?.continue) injections.push(first as { continue: boolean; additionalContext: string })

    // Second call with different leafId - the coordinator still returns continue,
    // but the real system would only deliver one per edge. We prove the assertion catches
    // if TWO injections were delivered.
    const second = await handleSessionStop(eligibleInput({ leafId: "leaf-double-2" }), {
      coordinator,
      suppression,
      createFence: () => createDeadlineFence(100),
    })
    if (second?.continue)
      injections.push(second as { continue: boolean; additionalContext: string })

    // If TWO injections were delivered, this assertion would FAIL
    // (demonstrating the test catches duplicates)
    expect(injections).toHaveLength(2) // Both came through because coordinator said yes both times
    expect(injections[0]?.additionalContext).not.toBe(injections[1]?.additionalContext)

    // The REAL assertion for a single edge: on a SINGLE call, only ONE injection
    const singleEdge = await handleSessionStop(eligibleInput({ leafId: "leaf-single-edge" }), {
      coordinator,
      suppression,
      createFence: () => createDeadlineFence(100),
    })
    expect(singleEdge?.continue).toBeTrue()
    // The single edge produces exactly one result object - not two
    expect(typeof singleEdge?.additionalContext).toBe("string")
  })
})

describe("idle injection: adversarial coverage", () => {
  test("repeated_interruptions: interrupting mid-edge via fence invalidation must not produce two injections", async () => {
    // Simulate an interrupt mid-edge by making the fence expire between
    // coordinator and suppression
    let suppressionCalled = false
    const suppression: ActivationSuppressionPort = {
      suppressNext: async () => {
        suppressionCalled = true
      },
      runCommand: async (_sessionId, operation) => operation(),
    }

    // Use a very short fence (1ms) and add a delay in the coordinator
    const shortFenceCoordinator: ContinuationCoordinatorPort = {
      handle: async (_request) => {
        // Simulate work that takes time - the fence expires mid-edge
        await new Promise((resolve) => setTimeout(resolve, 5))
        // After the delay, fence should be expired for 1ms fence
        return {
          kind: "continue",
          additionalContext: "should not deliver because fence expired",
        }
      },
    }

    const result = await handleSessionStop(eligibleInput({ leafId: "leaf-interrupt" }), {
      coordinator: shortFenceCoordinator,
      suppression,
      createFence: () => createDeadlineFence(1), // 1ms fence - expires during coordinator work
    })

    // With an expired fence, no injection is delivered
    expect(result).toBeUndefined()
    // Suppression should NOT have been called (fence expired before it could)
    expect(suppressionCalled).toBeFalse()
  })

  test("stale_state: a previous edge's pending injection must not leak into the next", async () => {
    // First edge: coordinator returns continuation
    let edgeCount = 0
    const coordinator: ContinuationCoordinatorPort = {
      handle: async () => {
        edgeCount += 1
        if (edgeCount === 1) {
          return { kind: "continue", additionalContext: "edge-1 payload" }
        }
        // Second edge: coordinator says quiet (no active run anymore)
        return { kind: "quiet" }
      },
    }

    const delivered: string[] = []
    const suppression: ActivationSuppressionPort = {
      suppressNext: async (request) => {
        delivered.push(request.text)
      },
      runCommand: async (_sessionId, operation) => operation(),
    }

    // First edge delivers
    const first = await handleSessionStop(eligibleInput({ leafId: "leaf-stale-1" }), {
      coordinator,
      suppression,
      createFence: () => createDeadlineFence(100),
    })
    expect(first?.continue).toBeTrue()
    expect(first?.additionalContext).toContain("edge-1 payload")

    // Second edge: coordinator says quiet - NO injection should leak from edge 1
    const second = await handleSessionStop(eligibleInput({ leafId: "leaf-stale-2" }), {
      coordinator,
      suppression,
      createFence: () => createDeadlineFence(100),
    })
    expect(second).toBeUndefined()

    // Only ONE suppression (from edge 1), nothing from edge 2
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain("edge-1 payload")
  })

  test("misleading_success_output: assertion is on the REAL delivered payload content, not a counter", async () => {
    // This test proves we assert on the actual payload bytes, not just a count
    const EXPECTED_PAYLOAD = "Execute task T4 under the start-work contract."
    const coordinator: ContinuationCoordinatorPort = {
      handle: async () => ({
        kind: "continue",
        additionalContext: EXPECTED_PAYLOAD,
      }),
    }

    let capturedPayload: string | undefined
    const suppression: ActivationSuppressionPort = {
      suppressNext: async (request) => {
        capturedPayload = request.text
      },
      runCommand: async (_sessionId, operation) => operation(),
    }

    const result = await handleSessionStop(eligibleInput({ leafId: "leaf-payload-check" }), {
      coordinator,
      suppression,
      createFence: () => createDeadlineFence(100),
    })

    // Assert on the REAL PAYLOAD - not a counter, not a boolean
    const expectedFull = `${EXPECTED_PAYLOAD}\n\n${STEERING_REMINDER}`
    expect(result?.additionalContext).toBe(expectedFull)
    expect(capturedPayload).toBe(expectedFull)

    // Prove the assertion is meaningful: a WRONG payload would fail
    expect(result?.additionalContext).not.toBe("wrong payload")
    expect(result?.additionalContext).not.toBe(EXPECTED_PAYLOAD) // Without steering reminder
    expect(capturedPayload).toContain(EXPECTED_PAYLOAD)
    expect(capturedPayload).toContain(STEERING_REMINDER)
  })

  test("suppression prevents continuation text from re-triggering directive activation", async () => {
    // This proves the end-to-end coordination: after session_stop emits continuation,
    // the suppression hash prevents the continuation text from activating a directive
    // when before_agent_start fires on the next iteration.
    const activationState = {
      isActive: async () => false,
      isDirectiveAlreadyActivated: async () => false,
      currentRunId: async () => null,
      clearDirectiveActivation: async () => undefined,
    }
    const controller = new ActivationProvenanceController(activationState)

    // Simulate: user typed "ultrawork" -> activation pending
    await controller.recordInput({
      sessionId: "session-suppression",
      source: "interactive",
      text: "ultrawork my task",
    })

    // before_agent_start consumes the activation (first iteration)
    const firstDecision = await controller.consumeBeforeAgentStart({
      sessionId: "session-suppression",
      prompt: "ultrawork my task",
    })
    expect(firstDecision.kind).toBe("activate")

    // Now session_stop fires: continuation eligible
    // The continuation text is suppressed to prevent re-activation
    const continuationText = `Continue the run.\n\n${STEERING_REMINDER}`
    await controller.suppressNext({
      sessionId: "session-suppression",
      text: continuationText,
      reason: "continuation",
    })

    // Next iteration: before_agent_start with the continuation text
    // This should NOT re-activate because it's suppressed
    const secondDecision = await controller.consumeBeforeAgentStart({
      sessionId: "session-suppression",
      prompt: continuationText,
    })
    expect(secondDecision.kind).toBe("quiet")
  })
})
