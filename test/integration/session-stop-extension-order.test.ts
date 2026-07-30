import { describe, expect, test } from "bun:test"
import type { SessionStopEventResult } from "@oh-my-pi/pi-coding-agent"
import type { ActivationSuppressionPort } from "../../src/activation/types"
import type { ContinuationCoordinatorPort } from "../../src/continuation/continuation-coordinator"
import { createDeadlineFence } from "../../src/continuation/deadline-fence"
import { handleSessionStop } from "../../src/continuation/register-session-stop"
import { STEERING_REMINDER } from "../../src/continuation/steering-reminder"

type StopHandler = () => Promise<SessionStopEventResult | undefined>

async function settleLikeOmp(
  handlers: readonly StopHandler[],
): Promise<SessionStopEventResult | undefined> {
  for (const handler of handlers) {
    const result = await handler()
    const context = result?.additionalContext ?? result?.reason
    if (
      (result?.continue === true || result?.decision === "block") &&
      context !== undefined &&
      context.length > 0
    ) {
      return result
    }
  }
  return undefined
}

describe("session stop extension order coexistence", () => {
  test("Given hostile handlers before and after omp-lazy When settled Then load order wins globally and product runs only when reached", async () => {
    // Given
    let productCalls = 0
    const coordinator: ContinuationCoordinatorPort = {
      handle: async () => {
        productCalls += 1
        return { kind: "continue", additionalContext: "omp-lazy start-work continuation" }
      },
    }
    const suppression: ActivationSuppressionPort = {
      suppressNext: async () => undefined,
      runCommand: async (_sessionId, operation) => operation(),
    }
    const product: StopHandler = () =>
      handleSessionStop(
        {
          contextPercent: 10,
          contextSessionId: "session-a",
          cwd: process.cwd(),
          diagnosticTurnId: 0,
          leafId: "leaf-order",
          sessionId: "session-a",
          stopHookActive: false,
        },
        { coordinator, suppression, createFence: () => createDeadlineFence(250) },
      )
    const hostile: StopHandler = async () => ({
      continue: true,
      additionalContext: "hostile earlier extension",
    })

    // When
    const earlier = await settleLikeOmp([hostile, product])
    const callsAfterEarlier = productCalls
    const later = await settleLikeOmp([product, hostile])

    // Then
    expect(earlier?.additionalContext).toBe("hostile earlier extension")
    expect(callsAfterEarlier).toBe(0)
    expect(later?.additionalContext).toBe(
      `omp-lazy start-work continuation\n\n${STEERING_REMINDER}`,
    )
    expect(productCalls).toBe(1)
  })
})
