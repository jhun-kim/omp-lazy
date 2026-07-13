import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  copyCandidate,
  removeCandidate,
  repositoryRoot,
  run,
  writeJson,
} from "../fixtures/package-test-helpers"

const candidates: string[] = []

afterEach(async () => Promise.all(candidates.splice(0).map(removeCandidate)))

describe("packed assets", () => {
  it("accepts only the reviewed distributable package surface", () => {
    // Given: the current package root.
    const command = [
      "bun",
      "scripts/pack-candidate.ts",
      "--candidate",
      repositoryRoot,
      "--mode",
      "inspect",
    ]

    // When: the generic candidate inspector performs a Bun dry-run pack.
    const result = run(command)

    // Then: required notices are packed and development state is excluded.
    expect(result.exitCode).toBe(0)
    const receipt = JSON.parse(result.stdout)
    expect(receipt.requiredAssets).toContain("third_party/lazycodex/LICENSE")
    expect(receipt.forbiddenAssets).toEqual([])
    expect(receipt.mode).toBe("inspect")
  })

  it("rejects a wrong extension entry", async () => {
    // Given: a candidate whose manifest points to an alternate factory.
    const candidate = await copyCandidate("wrong-entry")
    candidates.push(candidate)
    const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"))
    manifest.omp.extensions = ["./src/other.ts"]
    await writeJson(join(candidate, "package.json"), manifest)

    // When: the candidate surface is inspected.
    const result = run([
      "bun",
      "scripts/pack-candidate.ts",
      "--candidate",
      candidate,
      "--mode",
      "inspect",
    ])

    // Then: only the reviewed source entry is accepted.
    expect(result.exitCode).not.toBe(0)
  })

  it("builds and hashes one actual candidate tarball", async () => {
    // Given: a valid candidate and a contained artifact destination.
    const candidate = await copyCandidate("build")
    candidates.push(candidate)
    const destination = join(candidate, "artifact")

    // When: the generic builder creates the package bytes.
    const result = run([
      "bun",
      "scripts/pack-candidate.ts",
      "--candidate",
      candidate,
      "--mode",
      "build",
      "--destination",
      destination,
    ])

    // Then: the receipt binds an actual tarball to a full SHA-256.
    expect(result.exitCode).toBe(0)
    const receipt = JSON.parse(result.stdout)
    expect(receipt.tarball).toEndWith(".tgz")
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await Bun.file(join(destination, "candidate.json")).exists()).toBe(true)
  })

  it("rejects development state added to the packed allowlist", async () => {
    // Given: a candidate explicitly packing an .omo secret canary.
    const candidate = await copyCandidate("extra-state")
    candidates.push(candidate)
    const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"))
    manifest.files = [...manifest.files, ".omo"]
    await writeJson(join(candidate, "package.json"), manifest)
    await mkdir(join(candidate, ".omo"), { recursive: true })
    await writeFile(join(candidate, ".omo", "secret.txt"), "synthetic-secret-canary\n")

    // When: Bun's actual dry-run listing is inspected.
    const result = run([
      "bun",
      "scripts/pack-candidate.ts",
      "--candidate",
      candidate,
      "--mode",
      "inspect",
    ])

    // Then: the extra state is named and rejected.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("forbidden packed assets")
  })

  it("rejects a missing notice and a broken skill reference", async () => {
    // Given: a candidate missing its notice with an unresolved relative skill link.
    const candidate = await copyCandidate("missing-assets")
    candidates.push(candidate)
    await rm(join(candidate, "THIRD_PARTY_NOTICES.md"))
    await mkdir(join(candidate, "skills", "broken"), { recursive: true })
    await writeFile(
      join(candidate, "skills", "broken", "SKILL.md"),
      "[missing](references/nope.md)\n",
    )

    // When: the candidate surface is inspected.
    const result = run([
      "bun",
      "scripts/pack-candidate.ts",
      "--candidate",
      candidate,
      "--mode",
      "inspect",
    ])

    // Then: incomplete distributable documentation is rejected before packaging claims.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("THIRD_PARTY_NOTICES.md")
  })
})
