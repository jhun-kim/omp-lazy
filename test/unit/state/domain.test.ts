import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newRunId } from "../../../src/state/domain"
import { statePaths } from "../../../src/state/paths"
import { checkWorkingDirectory, resolveAuthoritativeRoot } from "../../../src/state/repo-root"

describe("state domain and repository root", () => {
  async function markNonGit(path: string): Promise<void> {
    await writeFile(join(path, ".git"), "not-a-gitdir")
  }

  test("Given run creation When an id is minted Then it is a UUID", () => {
    // Given / When
    const runId = newRunId()

    // Then
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test("Given a Git worktree nested cwd When resolving Then the Git top level is authoritative", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-git-"))
    Bun.spawnSync(["git", "init", "--quiet", root])
    const nested = join(root, "nested", "deeper")
    await mkdir(nested, { recursive: true })

    // When
    const result = await resolveAuthoritativeRoot({ cwd: nested })

    // Then
    expect(result).toEqual({
      ok: true,
      value: {
        canonicalPath: (await realpath(root)).replaceAll("\\", "/").toLowerCase(),
        displayPath: await realpath(root),
      },
    })
  })

  test("Given a non-Git project without an explicit root When resolving Then it is rejected", async () => {
    // Given
    const cwd = await mkdtemp(join(tmpdir(), "omp-lazy-non-git-"))
    await markNonGit(cwd)

    // When
    const result = await resolveAuthoritativeRoot({ cwd })

    // Then
    expect(result).toEqual({ ok: false, code: "non_git_root_required" })
  })

  test("Given a non-Git project with an explicit root When resolving Then nested cwd is accepted", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-explicit-"))
    await markNonGit(root)
    const nested = join(root, "nested")
    await mkdir(nested)

    // When
    const resolved = await resolveAuthoritativeRoot({ cwd: nested, explicitProjectRoot: root })

    // Then
    expect(resolved.ok).toBeTrue()
  })

  test("Given a persisted root When cwd moves outside Then status reports cwd_mismatch", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-root-"))
    const outside = await mkdtemp(join(tmpdir(), "omp-lazy-outside-"))
    await markNonGit(root)
    await markNonGit(outside)
    const resolved = await resolveAuthoritativeRoot({ cwd: root, explicitProjectRoot: root })
    if (!resolved.ok) throw new Error(resolved.code)

    // When
    const result = await checkWorkingDirectory(resolved.value, outside)

    // Then
    expect(result).toEqual({ ok: false, code: "cwd_mismatch" })
  })

  test("Given a nested symlink escapes the root When cwd is checked Then realpath containment rejects it", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-symlink-root-"))
    const outside = await mkdtemp(join(tmpdir(), "omp-lazy-symlink-outside-"))
    await markNonGit(root)
    await markNonGit(outside)
    const link = join(root, "escape")
    await symlink(outside, link, "junction")
    const resolved = await resolveAuthoritativeRoot({ cwd: root, explicitProjectRoot: root })
    if (!resolved.ok) throw new Error(resolved.code)

    // When
    const result = await checkWorkingDirectory(resolved.value, link)

    // Then
    expect(result).toEqual({ ok: false, code: "cwd_mismatch" })
  })

  test("Given an authoritative root When paths are derived Then every state path stays under it", () => {
    // Given
    const root = { canonicalPath: "c:/repo", displayPath: "C:\\repo" }

    // When
    const paths = statePaths(root)

    // Then
    expect(paths.root).toBe("C:\\repo\\.omo\\omp-lazy")
    expect(paths.activeIndex.startsWith(paths.root)).toBeTrue()
    expect(paths.events.startsWith(paths.root)).toBeTrue()
    expect(paths.runs.startsWith(paths.root)).toBeTrue()
  })
})
