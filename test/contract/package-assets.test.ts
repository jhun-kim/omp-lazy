import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { inspectCandidate } from "../../scripts/package-guards"
import {
  copyCandidate,
  removeCandidate,
  repositoryRoot,
  run,
  writeJson,
} from "../fixtures/package-test-helpers"

const manifestSchema = z
  .object({
    dependencies: z.record(z.string(), z.string()).optional(),
    files: z.array(z.string()),
    omp: z.object({ extensions: z.array(z.string()) }),
  })
  .passthrough()

const receiptSchema = z
  .object({
    forbiddenAssets: z.array(z.string()),
    mode: z.string(),
    packedAssets: z.array(z.string()),
    requiredAssets: z.array(z.string()),
    sha256: z.string().nullable(),
    tarball: z.string().nullable(),
  })
  .passthrough()

type PackageManifest = z.infer<typeof manifestSchema>

const candidates: string[] = []
const temporaryRoots: string[] = []

afterEach(async () =>
  Promise.all([...candidates.splice(0), ...temporaryRoots.splice(0)].map(removeCandidate)),
)

function inspectCommand(candidate: string): readonly string[] {
  return ["bun", "scripts/pack-candidate.ts", "--candidate", candidate, "--mode", "inspect"]
}

function inspect(candidate: string) {
  return run(inspectCommand(candidate))
}

function parseReceipt(stdout: string) {
  return receiptSchema.parse(JSON.parse(stdout))
}

async function readManifest(candidate: string): Promise<PackageManifest> {
  return manifestSchema.parse(JSON.parse(await readFile(join(candidate, "package.json"), "utf8")))
}

async function packedAssetsFor(candidate: string): Promise<readonly string[]> {
  const result = inspect(candidate)
  expect(result.exitCode).toBe(0)
  return parseReceipt(result.stdout).packedAssets
}

async function expectedRuntimeAssets(): Promise<readonly string[]> {
  const assets = ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "scripts/assert-skill-sync.ts"]
  const glob = new Bun.Glob("{src,skills,agents,third_party}/**/*")
  for await (const path of glob.scan({ cwd: repositoryRoot, onlyFiles: true })) {
    assets.push(path.replaceAll("\\", "/"))
  }
  return assets
}

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
    candidates.push(candidate)
    const manifest = await readManifest(candidate)
    manifest.omp.extensions = ["./src/other.ts"]
    await writeJson(join(candidate, "package.json"), manifest)

    // When: the candidate surface is inspected.
    const result = inspect(candidate)

    // Then: only the reviewed source entry is accepted.
    expect(result.exitCode).not.toBe(0)
  })

  it("rejects a missing extension entrypoint before receipt generation", async () => {
    // Given: a copied candidate without the declared OMP extension module.
    const candidate = await copyCandidate("missing-entrypoint")
    candidates.push(candidate)
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
    candidates.push(candidate)
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
    candidates.push(candidate)
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
    candidates.push(candidate)
    const externalRoot = await mkdtemp(join(tmpdir(), "omp-lazy-t10-symlink-"))
    temporaryRoots.push(externalRoot)
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
    candidates.push(candidate)
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
    candidates.push(candidate)
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
    candidates.push(candidate)
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
    candidates.push(candidate)
    const unlistedAsset = "UNLISTED_RUNTIME.txt"
    await writeFile(join(candidate, unlistedAsset), "not in package files\n")
    const packedAssets = [...(await packedAssetsFor(candidate)), unlistedAsset]

    // When: packed assets are inspected against the manifest allowlist.
    const inspection = inspectCandidate(candidate, packedAssets)

    // Then: tarball contents cannot exceed the declared package surface.
    await expect(inspection).rejects.toThrow(`unlisted packed asset: ${unlistedAsset}`)
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
    const receipt = parseReceipt(result.stdout)
    expect(receipt.tarball).toEndWith(".tgz")
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await Bun.file(join(destination, "candidate.json")).exists()).toBe(true)
  })

  it("rejects development state added to the packed allowlist", async () => {
    // Given: a candidate explicitly packing an .omo secret canary.
    const candidate = await copyCandidate("extra-state")
    candidates.push(candidate)
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
    candidates.push(candidate)
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
