import { describe, expect, test } from "bun:test"
import { evaluateStartWorkContinuation } from "../../../src/workflows/start-work-contract"
import { parseStartWorkPlan } from "../../../src/workflows/start-work-plan"
import { startWorkRun } from "../../fixtures/state-fixtures"

const PLAN = `<!-- omp-lazy-ulw-plan:plan:v1 -->
## TODOs
- [ ] **BUILD. Build state**
- [x] **VERIFY. Verify state**

## Final Verification Wave
- [ ] **REVIEW. Review**
`

describe("start-work contract", () => {
  test("Given active matching unfinished work When evaluated Then it is eligible", () => {
    // Given
    const observed = parseStartWorkPlan(PLAN)
    const run = startWorkRun()
    const matching = {
      ...run,
      payload: {
        ...run.payload,
        plan: {
          ...run.payload.plan,
          taskIds: observed.taskIds,
          taskFingerprint: observed.fingerprint,
        },
      },
    }

    // When
    const result = evaluateStartWorkContinuation(matching, observed)

    // Then
    expect(result).toEqual({ ok: true, nextTaskId: "BUILD" })
  })

  test("Given checkbox-only progress When evaluated Then the next remaining task changes without conflict", () => {
    // Given
    const initial = parseStartWorkPlan(PLAN)
    const checked = parseStartWorkPlan(
      PLAN.replace("- [ ] **BUILD. Build state**", "- [x] **BUILD. Build state**"),
    )
    const run = startWorkRun()
    const matching = {
      ...run,
      payload: {
        ...run.payload,
        plan: {
          ...run.payload.plan,
          taskIds: initial.taskIds,
          taskFingerprint: initial.fingerprint,
        },
      },
    }

    // When
    const result = evaluateStartWorkContinuation(matching, checked)

    // Then
    expect(result).toEqual({ ok: true, nextTaskId: "REVIEW" })
  })

  test("Given task identity replacement When evaluated Then reconcile is required", () => {
    // Given
    const initial = parseStartWorkPlan(PLAN)
    const changed = parseStartWorkPlan(PLAN.replace("BUILD. Build state", "REPLACE. Replace state"))
    const run = startWorkRun()
    const matching = {
      ...run,
      payload: {
        ...run.payload,
        plan: {
          ...run.payload.plan,
          taskIds: initial.taskIds,
          taskFingerprint: initial.fingerprint,
        },
      },
    }

    // When
    const result = evaluateStartWorkContinuation(matching, changed)

    // Then
    expect(result).toEqual({ ok: false, code: "plan_identity_mismatch" })
  })

  test.each([
    "paused",
    "stuck",
    "completed",
    "cancelled",
    "failed",
    "abandoned",
  ] as const)("Given %s state When evaluated Then it does not continue", (status) => {
    // Given
    const run = startWorkRun()
    const observed = parseStartWorkPlan(PLAN)
    const inactive = {
      ...run,
      payload: {
        ...run.payload,
        status,
        plan: {
          ...run.payload.plan,
          taskIds: observed.taskIds,
          taskFingerprint: observed.fingerprint,
        },
      },
    }

    // When
    const result = evaluateStartWorkContinuation(inactive, observed)

    // Then
    expect(result).toEqual({ ok: false, code: "not_active" })
  })
})
