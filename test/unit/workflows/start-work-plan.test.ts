import { describe, expect, test } from "bun:test"
import { normalizeStartWorkPlan, parseStartWorkPlan } from "../../../src/workflows/start-work-plan"

const BASE_PLAN = `# Plan

- [ ] outside section

## TODOs

- [ ] 1. Build state
  - [ ] nested acceptance
- [x] 2. Verify state

## Notes

- [ ] ignored note

## Final Verification Wave

- [ ] F1. Independent review
`

describe("start-work plan identity", () => {
  test("Given mixed checkboxes When parsed Then only column-zero tasks in counted sections are tasks", () => {
    // Given / When
    const result = parseStartWorkPlan(BASE_PLAN)

    // Then
    expect(result.taskIds).toEqual(["1. Build state", "2. Verify state", "F1. Independent review"])
    expect(result.remainingTaskIds).toEqual(["1. Build state", "F1. Independent review"])
  })

  test("Given checkbox-only and nested prose edits When parsed Then static identity is unchanged", () => {
    // Given
    const edited = BASE_PLAN.replace("- [ ] 1. Build state", "- [x] 1. Build state").replace(
      "nested acceptance",
      "rewritten nested acceptance",
    )

    // When
    const before = parseStartWorkPlan(BASE_PLAN)
    const after = parseStartWorkPlan(edited)

    // Then
    expect(after.fingerprint).toBe(before.fingerprint)
    expect(after.taskIds).toEqual(before.taskIds)
  })

  test.each([
    ["rename", BASE_PLAN.replace("Build state", "Build strict state")],
    [
      "reorder",
      BASE_PLAN.replace(
        "- [ ] 1. Build state\n  - [ ] nested acceptance\n- [x] 2. Verify state",
        "- [x] 2. Verify state\n- [ ] 1. Build state",
      ),
    ],
    ["remove", BASE_PLAN.replace("- [x] 2. Verify state\n", "")],
    ["section change", BASE_PLAN.replace("## TODOs", "## Work")],
  ])("Given a task identity %s When parsed Then the fingerprint changes", (_name, edited) => {
    // Given / When
    const before = parseStartWorkPlan(BASE_PLAN)
    const after = parseStartWorkPlan(edited)

    // Then
    expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  test("Given a v1 plan without explicit task ids When normalized Then stable legacy ids are assigned", () => {
    // Given
    const plan = `<!-- omp-lazy-ulw-plan:plan:v1 -->
## TODOs
- [ ] Build state
## Final Verification Wave
- [x] Verify state
`

    // When
    const result = normalizeStartWorkPlan(plan)

    // Then
    expect(result).toMatchObject({
      ok: true,
      value: {
        version: 1,
      },
    })
    if (result.ok) {
      expect(result.value.taskIds[0]).toMatch(/^LEGACY-[0-9a-f]{12}$/)
      expect(result.value.taskIds[1]).toMatch(/^LEGACY-[0-9a-f]{12}$/)
    }
  })

  test("Given duplicate v1 normalized task identities When normalized Then migration-safe rejection is returned", () => {
    // Given
    const plan = `<!-- omp-lazy-ulw-plan:plan:v1 -->
## TODOs
- [ ] **T05. State migration**
## Final Verification Wave
- [ ] **T05. State migration**
`

    // When
    const result = normalizeStartWorkPlan(plan)

    // Then
    expect(result).toEqual({ ok: false, code: "duplicate_normalized_task_identity" })
  })

  test("Given v2 headings out of order When normalized Then the plan identity is rejected", () => {
    // Given
    const plan = `<!-- omp-lazy-ulw-plan:plan:v2 -->
## Scope
## TL;DR (For humans)
## Verification strategy
## Execution strategy
## Todos
- [ ] **T05. State migration**
## Final verification wave
## Commit strategy
## Success criteria
`

    // When
    const result = normalizeStartWorkPlan(plan)

    // Then
    expect(result).toEqual({ ok: false, code: "plan_identity_mismatch" })
  })
})
