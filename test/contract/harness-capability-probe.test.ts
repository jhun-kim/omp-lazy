// biome-ignore-all format: Each test keeps its exact CLI argv adjacent to its observable assertion.
import { describe, expect, it } from "bun:test"
import { repositoryRoot, run } from "../fixtures/package-test-helpers"

const command = ["bun", "scripts/run-isolated.ts", "--timeout-ms", "300000", "--cwd", ".", "--env-profile", "omp", "--", "bun", "scripts/probe-harness-capability.ts", "--ephemeral"] as const

describe("OMP harness capability probe", () => {
  it("preserves the preflight parent and worker observation", () => {
    // Given: the unchanged pinned OMP preflight.
    const result = run(["bun", "scripts/run-isolated.ts", "--timeout-ms", "300000", "--cwd", ".", "--env-profile", "omp", "--", "bun", "scripts/preflight-real-omp.ts"], repositoryRoot)
    // When: its one-worker loopback flow executes.
    const receipt = JSON.parse(result.stdout) as { readonly stdout: string }
    // Then: the established two-request observation remains true.
    expect(result.exitCode).toBe(0)
    expect((JSON.parse(receipt.stdout) as { readonly provider: { readonly requestCount: number } }).provider.requestCount).toBe(2)
  }, 300_000)

  it("proves static route scopes and complete capability rows", () => {
    // Given: the real isolated host and evaluator-owned static scope configuration.
    const result = run(command, repositoryRoot)
    // When: the standalone probe executes.
    const receipt = JSON.parse(result.stdout) as { readonly stdout: string }
    // Then: every row passes and records wire transport hashes.
    const probe = JSON.parse(receipt.stdout) as { readonly capabilityRows: readonly { readonly requestHash: string; readonly responseHash: string; readonly status: string }[]; readonly status: string }
    expect(result.exitCode).toBe(0)
    expect(probe.status).toBe("PASS")
    expect(probe.capabilityRows.length).toBeGreaterThanOrEqual(10)
    expect(probe.capabilityRows.every((row) => row.status === "PASS" && row.requestHash.length === 64 && row.responseHash.length === 64)).toBe(true)
  }, 300_000)

  it.each([["omit-payload-scope", "provider_payload_unobservable"], ["serialize-children", "async_concurrency_missing"]] as const)("returns %s for the owned fault", (fault, code) => {
    // Given: one explicit probe-owned fault mode.
    const result = run([...command, "--fault", fault], repositoryRoot)
    // When: the real host probe runs under that fault.
    const receipt = JSON.parse(result.stdout) as { readonly stdout: string }
    // Then: it fails with the stable row code.
    expect(result.exitCode).not.toBe(0)
    expect(receipt.stdout).toContain(code)
  }, 300_000)
})
