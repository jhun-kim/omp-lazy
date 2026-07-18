import { afterEach, describe, expect, it } from "bun:test"
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  buildEvidenceManifest,
  EvidenceManifestError,
} from "../../scripts/evidence-manifest-builder"
import { createSourceEvidence, testCommit } from "../fixtures/evidence-manifest-fixtures"
import { repositoryRoot, run } from "../fixtures/package-test-helpers"

const roots: string[] = []

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))),
)

async function fixture(): Promise<string> {
  const root = await createSourceEvidence()
  roots.push(root)
  return root
}

describe("source evidence manifest", () => {
  it("hashes the exhaustive T01-T15 receipt set and referenced T14 raw evidence", async () => {
    // Given
    const root = await fixture()

    // When
    const manifest = await buildEvidenceManifest({ commit: testCommit, mode: "source", root })

    // Then
    expect(manifest.mode).toBe("source")
    expect(manifest.commit).toBe(testCommit)
    expect(manifest.entries.map((entry) => entry.path)).toEqual(
      manifest.entries.map((entry) => entry.path).toSorted(),
    )
    expect(
      manifest.entries.some((entry) => entry.path === "T01/delta-classification.json"),
    ).toBeTrue()
    expect(manifest.entries.some((entry) => entry.path === "T15/release-reject.txt")).toBeTrue()
    expect(manifest.entries.some((entry) => entry.path === "T14/raw/G25/stdout.bin")).toBeTrue()
  })

  it("rejects an omitted required T14 receipt", async () => {
    // Given
    const root = await fixture()
    await rm(join(root, "T14", "hostile-reject.json"))

    // When
    const result = buildEvidenceManifest({ commit: testCommit, mode: "source", root })

    // Then
    await expect(result).rejects.toThrow("missing evidence file: T14/hostile-reject.json")
  })

  it("rejects empty staged evidence", async () => {
    // Given
    const root = await fixture()
    await writeFile(join(root, "T12", "staged-verdict.json"), "")

    // When
    const result = buildEvidenceManifest({ commit: testCommit, mode: "source", root })

    // Then
    await expect(result).rejects.toThrow("empty evidence file: T12/staged-verdict.json")
  })

  it("rejects an undeclared evidence file", async () => {
    // Given
    const root = await fixture()
    await writeFile(join(root, "T10", "undeclared.txt"), "not declared\n")

    // When
    const result = buildEvidenceManifest({ commit: testCommit, mode: "source", root })

    // Then
    await expect(result).rejects.toThrow("unexpected evidence file: T10/undeclared.txt")
  })

  it("rejects a lexical escape declared by a hostile receipt", async () => {
    // Given
    const root = await fixture()
    await writeFile(
      join(root, "T14", "hostile-reject.json"),
      `${JSON.stringify({
        process: {
          stderr: { path: "raw/G04/reject.stderr.bin", sha256: "b".repeat(64) },
          stdout: { path: "../escape.bin", sha256: "c".repeat(64) },
        },
        scenarioId: "G04",
        status: "FAIL",
      })}\n`,
    )

    // When
    const result = buildEvidenceManifest({ commit: testCommit, mode: "source", root })

    // Then
    await expect(result).rejects.toBeInstanceOf(EvidenceManifestError)
    await expect(result).rejects.toThrow("escaping T14 raw evidence path")
  })

  it("binds CLI output to Git HEAD only while tracked files are clean", async () => {
    // Given
    const source = await fixture()
    const repository = await mkdtemp(join(tmpdir(), "omp-lazy-evidence-git-"))
    roots.push(repository)
    const root = join(repository, ".omo", "evidence", "plugin-completion-60")
    await mkdir(dirname(root), { recursive: true })
    await cp(source, root, { recursive: true })
    await writeFile(join(repository, "tracked.txt"), "clean\n")
    for (const command of [
      ["git", "init", "--quiet"],
      ["git", "config", "user.name", "Evidence Test"],
      ["git", "config", "user.email", "evidence@example.invalid"],
      ["git", "add", "tracked.txt"],
      ["git", "commit", "--quiet", "-m", "evidence fixture"],
    ]) {
      expect(run(command, repository).exitCode).toBe(0)
    }
    const script = join(repositoryRoot, "scripts", "build-evidence-manifest.ts")

    // When
    const clean = run(
      ["bun", script, "--mode", "source", "--root", root, "--commit-from-git-head"],
      repository,
    )
    await appendFile(join(repository, "tracked.txt"), "dirty\n")
    const dirty = run(
      ["bun", script, "--mode", "source", "--root", root, "--commit-from-git-head"],
      repository,
    )

    // Then
    expect(clean.exitCode).toBe(0)
    expect(JSON.parse(clean.stdout).commit).toMatch(/^[a-f0-9]{40}$/)
    expect(dirty.exitCode).not.toBe(0)
    expect(dirty.stderr).toContain("tracked worktree is not clean")
  })
})
