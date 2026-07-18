import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import { buildEvidenceManifest } from "./evidence-manifest-builder"

const argumentsSchema = z.tuple([
  z.literal("--mode"),
  z.enum(["source", "review"]),
  z.literal("--root"),
  z.string().min(1),
  z.literal("--commit-from-git-head"),
])

class EvidenceGitError extends Error {
  override readonly name = "EvidenceGitError"
}

async function git(arguments_: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn(["git", ...arguments_], { cwd, stderr: "pipe", stdout: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new EvidenceGitError(`git ${arguments_.join(" ")} failed: ${stderr}`)
  return stdout.trim()
}

async function main(): Promise<void> {
  const parsed = argumentsSchema.parse(Bun.argv.slice(2))
  const cwd = await realpath(process.cwd())
  const repositoryRoot = await realpath(await git(["rev-parse", "--show-toplevel"], cwd))
  if (cwd !== repositoryRoot) {
    throw new EvidenceGitError(`run from the Git worktree root: ${repositoryRoot}`)
  }
  const status = await git(["status", "--porcelain=v1", "--untracked-files=no"], cwd)
  if (status.length > 0) throw new EvidenceGitError(`tracked worktree is not clean:\n${status}`)
  const commit = await git(["rev-parse", "HEAD"], cwd)
  const manifest = await buildEvidenceManifest({
    commit,
    mode: parsed[1],
    root: resolve(parsed[3]),
  })
  process.stdout.write(`${JSON.stringify(manifest)}\n`)
}

// no-excuse-ok: catch -- CLI boundary converts validation failures to nonzero.
try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
