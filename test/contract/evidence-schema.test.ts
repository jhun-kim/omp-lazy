import { describe, expect, it } from "bun:test"
import { evidenceBundleSchema } from "../../scripts/evidence-contract"

describe("evidence bundle schema", () => {
  it("accepts raw process evidence when every reference is relative", () => {
    // Given
    const bundle = {
      schemaVersion: 1,
      runId: "run-valid",
      principal: { identity: "E-STATE", role: "executor" },
      immutableInputs: { commitSha: "a".repeat(40), manifestSha256: "b".repeat(64) },
      results: [
        {
          scenarioId: "G02",
          status: "PASS",
          process: {
            argv: ["bun", "test"],
            cwd: ".",
            startedAt: "2026-07-13T00:00:00.000Z",
            endedAt: "2026-07-13T00:00:01.000Z",
            durationMs: 1000,
            deadlineMs: 120000,
            timedOut: false,
            exitCode: 0,
            stdout: { path: "raw/G02.stdout.bin", sha256: "c".repeat(64) },
            stderr: { path: "raw/G02.stderr.bin", sha256: "d".repeat(64) },
          },
          cleanup: { processTree: "complete", sandbox: "complete", residue: [] },
        },
      ],
    }

    // When
    const result = evidenceBundleSchema.safeParse(bundle)

    // Then
    expect(result.success).toBe(true)
  })

  it("rejects executor VERIFIED and escaping evidence paths", () => {
    // Given
    const forged = {
      schemaVersion: 1,
      runId: "forged",
      principal: { identity: "E-ARCH", role: "executor" },
      immutableInputs: { commitSha: "a".repeat(40), manifestSha256: "b".repeat(64) },
      results: [
        {
          scenarioId: "G01",
          status: "VERIFIED",
          process: {
            argv: ["bun"],
            cwd: ".",
            startedAt: "2026-07-13T00:00:00.000Z",
            endedAt: "2026-07-13T00:00:00.001Z",
            durationMs: 1,
            deadlineMs: 120000,
            timedOut: false,
            exitCode: 0,
            stdout: { path: "../borrowed.stdout", sha256: "c".repeat(64) },
            stderr: { path: "raw/stderr", sha256: "d".repeat(64) },
          },
          cleanup: { processTree: "complete", sandbox: "complete", residue: [] },
        },
      ],
    }

    // When
    const result = evidenceBundleSchema.safeParse(forged)

    // Then
    expect(result.success).toBe(false)
  })
})
