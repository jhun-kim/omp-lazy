// biome-ignore-all format: Each test keeps its exact CLI argv adjacent to its observable assertion.
import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { repositoryRoot } from "../fixtures/package-test-helpers"

describe("OMP harness capability probe", () => {
  it("declares the static scope transport and owned fault codes", async () => {
    // Given: the standalone probe source.
    const source = await readFile(join(repositoryRoot, "scripts", "probe-harness-capability.ts"), "utf8")
    // When: the fast contract inspects the declared public control plane.
    // Then: route headers, seed configuration, and both negative codes remain explicit.
    expect(source).toContain("X-OMP-Harness-Scope")
    expect(source).toContain("extraBody")
    expect(source).toContain("provider_payload_unobservable")
    expect(source).toContain("async_concurrency_missing")
  })
})
