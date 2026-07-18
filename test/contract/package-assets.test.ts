import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  expectedRuntimeAssets,
  inspect,
  inspectCommand,
  packageAssetTestContext,
  parseReceipt,
  readManifest,
} from "../fixtures/package-asset-test-helpers"
import {
  commitCandidate,
  copyCandidate,
  repositoryRoot,
  run,
  writeJson,
} from "../fixtures/package-test-helpers"

const context = packageAssetTestContext()

afterEach(context.cleanup)

describe("packed assets", () => {
  it("accepts only the reviewed distributable package surface", async () => {
    // Given: the current package root.
    const command = inspectCommand(repositoryRoot)

    // When: the generic candidate inspector performs a Bun dry-run pack.
    const result = run(command)

    // Then: all runtime, skill, agent, and notice assets are packed while development state is excluded.
    expect(result.exitCode).toBe(0)
    const receipt = parseReceipt(result.stdout)
    expect(receipt.requiredAssets).toContain("third_party/lazycodex/LICENSE")
    expect(receipt.forbiddenAssets).toEqual([])
    expect(receipt.mode).toBe("inspect")
    const packedAssets = new Set(receipt.packedAssets)
    for (const asset of await expectedRuntimeAssets()) {
      expect(packedAssets.has(asset)).toBe(true)
    }
  })

  it("rejects a wrong extension entry", async () => {
    // Given: a candidate whose manifest points to an alternate factory.
    const candidate = await copyCandidate("wrong-entry")
    context.candidates.push(candidate)
    const manifest = await readManifest(candidate)
    manifest.omp.extensions = ["./src/other.ts"]
    await writeJson(join(candidate, "package.json"), manifest)

    // When: the candidate surface is inspected.
    const result = inspect(candidate)

    // Then: only the reviewed source entry is accepted.
    expect(result.exitCode).not.toBe(0)
  })

  it("builds and hashes one actual candidate tarball", async () => {
    // Given: a valid candidate and a contained artifact destination.
    const candidate = await copyCandidate("build")
    context.candidates.push(candidate)
    const destination = join(candidate, "artifact")
    const sourceCommit = commitCandidate(candidate)

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
    const receipt = parseReceipt(result.stdout)
    expect(receipt.tarball).toEndWith(".tgz")
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.packageName).toBe("omp-lazy")
    expect(receipt.sourceCommit).toBe(sourceCommit)
    expect(receipt.sourceTree).toMatch(/^[a-f0-9]{40}$/)
    expect(receipt.packInput).toEqual({
      dirtyPolicy: "git-status-porcelain-v1-untracked-files-all",
      materialization: "isolated-git-clone-core-autocrlf-false",
    })
    expect(receipt.toolchain).toEqual({
      bun: "1.3.14",
      packageManager: "bun@1.3.14",
      typescript: "6.0.3",
      zod: "4.4.3",
    })
    expect(receipt.packedAssets).toContain("src/index.ts")
    expect(await Bun.file(join(destination, "candidate.json")).exists()).toBe(true)
  })

  it("rejects development state added to the packed allowlist", async () => {
    // Given: a candidate explicitly packing an .omo secret canary.
    const candidate = await copyCandidate("extra-state")
    context.candidates.push(candidate)
    const manifest = await readManifest(candidate)
    manifest.files = [...manifest.files, ".omo/secret.txt"]
    await writeJson(join(candidate, "package.json"), manifest)
    await mkdir(join(candidate, ".omo"), { recursive: true })
    await writeFile(join(candidate, ".omo", "secret.txt"), "synthetic-secret-canary\n")

    // When: Bun's actual dry-run listing is inspected.
    const result = inspect(candidate)

    // Then: the extra state is named and rejected.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("forbidden packed assets")
  })

  it("rejects a missing notice and a broken skill reference", async () => {
    // Given: a candidate missing its notice with an unresolved relative skill link.
    const candidate = await copyCandidate("missing-assets")
    context.candidates.push(candidate)
    await rm(join(candidate, "THIRD_PARTY_NOTICES.md"))
    await mkdir(join(candidate, "skills", "broken"), { recursive: true })
    await writeFile(
      join(candidate, "skills", "broken", "SKILL.md"),
      "[missing](references/nope.md)\n",
    )

    // When: the candidate surface is inspected.
    const result = inspect(candidate)

    // Then: incomplete distributable documentation is rejected before packaging claims.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("THIRD_PARTY_NOTICES.md")
  })
})
