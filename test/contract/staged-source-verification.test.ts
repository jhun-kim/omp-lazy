import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  StagedSourceVerificationError,
  verifyInstalledPackage,
} from "../../scripts/staged-source-verification"
import { commitCandidate } from "../fixtures/package-test-helpers"
import { stagedNestedModuleFixture } from "../fixtures/staged-package-with-nested-module"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe("staged source verification", () => {
  it("rejects package-local node_modules before importing the extension", async () => {
    // Given: committed package files plus attacker-controlled package-local module bytes.
    const sourceRoot = await mkdtemp(join(tmpdir(), "omp-lazy-staged-source-"))
    const installedRoot = await mkdtemp(join(tmpdir(), "omp-lazy-staged-installed-"))
    roots.push(sourceRoot, installedRoot)
    const marker = join(installedRoot, "extension-loaded.txt")
    await mkdir(join(sourceRoot, "src"), { recursive: true })
    await writeFile(join(sourceRoot, "package.json"), stagedNestedModuleFixture.packageJson)
    await writeFile(
      join(sourceRoot, "src", "index.ts"),
      stagedNestedModuleFixture.entrypoint(marker),
    )
    const sourceCommit = commitCandidate(sourceRoot)
    await cp(join(sourceRoot, "package.json"), join(installedRoot, "package.json"))
    await cp(join(sourceRoot, "src"), join(installedRoot, "src"), { recursive: true })
    const nestedPath = join(installedRoot, ...stagedNestedModuleFixture.nestedPath.split("/"))
    await mkdir(join(nestedPath, ".."), { recursive: true })
    await writeFile(nestedPath, stagedNestedModuleFixture.nestedBytes)

    // When: verification gates the dynamic extension import.
    const loaded = verifyInstalledPackage({
      installedRoot,
      packedAssets: ["package.json", "src/index.ts"],
      sourceCommit,
      sourceRoot,
    }).then(() => import(pathToFileURL(join(installedRoot, "src", "index.ts")).href))

    // Then: nested dependency bytes reject before the extension can execute.
    await expect(loaded).rejects.toBeInstanceOf(StagedSourceVerificationError)
    expect(await Bun.file(marker).exists()).toBeFalse()
  })
})
