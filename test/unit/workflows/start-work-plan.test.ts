import { describe, expect, test } from "bun:test"
import { parseStartWorkPlan } from "../../../src/workflows/start-work-plan"

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
})
