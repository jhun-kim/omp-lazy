import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import {
  type BaselineManifest,
  type BaselineReceipt,
  baselineReceiptSchema,
  baselineRows,
  digest,
  readBaselineManifest,
  readClosureBinding,
} from "./baseline-contract"

const adapterScript = `import { COMMAND_REGISTRATIONS } from "./src/commands/command-definitions.ts"
import { CommandSyntaxError } from "./src/commands/command-parser.ts"
import { CommandStateError, DurableWorkflowCommandExecutor } from "./src/commands/workflow-command-handler.ts"
const scenarios = JSON.parse(process.env.OMP_HARNESS_BASELINE_SCENARIOS ?? "[]")
const results = []
for (const scenario of scenarios) {
  const registration = COMMAND_REGISTRATIONS.find((candidate) => candidate.command === scenario.command)
  if (registration === undefined) throw new TypeError("registered command missing")
  const messages = []
  const executor = new DurableWorkflowCommandExecutor({ store: { readIndex: async () => { throw new TypeError("unexpected state access") } }, suppression: { suppressNext: async () => undefined, runCommand: async (_session, action) => action() }, sendUserMessage: (message) => messages.push(message) })
  try { await executor.execute({ registration, args: scenario.args.join(" "), cwd: ".", sessionId: "baseline" }); results.push({ kind: "activation", messageCount: messages.length }) }
  catch (error) { results.push({ kind: error instanceof CommandStateError || error instanceof CommandSyntaxError ? "grammar_rejected" : "unexpected" }) }
}
process.stdout.write(JSON.stringify(results))`

type AdapterResult = {
  readonly kind: "activation" | "grammar_rejected" | "unexpected"
  readonly messageCount?: number
}

function git(arguments_: readonly string[], cwd: string): string | undefined {
  const result = Bun.spawnSync(["git", "-C", cwd, ...arguments_])
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : undefined
}

async function executeAdapters(
  worktree: string,
  manifest: BaselineManifest,
): Promise<readonly AdapterResult[]> {
  const selected = manifest.scenarios.filter((scenario) =>
    baselineRows.some(
      (row) => row.scenarioId === scenario.id && row.oracleCode !== "public_surface_unavailable",
    ),
  )
  const scriptPath = join(worktree, ".harness-baseline-adapter.ts")
  await writeFile(scriptPath, adapterScript, { flag: "wx" })
  try {
    const child = Bun.spawn(["bun", scriptPath], {
      cwd: worktree,
      env: {
        ...process.env,
        OMP_HARNESS_BASELINE_SCENARIOS: JSON.stringify(
          selected.map((scenario) => ({
            args: scenario.steps[0]?.args ?? [],
            command: scenario.steps[0]?.command ?? "",
          })),
        ),
      },
      stderr: "pipe",
      stdout: "pipe",
    })
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    if (exitCode !== 0) throw new TypeError("baseline adapter execution failed")
    return z
      .array(
        z
          .object({
            kind: z.enum(["activation", "grammar_rejected", "unexpected"]),
            messageCount: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .parse(JSON.parse(stdout))
      .map((result) =>
        result.messageCount === undefined
          ? { kind: result.kind }
          : { kind: result.kind, messageCount: result.messageCount },
      )
  } finally {
    await rm(scriptPath, { force: true })
  }
}

function observed(results: readonly AdapterResult[]): boolean {
  const expected = baselineRows.filter((row) => row.oracleCode !== "public_surface_unavailable")
  return (
    results.length === expected.length &&
    results.every((result, index) => {
      const row = expected[index]
      return (
        row !== undefined &&
        (row.oracleCode === "activation_only"
          ? result.kind === "activation" && result.messageCount === 1
          : result.kind === "grammar_rejected")
      )
    })
  )
}

async function publish(path: string, receipt: BaselineReceipt): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { flag: "wx" })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function runBaselineEvaluation(options: {
  readonly abortAfterClone?: boolean
  readonly manifestPath: string
  readonly outputPath: string
}): Promise<BaselineReceipt> {
  const repositoryRoot = git(["rev-parse", "--show-toplevel"], process.cwd())
  if (repositoryRoot === undefined) throw new TypeError("baseline repository unavailable")
  const [{ bytes, manifest }, closure] = await Promise.all([
    readBaselineManifest(options.manifestPath),
    readClosureBinding(options.manifestPath),
  ])
  if (
    git(["rev-parse", `${manifest.baselineTargetCommit}^{tree}`], repositoryRoot) !==
    manifest.baselineTargetTree
  )
    throw new TypeError("baseline commit mismatch")
  const root = join(
    process.env["TEMP"] ?? process.env["TMP"] ?? repositoryRoot,
    `.baseline-${randomUUID()}`,
  )
  const target = join(root, "target")
  try {
    await mkdir(root, { recursive: true })
    if (
      git(["clone", "--no-checkout", "--shared", repositoryRoot, target], repositoryRoot) ===
      undefined
    )
      throw new TypeError("baseline clone unavailable")
    if (options.abortAfterClone === true) throw new TypeError("baseline execution interrupted")
    if (
      git(["checkout", "--detach", manifest.baselineTargetCommit], target) === undefined ||
      git(["rev-parse", "HEAD"], target) !== manifest.baselineTargetCommit ||
      git(["rev-parse", "HEAD^{tree}"], target) !== manifest.baselineTargetTree ||
      git(["status", "--porcelain"], target) !== ""
    )
      throw new TypeError("baseline checkout mismatch")
    if (!observed(await executeAdapters(target, manifest)))
      throw new TypeError("baseline defect not observed")
    const receipt = baselineReceiptSchema.parse({
      baseline: {
        targetCommit: manifest.baselineTargetCommit,
        targetTree: manifest.baselineTargetTree,
      },
      cleanup: { profile: "not_applicable", temporary: "complete", worktree: "complete" },
      evaluator: {
        closureCommit: closure.closureCommit,
        closureTree: closure.closureTreeHash,
        lockSha256: digest(await readFile(join(repositoryRoot, "harness-eval.lock.json"))),
        manifestSha256: digest(bytes),
      },
      rows: baselineRows.map((row) =>
        row.oracleCode === "public_surface_unavailable"
          ? { ...row, outcome: "NOT_COMPARABLE" }
          : { ...row, outcome: "expected_failure_observed" },
      ),
      schemaVersion: 1,
    })
    await publish(options.outputPath, receipt)
    return receipt
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}
