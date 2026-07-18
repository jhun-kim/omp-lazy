import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import { sha256File } from "./artifact-hash"
import { inspectCandidate } from "./package-guards"

const argumentsSchema = z.union([
  z.tuple([]),
  z.tuple([z.literal("--candidate"), z.string().min(1), z.literal("--mode"), z.literal("inspect")]),
  z.tuple([
    z.literal("--candidate"),
    z.string().min(1),
    z.literal("--mode"),
    z.literal("build"),
    z.literal("--destination"),
    z.string().min(1),
  ]),
])

class PackageBuildError extends Error {
  override readonly name = "PackageBuildError"
}

type ProcessReceipt = {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

type MaterializedCandidate = {
  readonly root: string
  readonly sourceCommit: string
  readonly sourceTree: string
}

async function run(command: readonly string[], cwd: string): Promise<ProcessReceipt> {
  const child = Bun.spawn([...command], { cwd, stderr: "pipe", stdout: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stderr, stdout }
}

async function git(candidate: string, arguments_: readonly string[]): Promise<string> {
  const receipt = await run(["git", "-C", candidate, ...arguments_], candidate)
  if (receipt.exitCode !== 0) {
    throw new PackageBuildError(
      `git ${arguments_.join(" ")} failed (${receipt.exitCode}): ${receipt.stderr}`,
    )
  }
  return receipt.stdout.trim()
}

async function requireCleanCandidate(
  candidate: string,
  expectedCommit?: string,
): Promise<{ readonly sourceCommit: string; readonly sourceTree: string }> {
  const repositoryRoot = await realpath(await git(candidate, ["rev-parse", "--show-toplevel"]))
  if (repositoryRoot !== candidate) {
    throw new PackageBuildError(`candidate must be the Git worktree root: ${candidate}`)
  }
  const sourceCommit = await git(candidate, ["rev-parse", "HEAD"])
  if (expectedCommit !== undefined && sourceCommit !== expectedCommit) {
    throw new PackageBuildError(
      `candidate HEAD changed during packaging: expected ${expectedCommit}, received ${sourceCommit}`,
    )
  }
  const status = await git(candidate, ["status", "--porcelain=v1", "--untracked-files=all"])
  if (status !== "") throw new PackageBuildError(`candidate worktree is not clean:\n${status}`)
  const sourceTree = await git(candidate, ["rev-parse", `${sourceCommit}^{tree}`])
  return { sourceCommit, sourceTree }
}

async function materializeCommittedCandidate(candidate: string): Promise<MaterializedCandidate> {
  const source = await requireCleanCandidate(candidate)
  const root = await mkdtemp(join(tmpdir(), "omp-lazy-pack-"))
  try {
    const clone = await run(
      ["git", "clone", "--no-checkout", "--shared", candidate, root],
      candidate,
    )
    if (clone.exitCode !== 0) {
      throw new PackageBuildError(`git clone failed (${clone.exitCode}): ${clone.stderr}`)
    }
    await git(root, ["config", "core.autocrlf", "false"])
    await git(root, ["checkout", "--detach", "--force", source.sourceCommit])
    const materialized = await requireCleanCandidate(root, source.sourceCommit)
    if (materialized.sourceTree !== source.sourceTree) {
      throw new PackageBuildError(
        `materialized tree changed: expected ${source.sourceTree}, received ${materialized.sourceTree}`,
      )
    }
    return { root, ...source }
  } catch (error) {
    await rm(root, { force: true, recursive: true })
    throw error
  }
}

async function toolchainReceipt(): Promise<{
  readonly bun: string
  readonly packageManager: "bun@1.3.14"
  readonly typescript: "6.0.3"
  readonly zod: "4.4.3"
}> {
  const bun = await run(["bun", "--version"], process.cwd())
  if (bun.exitCode !== 0) throw new PackageBuildError(`bun --version failed: ${bun.stderr}`)
  return {
    bun: bun.stdout.trim(),
    packageManager: "bun@1.3.14",
    typescript: "6.0.3",
    zod: "4.4.3",
  }
}

function packedAssets(output: string): readonly string[] {
  return output
    .split(/\r?\n/)
    .map((line) => /^packed\s+\S+\s+(.+)$/.exec(line)?.[1]?.replaceAll("\\", "/"))
    .filter((path): path is string => path !== undefined)
}

async function prepareDestination(
  candidate: string,
  destination: string | undefined,
): Promise<void> {
  if (destination === undefined) return
  const fromCandidate = relative(candidate, destination)
  if (fromCandidate === "" || fromCandidate.startsWith("..") || isAbsolute(fromCandidate)) {
    throw new PackageBuildError(`package destination escapes candidate root: ${destination}`)
  }
  await mkdir(destination, { recursive: true })
  await rm(join(destination, "candidate.json"), { force: true })
  const tarballs = new Bun.Glob("*.tgz")
  for await (const tarball of tarballs.scan({ cwd: destination, onlyFiles: true })) {
    await rm(join(destination, tarball), { force: true })
  }
}

async function main(): Promise<void> {
  const parsed = argumentsSchema.parse(Bun.argv.slice(2))
  const isDefault = parsed.length === 0
  const candidate = await realpath(resolve(isDefault ? process.cwd() : parsed[1]))
  const mode = isDefault ? "build" : parsed[3]
  const destination =
    mode === "build"
      ? resolve(
          isDefault
            ? join(candidate, ".omo", "evidence", "candidate")
            : z.string().parse(parsed[5]),
        )
      : undefined
  let materialized: MaterializedCandidate | undefined
  try {
    materialized = mode === "build" ? await materializeCommittedCandidate(candidate) : undefined
    const packRoot = materialized?.root ?? candidate
    await prepareDestination(candidate, destination)

    const pack = Bun.spawn(
      destination === undefined
        ? ["bun", "pm", "pack", "--dry-run"]
        : ["bun", "pm", "pack", "--destination", destination],
      { cwd: packRoot, stderr: "pipe", stdout: "pipe" },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      pack.exited,
      new Response(pack.stdout).text(),
      new Response(pack.stderr).text(),
    ])
    if (exitCode !== 0) throw new PackageBuildError(`bun pack failed (${exitCode}): ${stderr}`)

    const assets = packedAssets(`${stdout}\n${stderr}`)
    const inspection = await inspectCandidate(packRoot, assets)
    const tarballName = /([^\s]+\.tgz)/.exec(`${stdout}\n${stderr}`)?.[1]
    const tarball =
      destination === undefined || tarballName === undefined
        ? null
        : resolve(destination, tarballName)
    const sha256 = tarball === null ? null : await sha256File(tarball)
    if (materialized !== undefined)
      await requireCleanCandidate(candidate, materialized.sourceCommit)
    const receipt = {
      ...inspection,
      mode,
      packageName: mode === "build" ? "omp-lazy" : null,
      packInput:
        materialized === undefined
          ? null
          : {
              dirtyPolicy: "git-status-porcelain-v1-untracked-files-all",
              materialization: "isolated-git-clone-core-autocrlf-false",
            },
      sha256,
      sourceCommit: materialized?.sourceCommit ?? null,
      sourceTree: materialized?.sourceTree ?? null,
      tarball,
      toolchain: mode === "build" ? await toolchainReceipt() : null,
    }
    if (tarball !== null && destination !== undefined) {
      const receiptPath = join(destination, "candidate.json")
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
      await Promise.all([chmod(receiptPath, 0o444), chmod(tarball, 0o444)])
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  } finally {
    if (materialized !== undefined) await rm(materialized.root, { force: true, recursive: true })
  }
}

// no-excuse-ok: catch — candidate inspection is a CLI boundary.
try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
