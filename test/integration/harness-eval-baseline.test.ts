import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BASELINE_RECEIPT_PATH,
  baselineScenarioIds,
  runBaselineEvaluation,
} from "../../harness-eval/src/baseline"

const manifestPath = join("harness-eval", "manifest.v1.json")

describe("frozen legacy baseline evaluator integration", () => {
  it("binds every legacy row to the detached baseline rather than candidate bytes", async () => {
    // Given a temporary noncanonical receipt destination
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-baseline-"))
    const output = join(root, "red-baseline.json")

    try {
      // When the frozen baseline adapters execute against the manifest target
      const receipt = await runBaselineEvaluation({ manifestPath, outputPath: output })

      // Then all frozen rows are complete, redacted, and never candidate PASSes
      expect(receipt.rows.map((row) => row.scenarioId)).toEqual([...baselineScenarioIds])
      expect(receipt.rows.map((row) => row.outcome)).not.toContain("PASS")
      expect(receipt.baseline.targetCommit).not.toBe(
        Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
      )
      expect(receipt.evaluator.closureCommit).toBe(
        (JSON.parse(await readFile("harness-eval.lock.json", "utf8")) as { closureCommit: string })
          .closureCommit,
      )
      expect(await readFile(output, "utf8")).not.toContain(process.cwd())
      expect(await readFile(output, "utf8")).not.toMatch(/sk-|api[_-]?key|secret/i)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 300_000)

  it("publishes deterministically and removes temporary execution state", async () => {
    // Given two isolated receipt destinations
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-baseline-repeat-"))
    const first = join(root, "first.json")
    const second = join(root, "second.json")

    try {
      // When equivalent baseline runs complete
      await runBaselineEvaluation({ manifestPath, outputPath: first })
      await runBaselineEvaluation({ manifestPath, outputPath: second })

      // Then receipts are byte-identical and only the requested files remain
      expect(await readFile(first, "utf8")).toBe(await readFile(second, "utf8"))
      expect(BASELINE_RECEIPT_PATH).toBe(".omo/evidence/harness-redesign/T03/red-baseline.json")
      expect(
        Bun.spawnSync(["git", "worktree", "list", "--porcelain"]).stdout.toString(),
      ).not.toContain("omp-lazy-baseline-")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 300_000)

  it("removes an interrupted disposable clone without registering a worktree", async () => {
    // Given the baseline registry before an interrupted run
    const before = Bun.spawnSync(["git", "worktree", "list", "--porcelain"]).stdout.toString()
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-baseline-interrupt-"))
    try {
      // When execution stops after creating its disposable clone
      await expect(
        runBaselineEvaluation({
          abortAfterClone: true,
          manifestPath,
          outputPath: join(root, "unwritten.json"),
        }),
      ).rejects.toThrow("baseline execution interrupted")

      // Then the registry is unchanged and the clone root is removed
      expect(Bun.spawnSync(["git", "worktree", "list", "--porcelain"]).stdout.toString()).toBe(
        before,
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 300_000)
})
