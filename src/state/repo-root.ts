import { realpath } from "node:fs/promises"
import type { CanonicalRoot } from "./domain"
import { canonicalComparisonPath, isCanonicalPathContained } from "./paths"

export type RootResult =
  | { readonly ok: true; readonly value: CanonicalRoot }
  | {
      readonly ok: false
      readonly code: "non_git_root_required" | "cwd_mismatch" | "root_unreadable"
    }

export function resolveAuthoritativeRoot(_options: {
  readonly cwd: string
  readonly explicitProjectRoot?: string
}): Promise<RootResult> {
  return resolveRoot(_options)
}

export function checkWorkingDirectory(_root: CanonicalRoot, _cwd: string): Promise<RootResult> {
  return checkCwd(_root, _cwd)
}

async function gitTopLevel(cwd: string): Promise<string | null> {
  const process = Bun.spawn(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const output = await new Response(process.stdout).text()
  return (await process.exited) === 0 ? output.trim() : null
}

async function resolvedRoot(path: string): Promise<CanonicalRoot | null> {
  try {
    const displayPath = await realpath(path)
    return { canonicalPath: canonicalComparisonPath(displayPath), displayPath }
  } catch (error) {
    if (error instanceof Error) return null
    throw error
  }
}

async function resolveRoot(options: {
  readonly cwd: string
  readonly explicitProjectRoot?: string
}): Promise<RootResult> {
  const cwd = await resolvedRoot(options.cwd)
  if (cwd === null) return { ok: false, code: "root_unreadable" }
  const gitRoot = await gitTopLevel(cwd.displayPath)
  if (gitRoot !== null) {
    const root = await resolvedRoot(gitRoot)
    return root === null ? { ok: false, code: "root_unreadable" } : { ok: true, value: root }
  }
  if (options.explicitProjectRoot === undefined) return { ok: false, code: "non_git_root_required" }
  const root = await resolvedRoot(options.explicitProjectRoot)
  if (root === null) return { ok: false, code: "root_unreadable" }
  if (!isCanonicalPathContained(root.canonicalPath, cwd.canonicalPath)) {
    return { ok: false, code: "cwd_mismatch" }
  }
  return { ok: true, value: root }
}

async function checkCwd(root: CanonicalRoot, cwdPath: string): Promise<RootResult> {
  const cwd = await resolvedRoot(cwdPath)
  if (cwd === null) return { ok: false, code: "root_unreadable" }
  return isCanonicalPathContained(root.canonicalPath, cwd.canonicalPath)
    ? { ok: true, value: root }
    : { ok: false, code: "cwd_mismatch" }
}
