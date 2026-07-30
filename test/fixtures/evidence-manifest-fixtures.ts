import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { REVIEW_RECEIPTS, SOURCE_RECEIPTS } from "../../scripts/evidence-manifest-contract"

export const testCommit = "a".repeat(40)

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

async function write(root: string, path: string, contents: string): Promise<void> {
  const target = join(root, ...path.split("/"))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents)
}

export async function createSourceEvidence(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-lazy-evidence-"))
  for (const receipt of SOURCE_RECEIPTS) {
    await write(root, receipt.path, `${receipt.producerTodo} receipt\n`)
  }

  const results = []
  for (let index = 1; index <= 29; index += 1) {
    const scenarioId = `G${String(index).padStart(2, "0")}`
    const stdoutPath = `raw/${scenarioId}/stdout.bin`
    const stderrPath = `raw/${scenarioId}/stderr.bin`
    const stdout = `${scenarioId} stdout\n`
    const stderr = `${scenarioId} stderr\n`
    await write(root, `T14/${stdoutPath}`, stdout)
    await write(root, `T14/${stderrPath}`, stderr)
    results.push({
      process: {
        stderr: { path: stderrPath, sha256: sha256(stderr) },
        stdout: { path: stdoutPath, sha256: sha256(stdout) },
      },
      scenarioId,
      status: "PASS",
    })
  }
  await write(root, "T14/hostile-verdict.json", `${JSON.stringify({ results })}\n`)

  const rejectStdout = "forced reject stdout\n"
  const rejectStderr = "forced reject stderr\n"
  await write(root, "T14/raw/G04/reject.stdout.bin", rejectStdout)
  await write(root, "T14/raw/G04/reject.stderr.bin", rejectStderr)
  await write(
    root,
    "T14/hostile-reject.json",
    `${JSON.stringify({
      process: {
        stderr: { path: "raw/G04/reject.stderr.bin", sha256: sha256(rejectStderr) },
        stdout: { path: "raw/G04/reject.stdout.bin", sha256: sha256(rejectStdout) },
      },
      scenarioId: "G04",
      status: "FAIL",
    })}\n`,
  )
  return root
}

export async function addReviewEvidence(root: string): Promise<void> {
  for (const receipt of REVIEW_RECEIPTS) {
    const contents =
      receipt.path === "final/F3-real-qa.json"
        ? `${JSON.stringify({ verdict: "APPROVE" })}\n`
        : receipt.approval
          ? "# Review\n\nVerdict: APPROVE\n"
          : "verify:release PASS\n"
    await write(root, receipt.path, contents)
  }
}
