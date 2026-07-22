import { describe, expect, test } from "bun:test"
import { WorkerEvidenceReceiptSchema } from "../../src/contracts/evidence-receipt"

describe("existing evidence receipt contract", () => {
  test("Given an otherwise valid receipt with an unknown field When parsed Then strict validation rejects it", () => {
    // Given
    const receipt = {
      schemaVersion: 1,
      kind: "omp_lazy_worker_evidence",
      runId: "run-1",
      attempt: 0,
      runRevision: 0,
      ownerEpoch: 0,
      taskGeneration: 1,
      workerRole: "omp-lazy-worker-low",
      actualAgentId: "agent-1",
      actualJobId: null,
      captureCommit: "a".repeat(40),
      output: {
        exitCode: 0,
        truncated: false,
        schemaOverridden: false,
        aborted: false,
        blocked: false,
      },
      artifacts: [
        { path: "artifact.txt", capture: { runId: "run-1", attempt: 0, commit: "a".repeat(40) } },
      ],
      cleanup: [{ resourceId: "temp", receiptPath: "cleanup.json" }],
      forged: true,
    }

    // When
    const result = WorkerEvidenceReceiptSchema.safeParse(receipt)

    // Then
    expect(result.success).toBe(false)
  })
})
