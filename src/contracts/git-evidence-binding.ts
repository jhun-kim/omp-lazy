import type { CanonicalRoot } from "../state/domain"

export type GitEvidenceBinding =
  | { readonly ok: true; readonly head: string }
  | { readonly ok: false; readonly code: "git_unavailable" | "dirty_worktree" }

async function git(root: CanonicalRoot, argumentsValue: readonly string[]): Promise<string | null> {
  const process = Bun.spawn(["git", "-C", root.displayPath, ...argumentsValue], {
    stdout: "pipe",
    stderr: "ignore",
    signal: AbortSignal.timeout(5_000),
  })
  const output = await new Response(process.stdout).text()
  return (await process.exited) === 0 ? output.trim() : null
}

export async function readGitEvidenceBinding(root: CanonicalRoot): Promise<GitEvidenceBinding> {
  try {
    const head = await git(root, ["rev-parse", "--verify", "HEAD"])
    if (head === null || !/^[0-9a-f]{40}$/.test(head)) {
      return { ok: false, code: "git_unavailable" }
    }
    const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=normal"])
    if (status === null) return { ok: false, code: "git_unavailable" }
    return status === "" ? { ok: true, head } : { ok: false, code: "dirty_worktree" }
  } catch (error) {
    if (error instanceof Error) return { ok: false, code: "git_unavailable" }
    throw error
  }
}
