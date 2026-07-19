import { afterEach, describe, expect, it } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import {
  copyCandidate,
  removeCandidate,
  repositoryRoot,
  run,
} from "../fixtures/package-test-helpers"

const candidates: string[] = []

afterEach(async () => Promise.all(candidates.splice(0).map(removeCandidate)))

describe("source attribution", () => {
  it("accepts the reviewed full source hashes and license chain", () => {
    // Given: the package's checked-in provenance.
    const command = [
      "bun",
      "scripts/pack-candidate.ts",
      "--candidate",
      repositoryRoot,
      "--mode",
      "inspect",
    ]

    // When: attribution is inspected with the package surface.
    const result = run(command)

    // Then: both reviewed commits are retained in full.
    expect(result.exitCode).toBe(0)
    const receipt = JSON.parse(result.stdout)
    expect(receipt.sourceCommits).toEqual({
      lazycodex: "f39306f1adab6ff155fd736cc7376d27156472bc",
      omp: "9fd6e97113f5ed3a847e66d346970efdf8afcad9",
    })
  })

  it("rejects a missing third-party license", async () => {
    // Given: a candidate whose notice points to a removed license.
    const candidate = await copyCandidate("missing-license")
    candidates.push(candidate)
    await rm(join(candidate, "third_party", "lazycodex", "LICENSE"))

    // When: attribution is inspected.
    const result = run([
      "bun",
      "scripts/pack-candidate.ts",
      "--candidate",
      candidate,
      "--mode",
      "inspect",
    ])

    // Then: the incomplete attribution chain fails closed.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("third_party/lazycodex/LICENSE")
  })
})
