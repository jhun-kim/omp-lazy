import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createSyntheticHarnessBundle,
  writeSyntheticHarnessBundle,
} from "../../harness-eval/src/synthetic-bundle"
import { verifyHarnessBundle } from "../../harness-eval/src/verifier"

describe("harness evaluator v1 schema", () => {
  it("verifies the complete deterministic 24 scenario x 3 profile x 3 trial bundle", () => {
    // Given
    const bundle = createSyntheticHarnessBundle()

    // When
    const receipt = verifyHarnessBundle(bundle)

    // Then
    expect(receipt).toEqual({ status: "PASS" })
  })

  it("rejects an omitted retry call with usage_call_missing", () => {
    // Given
    const bundle = createSyntheticHarnessBundle({ mutation: "omit_retry_call" })

    // When
    const receipt = verifyHarnessBundle(bundle)

    // Then
    expect(receipt).toEqual({ code: "usage_call_missing", status: "FAIL" })
  })

  it("rejects a candidate-high metric trial with zero reference usage", () => {
    // Given
    const bundle = createSyntheticHarnessBundle({ mutation: "zero_reference_usage" })

    // When
    const receipt = verifyHarnessBundle(bundle)

    // Then
    expect(receipt).toEqual({ code: "zero_reference_usage", status: "FAIL" })
  })

  it("rejects persisted prompt injection and unknown fields", () => {
    // Given
    const bundle = createSyntheticHarnessBundle({ mutation: "persisted_prompt" })

    // When
    const receipt = verifyHarnessBundle(bundle)

    // Then
    expect(receipt).toEqual({ code: "unknown_field", status: "FAIL" })
  })

  it("rejects stale immutable settings and a changed manifest hash", () => {
    // Given
    const staleBundle = createSyntheticHarnessBundle({ mutation: "stale_settings_hash" })
    const changedManifest = createSyntheticHarnessBundle({ mutation: "bad_manifest_hash" })

    // When
    const staleReceipt = verifyHarnessBundle(staleBundle)
    const changedReceipt = verifyHarnessBundle(changedManifest)

    // Then
    expect(staleReceipt).toEqual({ code: "settings_hash_mismatch", status: "FAIL" })
    expect(changedReceipt).toEqual({ code: "manifest_hash_mismatch", status: "FAIL" })
  })

  it("rejects unknown models and an altered effective compatibility seed", () => {
    // Given
    const unknownModel = createSyntheticHarnessBundle({ mutation: "unknown_model" })
    const alteredSeed = createSyntheticHarnessBundle({ mutation: "wire_seed" })

    // When
    const unknownModelReceipt = verifyHarnessBundle(unknownModel)
    const alteredSeedReceipt = verifyHarnessBundle(alteredSeed)

    // Then
    expect(unknownModelReceipt).toEqual({ code: "unknown_model", status: "FAIL" })
    expect(alteredSeedReceipt).toEqual({ code: "wire_sampling_mismatch", status: "FAIL" })
  })
})

describe("harness evaluator CLI", () => {
  it("prints strict structured PASS for a generated bundle", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-harness-eval-"))
    const bundle = await writeSyntheticHarnessBundle(root)

    try {
      // When
      const child = Bun.spawn(["bun", "harness-eval/src/cli.ts", "verify", "--bundle", bundle], {
        cwd: process.cwd(),
        stderr: "pipe",
        stdout: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])

      // Then
      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(JSON.parse(stdout)).toEqual({ status: "PASS" })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects malformed CLI flags before loading a bundle", async () => {
    // Given
    const child = Bun.spawn(["bun", "harness-eval/src/cli.ts", "verify", "--unknown"], {
      cwd: process.cwd(),
      stderr: "pipe",
      stdout: "pipe",
    })

    // When
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])

    // Then
    expect(exitCode).toBe(1)
    expect(JSON.parse(stdout)).toEqual({ code: "malformed_cli", status: "FAIL" })
  })
})
