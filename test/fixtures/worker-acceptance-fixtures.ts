import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import type { AgentId, JobId, ToolCallId } from "../../src/contracts/agent-ids"
import { AgentIdSchema, JobIdSchema, ToolCallIdSchema } from "../../src/contracts/agent-ids"
import { evidenceRootPath } from "../../src/contracts/artifact-containment"
import type { WorkerRole } from "../../src/contracts/evidence-receipt"
import { WorkerResultAcceptance } from "../../src/contracts/worker-result-acceptance"
import { TaskEventLedger } from "../../src/gates/task-event-ledger"
import { type AnyRun, newRunId, type StartWorkRun, type StateEvent } from "../../src/state/domain"
import { canonicalComparisonPath } from "../../src/state/paths"
import { deadlineAfter } from "../../src/state/repo-lock"
import type { TransactionStore } from "../../src/state/transaction-store"
import { removeTestTree } from "./remove-test-tree"
import { initializedStore } from "./store-fixtures"

export type AcceptanceRuntime = {
  readonly displayPath: string
  readonly store: TransactionStore
  readonly ledger: TaskEventLedger
  readonly acceptance: WorkerResultAcceptance
  readonly run: StartWorkRun
  readonly agentId: AgentId
  readonly jobId: JobId | null
  readonly role: WorkerRole
}

export type ReceiptOverrides = {
  readonly runId?: StartWorkRun["runId"]
  readonly attempt?: number
  readonly runRevision?: number
  readonly ownerEpoch?: number
  readonly taskGeneration?: number
  readonly workerRole?: WorkerRole
  readonly actualAgentId?: AgentId
  readonly actualJobId?: JobId | null
  readonly captureCommit?: string
  readonly output?: Partial<{
    readonly exitCode: number
    readonly truncated: boolean
    readonly schemaOverridden: boolean
    readonly aborted: boolean
    readonly blocked: boolean
  }>
  readonly artifactCaptureRunId?: StartWorkRun["runId"]
  readonly artifactCaptureAttempt?: number
  readonly artifactCaptureCommit?: string
  readonly artifactClaimPath?: string
  readonly cleanupClaims?: readonly { readonly resourceId: string; readonly receiptPath: string }[]
  readonly resources?: readonly {
    readonly resourceId: string
    readonly kind: "tool" | "process" | "worktree" | "resource"
  }[]
  readonly cleanupEvidence?:
    | {
        readonly status: "receipts"
        readonly claims: readonly { readonly resourceId: string; readonly receiptPath: string }[]
      }
    | {
        readonly status: "not_applicable"
        readonly declaration: {
          readonly scenarioId: string
          readonly resourceKinds: readonly []
        }
      }
}

export type EvidenceFiles = {
  readonly receiptPath: string
  readonly artifactPath: string
  readonly cleanupPath: string
}

function git(root: string, argumentsValue: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...argumentsValue], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

export async function acceptanceRuntime(
  label: string,
  options: { readonly jobId?: JobId | null } = {},
): Promise<AcceptanceRuntime> {
  const displayPath = await realpath(await mkdtemp(join(tmpdir(), `omp-lazy-accept-${label}-`)))
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
  const agentId = AgentIdSchema.parse("actual-worker")
  const jobId = options.jobId === undefined ? JobIdSchema.parse("actual-job") : options.jobId
  const role = "omp-lazy-worker-medium" as const
  await bindWorker(ledger, run.owner.sessionId, {
    toolCallId: ToolCallIdSchema.parse("worker-dispatch"),
    agentId,
    jobId,
    role,
  })
  return {
    displayPath,
    store,
    ledger,
    acceptance: new WorkerResultAcceptance(ledger),
    run,
    agentId,
    jobId,
    role,
  }
}

export async function bindWorker(
  ledger: TaskEventLedger,
  sessionId: string,
  worker: {
    readonly toolCallId: ToolCallId
    readonly agentId: AgentId
    readonly jobId: JobId | null
    readonly role: WorkerRole
  },
): Promise<void> {
  const reserved = await ledger.reserve(
    sessionId,
    {
      kind: "task_reserved",
      toolCallId: worker.toolCallId,
      itemCount: 1,
      requests: [{ itemIndex: 0, requestedName: "worker", agentType: worker.role }],
    },
    8,
  )
  if (reserved.kind !== "scope" || reserved.value !== "reserved") throw new Error("reserve failed")
  const bound = await ledger.bind(
    sessionId,
    worker.toolCallId,
    [{ itemIndex: 0, actualAgentId: worker.agentId, actualJobId: worker.jobId }],
    true,
  )
  if (bound.kind !== "scope" || bound.value !== "pending") throw new Error("bind failed")
}

