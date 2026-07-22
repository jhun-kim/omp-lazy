import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { evidenceRootPath } from "../../src/contracts/artifact-containment"
import { WorkerResultAcceptance } from "../../src/contracts/worker-result-acceptance"
import { TaskEventLedger } from "../../src/gates/task-event-ledger"
import { taskGeneration } from "../../src/gates/task-ledger-view"
import { TaskSpawnGuard } from "../../src/gates/task-spawn-guard"
import { ToolResultObserver } from "../../src/observers/tool-result-observer"
import { canonicalComparisonPath } from "../../src/state/paths"
import { type TeamDefinition, TeammodeContract } from "../../src/workflows/teammode-contract"
import { removeTestTree } from "./remove-test-tree"
import { initializedStore } from "./store-fixtures"

function git(root: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

export const teamDefinition: TeamDefinition = {
  teamName: "delivery-team",
  members: [
    {
      requestedName: "implementation",
      agentType: "omp-lazy-worker-medium",
      focus: "implementation",
      ownership: ["src/feature"],
      deliverable: "implementation receipt",
      isolated: true,
    },
    {
      requestedName: "verification",
      agentType: "omp-lazy-worker-low",
      focus: "verification",
      ownership: ["test/feature"],
      deliverable: "verification receipt",
      isolated: true,
    },
  ],
}

export async function teamRuntime(label: string) {
  const displayPath = await realpath(await mkdtemp(join(tmpdir(), `omp-lazy-team-${label}-`)))
  git(displayPath, ["init", "--quiet"])
  git(displayPath, ["config", "user.email", "fixture@example.invalid"])
  git(displayPath, ["config", "user.name", "Fixture"])
  await writeFile(join(displayPath, ".gitignore"), ".omo/\n")
  await writeFile(join(displayPath, "tracked.txt"), "seed\n")
  git(displayPath, ["add", ".gitignore", "tracked.txt"])
  git(displayPath, ["commit", "--quiet", "-m", "fixture"])
  const root = { canonicalPath: canonicalComparisonPath(displayPath), displayPath }
  const { store, run } = await initializedStore(root)
  const ledger = new TaskEventLedger(store)
  const contract = new TeammodeContract(ledger)
  const caller = {
    sessionId: run.owner.sessionId,
    cwd: displayPath,
    toolNames: ["task", "hub"],
  }
  return { displayPath, store, run, ledger, contract, caller }
}

export async function bindTeam(
  runtime: Awaited<ReturnType<typeof teamRuntime>>,
  asyncAvailable = true,
) {
  await observeTeam(runtime, asyncAvailable)
  return runtime.contract.bind(runtime.caller, teamDefinition.teamName)
}

export async function observeTeam(
  runtime: Awaited<ReturnType<typeof teamRuntime>>,
  asyncAvailable = true,
): Promise<void> {
  const guard = new TaskSpawnGuard(runtime.ledger, 8)
  const observer = new ToolResultObserver(runtime.ledger)
  const tasks = teamDefinition.members.map((member) => ({
    name: member.requestedName,
    agent: member.agentType,
    task: member.focus,
    isolated: member.isolated,
  }))
  await guard.handle({
    toolName: "task",
    toolCallId: "team-dispatch",
    input: { context: "team", tasks },
    sessionId: runtime.caller.sessionId,
  })
  const ids = ["actual-implementation", "actual-verification"]
  await observer.observe({
    toolName: "task",
    toolCallId: "team-dispatch",
    input: {},
    details: {
      projectAgentsDir: null,
      results: [],
      totalDurationMs: 1,
      progress: ids.map((id, index) => ({
        index,
        id,
        agent: tasks[index]?.agent,
        status: "running",
      })),
      ...(asyncAvailable ? { async: { state: "running", jobId: ids[0], type: "task" } } : {}),
    },
    isError: false,
    sessionId: runtime.caller.sessionId,
  })
  if (asyncAvailable) {
    await guard.handle({
      toolName: "job",
      toolCallId: "team-jobs",
      input: { list: true },
      sessionId: runtime.caller.sessionId,
    })
    await observer.observe({
      toolName: "job",
      toolCallId: "team-jobs",
      input: { list: true },
      details: {
        jobs: ids.map((id) => ({ id, type: "task", status: "running", label: id, durationMs: 1 })),
      },
      isError: false,
      sessionId: runtime.caller.sessionId,
    })
  }
}

export async function removeTeamRuntime(
  runtime: Awaited<ReturnType<typeof teamRuntime>>,
): Promise<void> {
  await removeTestTree(runtime.displayPath)
}

export async function acceptTeamResults(
  runtime: Awaited<ReturnType<typeof teamRuntime>>,
): Promise<void> {
  const acceptance = new WorkerResultAcceptance(runtime.ledger)
  const current = await runtime.store.readRun(runtime.run.runId)
  const scope = await runtime.ledger.resolve(runtime.caller.sessionId)
  if (current === null || scope.kind !== "scope") throw new Error("team acceptance scope missing")
  const generation = taskGeneration(scope.value)
  const identities = await runtime.ledger.identities(runtime.caller.sessionId)
  const root = evidenceRootPath(runtime.store.root, current.runId, current.progressRevision)
  await mkdir(root, { recursive: true })
  const head = git(runtime.displayPath, ["rev-parse", "HEAD"])
  for (const identity of identities) {
    const suffix = String(identity.actualAgentId).replaceAll(/[^a-zA-Z0-9-]/g, "-")
    const artifactPath = join(root, `${suffix}-result.txt`)
    const cleanupPath = join(root, `${suffix}-cleanup.json`)
    const receiptPath = join(root, `${suffix}-receipt.json`)
    await writeFile(artifactPath, `verified output for ${suffix}\n`)
    await writeFile(
      cleanupPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "omp_lazy_cleanup",
        runId: current.runId,
        attempt: current.progressRevision,
        actualAgentId: identity.actualAgentId,
        resourceId: `${suffix}-process`,
        status: "cleaned",
        captureCommit: head,
      }),
    )
    await writeFile(
      receiptPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "omp_lazy_worker_evidence",
        runId: current.runId,
        attempt: current.progressRevision,
        runRevision: current.revision,
        ownerEpoch: current.owner.epoch,
        taskGeneration: generation,
        workerRole: identity.agentType,
        actualAgentId: identity.actualAgentId,
        actualJobId: identity.actualJobId,
        captureCommit: head,
        output: {
          exitCode: 0,
          truncated: false,
          schemaOverridden: false,
          aborted: false,
          blocked: false,
        },
        artifacts: [
          {
            path: relative(runtime.displayPath, artifactPath),
            capture: { runId: current.runId, attempt: current.progressRevision, commit: head },
          },
        ],
        cleanup: [
          {
            resourceId: `${suffix}-process`,
            receiptPath: relative(runtime.displayPath, cleanupPath),
          },
        ],
      }),
    )
    const result = await acceptance.accept(runtime.caller, {
      agentId: identity.actualAgentId,
      receiptPath: relative(runtime.displayPath, receiptPath),
    })
    if (result.kind !== "accepted")
      throw new Error(`acceptance failed: ${"code" in result ? result.code : result.kind}`)
  }
}

export function createWorktree(repository: string, label: string): string {
  const path = join(repository, "..", `${label}-${crypto.randomUUID()}`)
  git(repository, ["worktree", "add", "--quiet", "--detach", path, "HEAD"])
  return path
}
