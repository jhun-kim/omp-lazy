import { describe, expect, test } from "bun:test"
import { createDeadlineFence, DeadlineFenceError } from "../../../src/continuation/deadline-fence"

describe("deadline fence", () => {
  test("Given a monotonic deadline When time reaches the boundary Then it permanently rejects work", () => {
    // Given
    let now = 1_000
    const fence = createDeadlineFence(250, { nowMs: () => now })

    // When / Then
    expect(fence.isValid()).toBeTrue()
    now = 1_249
    expect(fence.remainingMs()).toBe(1)
    now = 1_250
    expect(fence.isValid()).toBeFalse()
    expect(() => fence.assertValid()).toThrow(DeadlineFenceError)
    now = 1_100
    expect(fence.isValid()).toBeFalse()
  })

  test("Given a live fence When explicitly invalidated Then it cannot be revived", () => {
    // Given
    const fence = createDeadlineFence(250, { nowMs: () => 0 })

    // When
    fence.invalidate()

    // Then
    expect(fence.isValid()).toBeFalse()
  })
})
