import { describe, expect, test } from "bun:test"
import {
  evaluateUlwContinuation,
  recordCriterionFailure,
  startGoalCycle,
} from "../../../src/workflows/ulw-loop-contract"
import { ulwLoopRun } from "../../fixtures/state-fixtures"

describe("ULW loop contract", () => {
  test("Given active pending work When evaluated Then the active goal is eligible", () => {
    // Given / When
    const result = evaluateUlwContinuation(ulwLoopRun())

    // Then
    expect(result).toEqual({ ok: true, goalId: "goal-1" })
  })

  test("Given the fifth cycle When starting another Then the persisted bound rejects it", () => {
    // Given
    const run = ulwLoopRun()
    const goal = run.payload.goals[0]
    if (goal === undefined) throw new Error("fixture goal missing")
    const bounded = { ...run, payload: { ...run.payload, goals: [{ ...goal, cycleCount: 5 }] } }

    // When
    const result = startGoalCycle(bounded, "goal-1")

    // Then
    expect(result).toEqual({ ok: false, code: "cycle_limit" })
  })

  test("Given three identical failures When recording a fourth Then the persisted bound rejects it", () => {
    // Given
    const run = ulwLoopRun()
    const goal = run.payload.goals[0]
    const criterion = goal?.criteria[0]
    if (goal === undefined || criterion === undefined) throw new Error("fixture criterion missing")
    const bounded = {
      ...run,
      payload: {
        ...run.payload,
        goals: [
          {
            ...goal,
            criteria: [
              { ...criterion, identicalFailureFingerprint: "same", identicalFailureCount: 3 },
            ],
          },
        ],
      },
    }

    // When
    const result = recordCriterionFailure(bounded, {
      goalId: "goal-1",
      criterionId: "criterion-1",
      fingerprint: "same",
    })

    // Then
    expect(result).toEqual({ ok: false, code: "identical_failure_limit" })
  })

  test("Given unmet criteria When completion is evaluated Then it cannot complete", () => {
    // Given
    const run = ulwLoopRun()
    const inactiveGoal = run.payload.goals[0]
    if (inactiveGoal === undefined) throw new Error("fixture goal missing")
    const invalidComplete = {
      ...run,
      payload: {
        ...run.payload,
        status: "completed" as const,
        activeGoalId: null,
        goals: [{ ...inactiveGoal, status: "complete" as const }],
      },
    }

    // When
    const result = evaluateUlwContinuation(invalidComplete)

    // Then
    expect(result).toEqual({ ok: false, code: "unmet_criteria" })
  })
})
