import { describe, expect, test } from "bun:test"
import {
  ParallelismHistoryKeySchema,
  summarizeParallelismHistory,
} from "../../src/contracts/parallelism-history"

describe("parallelism history contract", () => {
  test("Given pass and non-pass timing samples When summarized Then only the last fifty eligible durations shape median and p95", () => {
    // Given
    const samples = Array.from({ length: 52 }, (_value, index) => {
      const durationMs = index < 2 ? 1_000 + index : index - 1
      const startupMs = index < 2 ? 2_000 + index : index - 1
      return {
        status: "PASS" as const,
        reservationConsumedAtMs: 0,
        parentAcceptedAtMs: durationMs,
        cleanupCompletedAtMs: durationMs,
        startupCommittedAtMs: 0,
        firstProviderRequestAtMs: startupMs,
      }
    })
    const history = {
      version: 1,
      key: {
        executionMode: "serial",
        tier: "FAST",
        moduleCount: 1,
        fileBucket: "src/contracts/task-packet.ts",
        boundaryTags: ["none"],
      },
      samples: [
        ...samples,
        {
          status: "FAILED",
          reservationConsumedAtMs: 0,
          parentAcceptedAtMs: 9_999,
          cleanupCompletedAtMs: 9_999,
          startupCommittedAtMs: 0,
          firstProviderRequestAtMs: 9_999,
        },
      ],
    }

    // When
    const result = summarizeParallelismHistory(history)

    // Then
    expect(result).toEqual({
      eligibleCount: 50,
      serialDuration: { eligibleCount: 50, medianMs: 25.5, p95Ms: 48 },
      startup: { eligibleCount: 50, medianMs: 25.5, p95Ms: 48 },
    })
  })

  test("Given fewer than five eligible serial or startup samples When summarized Then history is insufficient", () => {
    // Given
    const history = {
      version: 1,
      key: {
        executionMode: "serial",
        tier: "FAST",
        moduleCount: 1,
        fileBucket: "src/contracts/task-packet.ts",
        boundaryTags: ["none"],
      },
      samples: [
        {
          status: "PASS",
          reservationConsumedAtMs: 0,
          parentAcceptedAtMs: 10,
          cleanupCompletedAtMs: 20,
          startupCommittedAtMs: 0,
          firstProviderRequestAtMs: 4,
        },
        {
          status: "BLOCKED",
          reservationConsumedAtMs: 0,
          parentAcceptedAtMs: 10,
          cleanupCompletedAtMs: 20,
          startupCommittedAtMs: 0,
          firstProviderRequestAtMs: 4,
        },
      ],
    }

    // When
    const result = summarizeParallelismHistory(history)

    // Then
    expect(result).toEqual({
      eligibleCount: 1,
      serialDuration: { eligibleCount: 1, code: "parallelism_history_insufficient" },
      startup: { eligibleCount: 1, code: "parallelism_history_insufficient" },
    })
  })

  test("Given a parallel exact key with enough passes When summarized Then startup emits while serial duration remains gated", () => {
    // Given
    const history = {
      version: 1,
      key: {
        executionMode: "parallel",
        tier: "STANDARD",
        moduleCount: 2,
        fileBucket: "src/contracts/critic-receipt.ts",
        boundaryTags: ["network", "security"],
      },
      samples: Array.from({ length: 5 }, (_value, index) => ({
        status: "PASS",
        reservationConsumedAtMs: index,
        parentAcceptedAtMs: index + 10,
        cleanupCompletedAtMs: index + 20,
        startupCommittedAtMs: index,
        firstProviderRequestAtMs: index + 5,
      })),
    }

    // When
    const result = summarizeParallelismHistory(history)

    // Then
    expect(result).toEqual({
      eligibleCount: 5,
      serialDuration: { eligibleCount: 0, code: "parallelism_history_insufficient" },
      startup: { eligibleCount: 5, medianMs: 5, p95Ms: 5 },
    })
  })

  test("Given a complete history key When canonical paths are parsed Then only repository-relative slash paths or dot are accepted", () => {
    // Given
    const valid = {
      executionMode: "serial",
      tier: "FAST",
      moduleCount: 1,
      fileBucket: ".",
      boundaryTags: ["none"],
    }
    const nonCanonical = { ...valid, fileBucket: "src/./contracts" }
    const incomplete = {
      tier: "FAST",
      moduleCount: 1,
      fileBucket: ".",
      boundaryTags: ["none"],
    }

    // When
    const results = [
      ParallelismHistoryKeySchema.safeParse(valid),
      ParallelismHistoryKeySchema.safeParse(nonCanonical),
      ParallelismHistoryKeySchema.safeParse(incomplete),
    ]

    // Then
    expect(results.map((result) => result.success)).toEqual([true, false, false])
  })
})
