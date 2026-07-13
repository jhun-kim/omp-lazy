import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { canonicalComparisonPath } from "../state/paths"

export type TeamWorktreeResult =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false
      readonly code:
        | "unreadable"
        | "not_worktree"
        | "unrelated_repo"
        | "main_worktree"
        | "dirty_worktree"
    }

async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const process = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      signal: AbortSignal.timeout(5_000),
    })
    const output = await new Response(process.stdout).text()
    return (await process.exited) === 0 ? output.trim() : null
  } catch (error) {
    if (error instanceof Error) return null
    throw error
  }
}

async function commonDirectory(cwd: string): Promise<string | null> {
  const raw = await git(cwd, ["rev-parse", "--git-common-dir"])
  if (raw === null) return null
  try {
    return await realpath(resolve(cwd, raw))
  } catch (error) {
    if (error instanceof Error) return null
    throw error
  }
}

export async function validateTeamWorktree(
  repositoryRoot: string,
  candidatePath: string,
): Promise<TeamWorktreeResult> {
  let repository: string
  let candidate: string
  try {
    repository = await realpath(repositoryRoot)
    candidate = await realpath(candidatePath)
  } catch (error) {
    if (error instanceof Error) return { ok: false, code: "unreadable" }
    throw error
  }
  const topLevel = await git(candidate, ["rev-parse", "--show-toplevel"])
  if (topLevel === null) return { ok: false, code: "not_worktree" }
  let resolvedTop: string
  try {
    resolvedTop = await realpath(topLevel)
  } catch (error) {
    if (error instanceof Error) return { ok: false, code: "not_worktree" }
    throw error
  }
  if (canonicalComparisonPath(resolvedTop) !== canonicalComparisonPath(candidate)) {
    return { ok: false, code: "not_worktree" }
  }
  const [repositoryCommon, candidateCommon] = await Promise.all([
    commonDirectory(repository),
    commonDirectory(candidate),
  ])
  if (
    repositoryCommon === null ||
    candidateCommon === null ||
    canonicalComparisonPath(repositoryCommon) !== canonicalComparisonPath(candidateCommon)
  ) {
    return { ok: false, code: "unrelated_repo" }
  }
  if (canonicalComparisonPath(repository) === canonicalComparisonPath(candidate)) {
    return { ok: false, code: "main_worktree" }
  }
  const status = await git(candidate, ["status", "--porcelain=v1", "--untracked-files=normal"])
  if (status === null || status !== "") return { ok: false, code: "dirty_worktree" }
  return { ok: true, path: candidate }
}
