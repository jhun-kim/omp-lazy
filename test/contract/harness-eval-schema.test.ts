import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createSyntheticHarnessBundle,
  writeSyntheticHarnessBundle,
} from "../../harness-eval/src/synthetic-bundle"
import { hashManifest, verifyHarnessBundle } from "../../harness-eval/src/verifier"

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

  it("rejects a manifest-authorized rogue actor route", () => {
    // Given
    const bundle = JSON.parse(JSON.stringify(createSyntheticHarnessBundle()))
    const parent = bundle.manifest.actorMappings.find(
      (mapping: { readonly actorId: string; candidateLowRoute: string }) =>
        mapping.actorId === "parent",
    )
    parent.candidateLowRoute = "/actor/rogue"
    const trial = bundle.trials.find(
      (candidate: {
        readonly profileId: string
        readonly workflow: { readonly calls: readonly unknown[] }
      }) => candidate.profileId === "candidate-low" && candidate.workflow.calls.length > 0,
    )
    const call = trial.workflow.calls.find(
      (candidate: {
        readonly actorId: string
        configuredActorRoute: string
        readonly proxyCallId: number
      }) => candidate.actorId === "parent",
    )
    call.configuredActorRoute = "/actor/rogue"
    const usage = bundle.usage.find(
      (candidate: { readonly proxyCallId: number; configuredActorRoute: string }) =>
        candidate.proxyCallId === call.proxyCallId,
    )
    const proxy = bundle.proxy.find(
      (candidate: { readonly proxyCallId: number; configuredActorRoute: string }) =>
        candidate.proxyCallId === call.proxyCallId,
    )
    usage.configuredActorRoute = "/actor/rogue"
    proxy.configuredActorRoute = "/actor/rogue"
    bundle.manifestHash = hashManifest(bundle.manifest)

    // When
    const receipt = verifyHarnessBundle(bundle)

    // Then
    expect(receipt).toEqual({ code: "actor_route_policy", status: "FAIL" })
  })

  it("rejects a detached zero-call trial scope and rewritten target commit", () => {
    // Given
    const detached = JSON.parse(JSON.stringify(createSyntheticHarnessBundle()))
    const directTrial = detached.trials.find(
      (candidate: { readonly workflow: { readonly calls: readonly unknown[] }; scopeId: string }) =>
        candidate.workflow.calls.length === 0,
    )
    directTrial.scopeId = "f".repeat(32)
    const rewritten = JSON.parse(JSON.stringify(createSyntheticHarnessBundle()))
    rewritten.manifest.targetCommit = "b".repeat(40)
    for (const trial of rewritten.trials) trial.targetCommit = "b".repeat(40)
    rewritten.manifestHash = hashManifest(rewritten.manifest)

    // When
    const detachedReceipt = verifyHarnessBundle(detached)
    const rewrittenReceipt = verifyHarnessBundle(rewritten)

    // Then
    expect(detachedReceipt).toEqual({ code: "scope_binding_mismatch", status: "FAIL" })
    expect(rewrittenReceipt).toEqual({ code: "target_commit_mismatch", status: "FAIL" })
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
        env: { ...process.env, OMP_HARNESS_DEV: "1" },
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

  it("accepts frozen run grammar before reporting an unavailable T02 corpus", async () => {
    // Given
    const child = Bun.spawn(
      [
        "bun",
        "harness-eval/src/cli.ts",
        "run",
        "--mode",
        "deterministic",
        "--manifest",
        "harness-eval/manifest.v1.json",
        "--scenario",
        "plan.clear",
        "--target-commit",
        "HEAD",
      ],
      { cwd: process.cwd(), stderr: "pipe", stdout: "pipe" },
    )

    // When
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])

    // Then
    expect(exitCode).toBe(2)
    expect(JSON.parse(stdout)).toEqual({ code: "manifest_unavailable", status: "BLOCKED" })
  })

  it("rejects invalid comma selectors and verify target commits before manifest lookup", async () => {
    // Given
    const invalidScenarios = Bun.spawn(
      [
        "bun",
        "harness-eval/src/cli.ts",
        "run",
        "--mode",
        "deterministic",
        "--manifest",
        "harness-eval/manifest.v1.json",
        "--scenarios",
        "plan.clear,rogue",
        "--target-commit",
        "HEAD",
      ],
      { cwd: process.cwd(), stdout: "pipe" },
    )
    const invalidTarget = Bun.spawn(
      [
        "bun",
        "harness-eval/src/cli.ts",
        "verify",
        "--manifest",
        "harness-eval/manifest.v1.json",
        "--target-commit",
        "not-a-commit",
      ],
      { cwd: process.cwd(), stdout: "pipe" },
    )

    // When
    const [scenarioCode, scenarioOutput, targetCode, targetOutput] = await Promise.all([
      invalidScenarios.exited,
      new Response(invalidScenarios.stdout).text(),
      invalidTarget.exited,
      new Response(invalidTarget.stdout).text(),
    ])

    // Then
    expect(scenarioCode).toBe(1)
    expect(JSON.parse(scenarioOutput)).toEqual({ code: "malformed_cli", status: "FAIL" })
    expect(targetCode).toBe(1)
    expect(JSON.parse(targetOutput)).toEqual({ code: "malformed_cli", status: "FAIL" })
  })
})