export function gitHead(runtime: AcceptanceRuntime): string {
  return git(runtime.displayPath, ["rev-parse", "HEAD"])
}

export async function writeEvidence(
  runtime: AcceptanceRuntime,
  overrides: ReceiptOverrides = {},
): Promise<EvidenceFiles> {
  const current = await runtime.store.readRun(runtime.run.runId)
  if (current === null) throw new Error("run missing")
  const attempt = current.progressRevision
  const evidenceRoot = evidenceRootPath(runtime.store.root, current.runId, attempt)
  await mkdir(evidenceRoot, { recursive: true })
  const artifactPath = join(evidenceRoot, "result.txt")
  const cleanupPath = join(evidenceRoot, "cleanup.json")
  const receiptPath = join(evidenceRoot, "receipt.json")
  const head = gitHead(runtime)
  await writeFile(artifactPath, "verified worker output\n")
  await writeFile(
    cleanupPath,
    JSON.stringify({
      schemaVersion: 1,
      kind: "omp_lazy_cleanup",
      runId: overrides.runId ?? current.runId,
      attempt: overrides.attempt ?? attempt,
      actualAgentId: overrides.actualAgentId ?? runtime.agentId,
      resourceId: "worker-process",
      status: "cleaned",
      captureCommit: overrides.captureCommit ?? head,
    }),
  )
  const generation = await runtime.ledger.ledgerRevision(current.owner.sessionId)
  if (generation === null) throw new Error("task generation missing")
  const receipt = {
    schemaVersion: 1,
    kind: "omp_lazy_worker_evidence",
    runId: overrides.runId ?? current.runId,
    attempt: overrides.attempt ?? attempt,
    runRevision: overrides.runRevision ?? current.revision,
    ownerEpoch: overrides.ownerEpoch ?? current.owner.epoch,
    taskGeneration: overrides.taskGeneration ?? generation,
    workerRole: overrides.workerRole ?? runtime.role,
    actualAgentId: overrides.actualAgentId ?? runtime.agentId,
    actualJobId: overrides.actualJobId === undefined ? runtime.jobId : overrides.actualJobId,
    captureCommit: overrides.captureCommit ?? head,
    output: {
      exitCode: 0,
      truncated: false,
      schemaOverridden: false,
      aborted: false,
      blocked: false,
      ...overrides.output,
    },
    artifacts: [
      {
        path: overrides.artifactClaimPath ?? relative(runtime.displayPath, artifactPath),
        capture: {
          runId: overrides.artifactCaptureRunId ?? current.runId,
          attempt: overrides.artifactCaptureAttempt ?? attempt,
          commit: overrides.artifactCaptureCommit ?? head,
        },
      },
    ],
    ...(overrides.resources === undefined ? {} : { resources: overrides.resources }),
    cleanup: overrides.cleanupEvidence ??
      overrides.cleanupClaims ?? [
        { resourceId: "worker-process", receiptPath: relative(runtime.displayPath, cleanupPath) },
      ],
  }
  await writeFile(receiptPath, JSON.stringify(receipt))
  return {
    receiptPath: relative(runtime.displayPath, receiptPath),
    artifactPath,
    cleanupPath,
  }
}

export async function acceptanceBytes(runtime: AcceptanceRuntime): Promise<string | null> {
  try {
    return await readFile(
      runtime.acceptance.acceptanceLedger.acceptancePath(runtime.run.runId),
      "utf8",
    )
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

export async function removeRuntime(runtime: AcceptanceRuntime): Promise<void> {
  await removeTestTree(runtime.displayPath)
}

export async function controlRun(
  runtime: AcceptanceRuntime,
  mutation: StateEvent["mutation"],
): Promise<AnyRun> {
  const index = await runtime.store.readIndex()
  const current = await runtime.store.readRun(runtime.run.runId)
  if (current === null) throw new Error("run missing")
  const event: StateEvent = {
    schemaVersion: 1,
    eventId: newRunId(),
    sequence: index.revision + 1,
    runId: current.runId,
    workflow: current.workflow,
    kind: mutation.kind,
    expected: {
      indexRevision: index.revision,
      runRevision: current.revision,
      ownerSessionId: current.owner.sessionId,
      ownerEpoch: current.owner.epoch,
    },
    mutation,
    at: new Date().toISOString(),
  }
  const committed = await runtime.store.commit(event, { deadline: deadlineAfter(2_000) })
  if (!committed.ok) throw new Error(committed.code)
  return committed.run
}
