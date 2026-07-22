import { describe, expect, test } from "bun:test"
import { summarizeParallelismHistory } from "../../src/contracts/parallelism-history"

describe("parallelism history contract", () => {
  test("Given pass and non-pass timing samples When summarized Then only the last fifty eligible durations shape median and p95", () => {
    // Given
    const samples = Array.from({ length: 52 }, (_value, index) => ({
      status: "PASS",
      reservationConsumedAtMs: index,
      parentAcceptedAtMs: index + 10,
      cleanupCompletedAtMs: index + 20,
      startupCommittedAtMs: index,
      firstProviderRequestAtMs: index + 5,
      executionMode: "serial",
    }))
    const history = {
      version: 1,
      key: { moduleBuckets: ["src/contracts"], fileBuckets: ["src/contracts/task-packet.ts"] },
      samples: [
        ...samples,
        {
          status: "FAILED",
          reservationConsumedAtMs: 1,
          parentAcceptedAtMs: 2,
          cleanupCompletedAtMs: 3,
          startupCommittedAtMs: 1,
          firstProviderRequestAtMs: 2,
          executionMode: "serial",
        },
      ],
    }

    // When
    const result = summarizeParallelismHistory(history)

    // Then
    expect(result).toEqual({
      eligibleCount: 50,
      durationMedianMs: 20,
      durationP95Ms: 20,
      startupMedianMs: 5,
      startupP95Ms: 5,
    })
  })

  test("Given fewer than five eligible serial or startup samples When summarized Then history is insufficient", () => {
    // Given
    const history = {
      version: 1,
      key: { moduleBuckets: ["src/contracts"], fileBuckets: ["src/contracts/task-packet.ts"] },
      samples: [
        {
          status: "PASS",
          reservationConsumedAtMs: 0,
          parentAcceptedAtMs: 10,
          cleanupCompletedAtMs: 20,
          startupCommittedAtMs: 0,
          firstProviderRequestAtMs: 4,
          executionMode: "serial",
        },
        {
          status: "BLOCKED",
          reservationConsumedAtMs: 0,
          parentAcceptedAtMs: 10,
          cleanupCompletedAtMs: 20,
          startupCommittedAtMs: 0,
          firstProviderRequestAtMs: 4,
          executionMode: "serial",
        },
      ],
    }

    // When
    const result = summarizeParallelismHistory(history)

    // Then
    expect(result).toEqual({ eligibleCount: 1, code: "parallelism_history_insufficient" })
  })
})
