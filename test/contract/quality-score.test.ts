import { describe, expect, test } from "bun:test"
import { calculateQualityScore } from "../../src/contracts/quality-score"

describe("quality score contract", () => {
  test("Given all fixed weighted predicates pass When scored Then the score is 100", () => {
    // Given
    const predicates = [
      { id: "outcome", passed: true, hard: true },
      { id: "scope_safety", passed: true, hard: true },
      { id: "evidence_cleanup", passed: true, hard: true },
      { id: "bounded_process", passed: true, hard: true },
    ]

    // When
    const result = calculateQualityScore(predicates)

    // Then
    expect(result).toEqual({ version: 1, score: 100, hardGatePassed: true })
  })

  test("Given any hard predicate fails When scored Then its score is forced to zero", () => {
    // Given
    const predicates = [
      { id: "outcome", passed: true, hard: true },
      { id: "scope_safety", passed: false, hard: true },
      { id: "evidence_cleanup", passed: true, hard: false },
      { id: "bounded_process", passed: true, hard: false },
    ]

    // When
    const result = calculateQualityScore(predicates)

    // Then
    expect(result).toEqual({ version: 1, score: 0, hardGatePassed: false })
  })
})
