// biome-ignore-all format: The exact external CLI argv stays adjacent to the host assertions.
import { describe, expect, it } from "bun:test"
import { repositoryRoot, run } from "../fixtures/package-test-helpers"

const command = ["bun", "scripts/run-isolated.ts", "--timeout-ms", "300000", "--cwd", ".", "--env-profile", "omp", "--", "bun", "scripts/probe-harness-capability.ts", "--ephemeral"] as const

describe("real OMP harness capability probe", () => {
  it("proves complete static-route capabilities", () => {
    const result = run(command, repositoryRoot)
    const receipt = JSON.parse(result.stdout) as { readonly stdout: string }
    const probe = JSON.parse(receipt.stdout) as { readonly capabilityRows: readonly { readonly requestHash: string; readonly responseHash: string; readonly status: string }[]; readonly status: string }
    expect(result.exitCode).toBe(0)
    expect(probe.status).toBe("PASS")
    expect(probe.capabilityRows.every((row) => row.status === "PASS" && row.requestHash.length === 64 && row.responseHash.length === 64)).toBe(true)
  }, 300_000)

  it.each([["omit-payload-scope", "provider_payload_unobservable"], ["serialize-children", "async_concurrency_missing"]] as const)("returns %s for its owned fault", (fault, code) => {
    const result = run([...command, "--fault", fault], repositoryRoot)
    const receipt = JSON.parse(result.stdout) as { readonly stdout: string }
    expect(result.exitCode).not.toBe(0)
    expect(receipt.stdout).toContain(code)
  }, 300_000)
})
