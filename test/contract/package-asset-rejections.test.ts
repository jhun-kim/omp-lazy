import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectCandidate } from "../../scripts/package-guards"
import {
  inspect,
  packageAssetTestContext,
  packedAssetsFor,
  readManifest,
} from "../fixtures/package-asset-test-helpers"
import { copyCandidate, writeJson } from "../fixtures/package-test-helpers"

const context = packageAssetTestContext()

afterEach(context.cleanup)

describe("packed asset rejections", () => {
  it("rejects a missing extension entrypoint before receipt generation", async () => {
    // Given: a copied candidate without the declared OMP extension module.
    const candidate = await copyCandidate("missing-entrypoint")
    context.candidates.push(candidate)
    await rm(join(candidate, "src", "index.ts"), { force: true })

    // When: the candidate surface is inspected.
    const result = inspect(candidate)

    // Then: the receipt is refused before a false package proof is emitted.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("src/index.ts")
  })

  it("rejects a missing explicit manifest file before receipt generation", async () => {
    // Given: a copied candidate without the declared skill-sync verifier.
    const candidate = await copyCandidate("missing-assert-sync")
    context.candidates.push(candidate)
    await rm(join(candidate, "scripts", "assert-skill-sync.ts"), { force: true })

    // When: the candidate surface is inspected.
    const result = inspect(candidate)

    // Then: the declared support file must exist and be packed.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("scripts/assert-skill-sync.ts")
  })

  it("rejects traversal in declared manifest assets", async () => {
    // Given: a valid copied candidate whose manifest tries to name a parent path.
    const candidate = await copyCandidate("traversal")
    context.candidates.push(candidate)
    const packedAssets = await packedAssetsFor(candidate)
    const manifest = await readManifest(candidate)
    manifest.files = [...manifest.files, "../outside.txt"]
    await writeJson(join(candidate, "package.json"), manifest)

    // When: declared assets are inspected against a packed-asset list.
    const inspection = inspectCandidate(candidate, packedAssets)

    // Then: lexical containment rejects the traversal before trusting real paths.
    await expect(inspection).rejects.toThrow("traversal")
  })

  it("rejects a symlinked declared directory escape", async () => {
    // Given: a copied candidate whose declared skills directory is a link to an external tree.
    const candidate = await copyCandidate("symlink-escape")
    context.candidates.push(candidate)
    const externalRoot = await mkdtemp(join(tmpdir(), "omp-lazy-t10-symlink-"))
    context.temporaryRoots.push(externalRoot)
    await mkdir(join(externalRoot, "skills"), { recursive: true })
    await writeFile(join(externalRoot, "skills", "SKILL.md"), "# escaped\n")
    await rm(join(candidate, "skills"), { force: true, recursive: true })
    await symlink(
      join(externalRoot, "skills"),
      join(candidate, "skills"),
      process.platform === "win32" ? "junction" : "dir",
    )

    // When: the candidate surface is inspected.
    const result = inspect(candidate)

    // Then: declared package directories cannot be symlink escapes.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("symlink")
  })

  it("rejects directory entries where the extension declares a file", async () => {
    // Given: a copied candidate whose OMP extension path is replaced by a directory.
    const candidate = await copyCandidate("extension-directory")
    context.candidates.push(candidate)
    await rm(join(candidate, "src", "index.ts"), { force: true })
    await mkdir(join(candidate, "src", "index.ts"), { recursive: true })

    // When: the candidate surface is inspected.
    const result = inspect(candidate)

    // Then: extension entries must resolve to regular files.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("manifest extension must be a file")
  })

  it("rejects directory entries where the files allowlist declares a file", async () => {
    // Given: a copied candidate whose explicit package file path is a directory.
    const candidate = await copyCandidate("manifest-file-directory")
    context.candidates.push(candidate)
    await rm(join(candidate, "scripts", "assert-skill-sync.ts"), { force: true })
    await mkdir(join(candidate, "scripts", "assert-skill-sync.ts"), { recursive: true })

    // When: the candidate surface is inspected.
    const result = inspect(candidate)

    // Then: explicit file entries cannot be directories or other non-files.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("manifest file must be a file")
  })

  it("rejects a declared file absent from packed assets", async () => {
    // Given: a manifest file entry that exists but is absent from the inspected pack listing.
    const candidate = await copyCandidate("unpacked-declared")
    context.candidates.push(candidate)
    const declaredAsset = "EXTRA_RUNTIME_NOTICE.txt"
    const manifest = await readManifest(candidate)
    manifest.files = [...manifest.files, declaredAsset]
    await writeJson(join(candidate, "package.json"), manifest)
    await writeFile(join(candidate, declaredAsset), "extra runtime notice\n")
    const packedAssets = (await packedAssetsFor(candidate)).filter(
      (asset) => asset !== declaredAsset,
    )

    // When: declared assets are compared with the packed-asset list.
    const inspection = inspectCandidate(candidate, packedAssets)

    // Then: every explicit manifest file must appear exactly in packedAssets.
    await expect(inspection).rejects.toThrow(`manifest file is not packed: ${declaredAsset}`)
  })

  it("rejects packed assets not covered by the package manifest", async () => {
    // Given: a real file that is not listed by the package manifest.
    const candidate = await copyCandidate("unlisted-packed")
    context.candidates.push(candidate)
    const unlistedAsset = "UNLISTED_RUNTIME.txt"
    await writeFile(join(candidate, unlistedAsset), "not in package files\n")
    const packedAssets = [...(await packedAssetsFor(candidate)), unlistedAsset]

    // When: packed assets are inspected against the manifest allowlist.
    const inspection = inspectCandidate(candidate, packedAssets)

    // Then: tarball contents cannot exceed the declared package surface.
    await expect(inspection).rejects.toThrow(`unlisted packed asset: ${unlistedAsset}`)
  })
})
