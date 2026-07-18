import { readFile, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { sha256File } from "./artifact-hash"

const candidateReceiptSchema = z
  .object({
    mode: z.literal("build"),
    packageName: z.literal("omp-lazy"),
    packedAssets: z.array(z.string().min(1)).readonly(),
    packInput: z.object({
      dirtyPolicy: z.literal("git-status-porcelain-v1-untracked-files-all"),
      materialization: z.literal("isolated-git-clone-core-autocrlf-false"),
    }),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sourceTree: z.string().regex(/^[a-f0-9]{40}$/),
    tarball: z.string().min(1),
    toolchain: z.object({
      bun: z.string().min(1),
      packageManager: z.literal("bun@1.3.14"),
      typescript: z.literal("6.0.3"),
      zod: z.literal("4.4.3"),
    }),
  })
  .passthrough()

export type CandidateReceipt = z.infer<typeof candidateReceiptSchema>

export class CandidateReceiptError extends Error {
  override readonly name = "CandidateReceiptError"
}

async function runGit(candidate: string, arguments_: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", candidate, ...arguments_], {
    cwd: candidate,
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new CandidateReceiptError(`git ${arguments_.join(" ")} failed: ${stderr}`)
  }
  return stdout.trim()
}

async function verifySource(candidate: string, receipt: CandidateReceipt): Promise<void> {
  const root = await realpath(await runGit(candidate, ["rev-parse", "--show-toplevel"]))
  if (root !== candidate) throw new CandidateReceiptError("candidate must be the Git worktree root")
  const sourceCommit = await runGit(candidate, ["rev-parse", "HEAD"])
  const sourceTree = await runGit(candidate, ["rev-parse", `${sourceCommit}^{tree}`])
  const status = await runGit(candidate, ["status", "--porcelain=v1", "--untracked-files=all"])
  if (sourceCommit !== receipt.sourceCommit || sourceTree !== receipt.sourceTree || status !== "") {
    throw new CandidateReceiptError("candidate worktree changed after packaging")
  }
}

export async function readCandidateReceipt(root: string): Promise<CandidateReceipt> {
  const receiptPath = join(root, ".omo", "evidence", "candidate", "candidate.json")
  const receipt = candidateReceiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")))
  const tarball = resolve(receipt.tarball)
  if ((await sha256File(tarball)) !== receipt.sha256) {
    throw new CandidateReceiptError("candidate tarball hash changed")
  }
  await verifySource(root, receipt)
  return { ...receipt, tarball }
}
