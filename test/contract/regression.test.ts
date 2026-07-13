import { describe, expect, it } from "bun:test"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  HOSTILE_ENVIRONMENTS,
  HOSTILE_REPEATS,
  HOSTILE_SEEDS,
  LATE_EFFECT_HOST_TIMEOUT_MS,
  LATE_EFFECT_WAIT_MS,
} from "../../scripts/replay-hostile"
import { verifyEvidenceBundle } from "../../scripts/verify-candidate"

describe("forged evidence regression", () => {
  it("rejects a hash-consistent executor-authored green bundle", async () => {
    // Given
    const bundle = join(import.meta.dir, "..", "fixtures", "forged-green-bundle", "verdict.json")

    // When
    const result = await verifyEvidenceBundle(bundle)

    // Then
    expect(result.status).toBe("FAIL")
    expect(result.reasons).toEqual(["executor bundle cannot attest G01"])
  })

  it("rejects a structurally valid bundle when raw outputs are missing", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-missing-raw-"))
    const bundle = join(root, "verdict.json")
    await copyFile(
      join(import.meta.dir, "..", "fixtures", "forged-green-bundle", "verdict.json"),
      bundle,
    )

    try {
      // When
      const result = await verifyEvidenceBundle(bundle)

      // Then
      expect(result.status).toBe("FAIL")
      expect(result.reasons).toContain("missing raw evidence: raw/G01.stdout.bin")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("accepts complete attestor raw evidence without treating it as a release verdict", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-valid-raw-"))
    const raw = join(root, "raw")
    await mkdir(raw)
    const stdout = "observed pass\n"
    const stderr = "observed empty stderr\n"
    await Promise.all([
      writeFile(join(raw, "G01.stdout.bin"), stdout),
      writeFile(join(raw, "G01.stderr.bin"), stderr),
    ])
    const hash = (value: string): string =>
      new Bun.CryptoHasher("sha256").update(value).digest("hex")
    const bundle = join(root, "verdict.json")
    await writeFile(
      bundle,
      JSON.stringify({
        schemaVersion: 1,
        runId: "valid-attestor",
        principal: { identity: "A-REL", role: "attestor" },
        immutableInputs: { commitSha: "a".repeat(40), manifestSha256: "b".repeat(64) },
        results: [
          {
            scenarioId: "G01",
            status: "PASS",
            process: {
              argv: ["bun", "test"],
              cwd: ".",
              startedAt: "2026-07-13T00:00:00.000Z",
              endedAt: "2026-07-13T00:00:00.001Z",
              durationMs: 1,
              deadlineMs: 120000,
              timedOut: false,
              exitCode: 0,
              stdout: { path: "raw/G01.stdout.bin", sha256: hash(stdout) },
              stderr: { path: "raw/G01.stderr.bin", sha256: hash(stderr) },
            },
            cleanup: { processTree: "complete", sandbox: "complete", residue: [] },
          },
        ],
      }),
    )

    try {
      // When
      const result = await verifyEvidenceBundle(bundle)

      // Then
      expect(result).toEqual({ status: "PASS", reasons: [] })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("freezes the hostile replay matrix and late-effect observation window", () => {
    // Given
    const expectedRuns = 27

    // When
    const actualRuns = HOSTILE_ENVIRONMENTS.length * HOSTILE_SEEDS.length * HOSTILE_REPEATS

    // Then
    expect(HOSTILE_SEEDS).toEqual([1357, 7331, 424242])
    expect(HOSTILE_ENVIRONMENTS).toEqual(["enabled", "disabled", "unlinked"])
    expect(actualRuns).toBe(expectedRuns)
    expect(LATE_EFFECT_HOST_TIMEOUT_MS).toBe(30_000)
    expect(LATE_EFFECT_WAIT_MS).toBeGreaterThan(30_000)
  })
})
