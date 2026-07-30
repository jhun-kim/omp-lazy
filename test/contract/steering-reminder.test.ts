import { describe, expect, test } from "bun:test"
import type { ActivationSuppressionPort } from "../../src/activation/types"
import type { ContinuationCoordinatorPort } from "../../src/continuation/continuation-coordinator"
import { createDeadlineFence } from "../../src/continuation/deadline-fence"
import {
  type ContinuationBudgetPort,
  handleSessionStop,
} from "../../src/continuation/register-session-stop"
import { STEERING_REMINDER } from "../../src/continuation/steering-reminder"
import { temporaryRoot } from "../fixtures/store-fixtures"

const RUN_ID = "33333333-3333-4333-8333-333333333333"
const SESSION_ID = "steering-reminder-session"

function mockCoordinator(additionalContext = "continue the work"): ContinuationCoordinatorPort {
  return {
    handle: async () => ({ kind: "continue", additionalContext }),
  }
}

function mockSuppression(): ActivationSuppressionPort & { callLog: string[] } {
  const callLog: string[] = []
  return {
    callLog,
    suppressNext: async (request) => {
      callLog.push(`suppressNext:${request.reason}`)
    },
    runCommand: async (_sessionId, operation) => operation(),
  }
}

function mockBudget(root: Awaited<ReturnType<typeof temporaryRoot>>): ContinuationBudgetPort {
  return {
    resolveRoot: async () => root,
    resolveActiveRunId: async () => RUN_ID,
  }
}

function makeInput(turnId: number, leafId: string) {
  return {
    contextPercent: 50,
    contextSessionId: SESSION_ID,
    cwd: "C:\\test-cwd",
    diagnosticTurnId: turnId,
    leafId,
    sessionId: SESSION_ID,
    stopHookActive: false,
  }
}

describe("steering reminder – additionalContext only (todo 16)", () => {
  test("Given an active run When idle edge fires Then additionalContext contains the steering reminder exactly once", async () => {
    const root = await temporaryRoot("steering-reminder-once")
    const budget = mockBudget(root)

    const result = await handleSessionStop(makeInput(1, "leaf-1"), {
      coordinator: mockCoordinator("continue the authoritative run"),
      suppression: mockSuppression(),
      createFence: () => createDeadlineFence(5000),
      budget,
    })

    expect(result).toBeDefined()
    expect(result?.continue).toBe(true)
    expect(result?.additionalContext).toBeDefined()

    // The reminder must appear exactly once
    const context = result?.additionalContext ?? ""
    const reminderCount = context.split(STEERING_REMINDER).length - 1
    expect(reminderCount).toBe(1)

    // The original coordinator text must still be present
    expect(context).toContain("continue the authoritative run")

    // The reminder is appended (not prepended)
    const reminderIdx = context.indexOf(STEERING_REMINDER)
    const originalIdx = context.indexOf("continue the authoritative run")
    expect(reminderIdx).toBeGreaterThan(originalIdx)
  })

  test("Given an active run When multiple idle edges fire Then each result has exactly one reminder (no accumulation)", async () => {
    const root = await temporaryRoot("steering-no-accumulate")
    const budget = mockBudget(root)

    const result1 = await handleSessionStop(makeInput(1, "leaf-1"), {
      coordinator: mockCoordinator("first edge context"),
      suppression: mockSuppression(),
      createFence: () => createDeadlineFence(5000),
      budget,
    })

    const result2 = await handleSessionStop(makeInput(1, "leaf-2"), {
      coordinator: mockCoordinator("second edge context"),
      suppression: mockSuppression(),
      createFence: () => createDeadlineFence(5000),
      budget,
    })

    // Each result has exactly one reminder
    const ctx1 = result1?.additionalContext ?? ""
    const ctx2 = result2?.additionalContext ?? ""
    const count1 = ctx1.split(STEERING_REMINDER).length - 1
    const count2 = ctx2.split(STEERING_REMINDER).length - 1
    expect(count1).toBe(1)
    expect(count2).toBe(1)

    // Neither result has two reminders
    expect(ctx1).not.toContain(`${STEERING_REMINDER}\n\n${STEERING_REMINDER}`)
    expect(ctx2).not.toContain(`${STEERING_REMINDER}\n\n${STEERING_REMINDER}`)
  })

  test("Given the handler returns within the 2s deadline fence Then timing is within bounds", async () => {
    const root = await temporaryRoot("steering-timing")
    const budget = mockBudget(root)

    const start = performance.now()
    const result = await handleSessionStop(makeInput(1, "leaf-timing"), {
      coordinator: mockCoordinator("timed context"),
      suppression: mockSuppression(),
      createFence: () => createDeadlineFence(2000),
      budget,
    })
    const elapsed = performance.now() - start

    expect(result).toBeDefined()
    expect(result?.continue).toBe(true)
    // The handler must return well within the 2s fence
    expect(elapsed).toBeLessThan(2000)
  })

  test("Given no active run (coordinator returns quiet) Then no continuation and no reminder", async () => {
    const root = await temporaryRoot("steering-no-run")
    const quietCoordinator: ContinuationCoordinatorPort = {
      handle: async () => ({ kind: "quiet" }),
    }

    const result = await handleSessionStop(makeInput(1, "leaf-no-run"), {
      coordinator: quietCoordinator,
      suppression: mockSuppression(),
      createFence: () => createDeadlineFence(5000),
      budget: {
        resolveRoot: async () => root,
        resolveActiveRunId: async () => null,
      },
    })

    expect(result).toBeUndefined()
  })

  test("Given deadline expires during execution Then no continuation is returned", async () => {
    const root = await temporaryRoot("steering-deadline")
    // Use a fence that's already expired (0ms)
    const result = await handleSessionStop(makeInput(1, "leaf-expired"), {
      coordinator: mockCoordinator("should not be returned"),
      suppression: mockSuppression(),
      createFence: () => createDeadlineFence(0),
      budget: mockBudget(root),
    })

    expect(result).toBeUndefined()
  })

  test("No sendUserMessage or sendMessage called during the handler execution", async () => {
    // This is verified by the mock structure - there's no api.sendUserMessage or
    // api.sendMessage in the handleSessionStop path; it only returns a result object.
    // The handler receives no api reference at all - it only returns data.
    const root = await temporaryRoot("steering-no-send")
    const suppression = mockSuppression()
    const budget = mockBudget(root)

    const result = await handleSessionStop(makeInput(1, "leaf-no-send"), {
      coordinator: mockCoordinator("active run context"),
      suppression,
      createFence: () => createDeadlineFence(5000),
      budget,
    })

    // The suppression only receives suppressNext calls, not message sends
    expect(suppression.callLog).toEqual(["suppressNext:continuation"])
    expect(result).toBeDefined()
    expect(result?.continue).toBe(true)
    // The result shape is { continue: true, additionalContext } only - no message field
    expect(result).not.toHaveProperty("message")
    expect(result).not.toHaveProperty("text")
  })
})
