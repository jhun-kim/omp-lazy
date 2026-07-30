import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import type { ActivationSuppressionPort } from "../../src/activation/types"
import {
  MAX_IDLE_CONTINUATIONS,
  readContinuationCounter,
} from "../../src/continuation/continuation-budget"
import type { ContinuationCoordinatorPort } from "../../src/continuation/continuation-coordinator"
import { createDeadlineFence } from "../../src/continuation/deadline-fence"
import {
  type ContinuationBudgetPort,
  handleSessionStop,
} from "../../src/continuation/register-session-stop"
import { STEERING_REMINDER } from "../../src/continuation/steering-reminder"
import { continuationCounterPath } from "../../src/state/paths"
import { temporaryRoot } from "../fixtures/store-fixtures"

const RUN_ID = "11111111-1111-4111-8111-111111111111"
const SESSION_ID = "budget-test-session"

/** The expected additionalContext after steering reminder is appended */
const EXPECTED_CONTEXT = `continue the work\n\n${STEERING_REMINDER}`

function mockCoordinator(): ContinuationCoordinatorPort {
  return {
    handle: async () => ({ kind: "continue", additionalContext: "continue the work" }),
  }
}

function mockSuppression(): ActivationSuppressionPort {
  return {
    suppressNext: async () => {},
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

describe("continuation budget – persisted saturating counter (todo 15)", () => {
  test("MAX_IDLE_CONTINUATIONS is exported and equals 8", () => {
    expect(MAX_IDLE_CONTINUATIONS).toBe(8)
  })

  test("the 8th continuation IS emitted (counter at 8 after)", async () => {
    const root = await temporaryRoot("budget-8th")
    const budget = mockBudget(root)

    // Drive 8 idle edges
    for (let i = 1; i <= 8; i++) {
      const result = await handleSessionStop(makeInput(1, `leaf-${i}`), {
        coordinator: mockCoordinator(),
        suppression: mockSuppression(),
        createFence: () => createDeadlineFence(5000),
        budget,
      })
      expect(result).toEqual({ continue: true, additionalContext: EXPECTED_CONTEXT })
    }

    // Read the persisted counter
    const counter = await readContinuationCounter(root, SESSION_ID)
    expect(counter).not.toBeNull()
    expect(counter?.count).toBe(8)
  })

  test("the 9th continuation is NOT emitted and records continuation_budget_exhausted", async () => {
    const root = await temporaryRoot("budget-9th")
    const budget = mockBudget(root)

    // Drive 8 idle edges
    for (let i = 1; i <= 8; i++) {
      const result = await handleSessionStop(makeInput(1, `leaf-${i}`), {
        coordinator: mockCoordinator(),
        suppression: mockSuppression(),
        createFence: () => createDeadlineFence(5000),
        budget,
      })
      expect(result).toEqual({ continue: true, additionalContext: EXPECTED_CONTEXT })
    }

    // The 9th must NOT produce a continuation
    const result = await handleSessionStop(makeInput(1, "leaf-9"), {
      coordinator: mockCoordinator(),
      suppression: mockSuppression(),
      createFence: () => createDeadlineFence(5000),
      budget,
    })
    expect(result).toBeUndefined()

    // Read the persisted counter - must have the exhausted reason
    const counterPath = continuationCounterPath(root, SESSION_ID)
    const raw = await readFile(counterPath, "utf8")
    const counter = JSON.parse(raw)
    expect(counter.count).toBe(8)
    expect(counter.reason).toBe("continuation_budget_exhausted")
  })

  test("counter is durable across a fresh instance on the same root", async () => {
    const root = await temporaryRoot("budget-durable")
    const budget = mockBudget(root)

    // First batch: drive 6 edges
    for (let i = 1; i <= 6; i++) {
      const result = await handleSessionStop(makeInput(1, `leaf-a-${i}`), {
        coordinator: mockCoordinator(),
        suppression: mockSuppression(),
        createFence: () => createDeadlineFence(5000),
        budget,
      })
      expect(result).toEqual({ continue: true, additionalContext: EXPECTED_CONTEXT })
    }

    // Verify counter is at 6
    const counter6 = await readContinuationCounter(root, SESSION_ID)
    expect(counter6?.count).toBe(6)

    // Fresh budget port (simulating fresh instance on same root)
    const budget2 = mockBudget(root)

    // Continue from 7
    const result7 = await handleSessionStop(makeInput(1, "leaf-b-7"), {
      coordinator: mockCoordinator(),
      suppression: mockSuppression(),
      createFence: () => createDeadlineFence(5000),
      budget: budget2,
    })
    expect(result7).toEqual({ continue: true, additionalContext: EXPECTED_CONTEXT })

    const result8 = await handleSessionStop(makeInput(1, "leaf-b-8"), {
      coordinator: mockCoordinator(),
      suppression: mockSuppression(),
      createFence: () => createDeadlineFence(5000),
      budget: budget2,
    })
    expect(result8).toEqual({ continue: true, additionalContext: EXPECTED_CONTEXT })

    // 9th should be blocked
    const result9 = await handleSessionStop(makeInput(1, "leaf-b-9"), {
      coordinator: mockCoordinator(),
      suppression: mockSuppression(),
      createFence: () => createDeadlineFence(5000),
      budget: budget2,
    })
    expect(result9).toBeUndefined()
  })

  test("a new user turn (different diagnosticTurnId) resets the counter", async () => {
    const root = await temporaryRoot("budget-reset-turn")
    const budget = mockBudget(root)

    // Exhaust budget at turnId=1
    for (let i = 1; i <= 8; i++) {
      await handleSessionStop(makeInput(1, `leaf-t1-${i}`), {
        coordinator: mockCoordinator(),
        suppression: mockSuppression(),
        createFence: () => createDeadlineFence(5000),
        budget,
      })
    }

    // Confirm 9th is blocked
    const blocked = await handleSessionStop(makeInput(1, "leaf-t1-9"), {
      coordinator: mockCoordinator(),
      suppression: mockSuppression(),
      createFence: () => createDeadlineFence(5000),
      budget,
    })
    expect(blocked).toBeUndefined()

    // New user turn (turnId=2) should reset the counter
    const reset = await handleSessionStop(makeInput(2, "leaf-t2-1"), {
      coordinator: mockCoordinator(),
      suppression: mockSuppression(),
      createFence: () => createDeadlineFence(5000),
      budget,
    })
    expect(reset).toEqual({ continue: true, additionalContext: EXPECTED_CONTEXT })

    // Read the counter - should be 1 now
    const counter = await readContinuationCounter(root, SESSION_ID)
    expect(counter?.count).toBe(1)
    expect(counter?.turnId).toBe(2)
  })

  test("a new run id resets the counter", async () => {
    const root = await temporaryRoot("budget-reset-runid")
    let currentRunId = RUN_ID
    const budget: ContinuationBudgetPort = {
      resolveRoot: async () => root,
      resolveActiveRunId: async () => currentRunId,
    }

    // Drive 7 edges with run 1
    for (let i = 1; i <= 7; i++) {
      await handleSessionStop(makeInput(1, `leaf-r1-${i}`), {
        coordinator: mockCoordinator(),
        suppression: mockSuppression(),
        createFence: () => createDeadlineFence(5000),
        budget,
      })
    }

    // Verify counter at 7
    const counter7 = await readContinuationCounter(root, SESSION_ID)
    expect(counter7?.count).toBe(7)
    expect(counter7?.runId).toBe(RUN_ID)

    // Switch to a new run
    currentRunId = "22222222-2222-4222-8222-222222222222"

    // The next edge should detect the runId change and reset
    const result = await handleSessionStop(makeInput(1, "leaf-r2-1"), {
      coordinator: mockCoordinator(),
      suppression: mockSuppression(),
      createFence: () => createDeadlineFence(5000),
      budget,
    })
    expect(result).toEqual({ continue: true, additionalContext: EXPECTED_CONTEXT })

    // Counter should be at 1 with the new runId
    const counterAfter = await readContinuationCounter(root, SESSION_ID)
    expect(counterAfter?.count).toBe(1)
    expect(counterAfter?.runId).toBe("22222222-2222-4222-8222-222222222222")
  })
})
