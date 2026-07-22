import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BASELINE_RECEIPT_PATH,
  baselineScenarioIds,
  parseBaselineFlags,
  runBaselineEvaluation,
  verifyBaselineReceipt,
} from "../../harness-eval/src/baseline"

const manifestPath = join("harness-eval", "manifest.v1.json")

describe("frozen legacy baseline evaluator", () => {
  it("accepts only the exact legacy baseline grammar", () => {
    // Given the T03 baseline command flags
    const canonical = [
      "--target-commit-from-manifest",
      "--assert-legacy-defects",
      "--scenarios",
      "legacy-eligible",
    ]

    // When grammar parses each supported and unsupported variant
    const parsed = parseBaselineFlags(canonical)
    const missingAssertion = parseBaselineFlags(["--target-commit-from-manifest"])
    const candidateTarget = parseBaselineFlags([...canonical, "--target-commit", "0".repeat(40)])
    const unknown = parseBaselineFlags([...canonical, "--unknown", "value"])

    // Then only the exact frozen form reaches baseline execution
    expect(parsed).toEqual({ manifestPath })
    expect(missingAssertion).toBeUndefined()
    expect(candidateTarget).toBeUndefined()
    expect(unknown).toBeUndefined()
  })

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
      expect(await readFile(output, "utf8")).not.toContain(process.cwd())
      expect(await readFile(output, "utf8")).not.toMatch(/sk-|api[_-]?key|secret/i)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects altered baseline bindings, fake failures, missing rows, and leakage", async () => {
    // Given a valid emitted receipt and independent altered copies
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-baseline-verify-"))
    const receiptPath = join(root, "red-baseline.json")

    try {
      const receipt = await runBaselineEvaluation({ manifestPath, outputPath: receiptPath })
      const malformed = [
        { ...receipt, baseline: { ...receipt.baseline, targetCommit: "0".repeat(40) } },
        { ...receipt, baseline: { ...receipt.baseline, targetTree: "0".repeat(40) } },
        { ...receipt, rows: receipt.rows.slice(1) },
        {
          ...receipt,
          rows: receipt.rows.map((row, index) =>
            index === 0
              ? { ...row, outcome: "expected_failure_observed", oracleCode: "fake" }
              : row,
          ),
        },
        { ...receipt, leaked: "sk-test-secret" },
      ]

      // When each prohibited receipt is checked against the manifest and lock
      const results = await Promise.all(
        malformed.map(async (value, index) => {
          const path = join(root, `altered-${index}.json`)
          await writeFile(path, `${JSON.stringify(value)}\n`)
          return verifyBaselineReceipt({ manifestPath, receiptPath: path })
        }),
      )

      // Then no forged legacy result can be accepted as comparison evidence
      expect(results).toEqual([
        { code: "baseline_commit_mismatch", status: "FAIL" },
        { code: "baseline_commit_mismatch", status: "FAIL" },
        { code: "baseline_receipt_invalid", status: "FAIL" },
        { code: "baseline_receipt_invalid", status: "FAIL" },
        { code: "baseline_receipt_invalid", status: "FAIL" },
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

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
  })
})
