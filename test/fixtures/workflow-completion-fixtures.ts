import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { evidenceRootPath } from "../../src/contracts/artifact-containment"
import { canonicalComparisonPath } from "../../src/state/paths"
import {
  publicWorkflowRuntime,
  workflowPlan,
  workflowRepository,
} from "./workflow-lifecycle-fixtures"

export type PublicRuntime = Awaited<ReturnType<typeof publicWorkflowRuntime>>

export function completionRoot(root: string) {
  return { canonicalPath: canonicalComparisonPath(root), displayPath: root }
}

export async function startApprovedWork(label: string): Promise<{
  readonly root: string
  readonly runtime: PublicRuntime
  readonly runId: string
  readonly revision: number
}> {
  const root = await workflowRepository(label)
  await mkdir(join(root, ".omo", "plans"), { recursive: true })
  await writeFile(join(root, ".omo", "plans", "work.md"), workflowPlan)
  const runtime = await publicWorkflowRuntime(root)
  const hash = createHash("sha256").update(workflowPlan).digest("hex")
  await runtime.invoke("ulw-plan(omp)", `approve .omo/plans/work.md ${hash}`)
  await runtime.invoke("start-work(omp)", "start .omo/plans/work.md")
  const created = runtime.results[1]
  if (created?.runId === null || created?.runId === undefined || created.revision === null) {
    throw new Error("start-work result missing scope")
  }
  return { root, runtime, runId: created.runId, revision: created.revision }
}

export async function bindTask(
  runtime: PublicRuntime,
  root: string,
  input: { readonly toolCallId: string; readonly taskId: string; readonly agentId: string },
): Promise<void> {
  const context = {
    cwd: root,
    sessionManager: { getSessionId: () => "parent-session" },
  }
  for (const handler of runtime.extension.handlers.get("tool_call") ?? []) {
    await handler(
      {
        toolName: "task",
        toolCallId: input.toolCallId,
        input: {
          name: input.taskId,
          agent: "omp-lazy-worker-low",
          task: `complete ${input.taskId}`,
        },
      },
      context,
    )
  }
  for (const handler of runtime.extension.handlers.get("tool_result") ?? []) {
    await handler(
      {
        toolName: "task",
        toolCallId: input.toolCallId,
        input: {},
        details: {
          projectAgentsDir: null,
          results: [],
          totalDurationMs: 1,
          progress: [
            {
              index: 0,
              id: input.agentId,
              agent: "omp-lazy-worker-low",
              status: "running",
            },
          ],
          async: { state: "running", jobId: input.agentId, type: "task" },
        },
        isError: false,
      },
      context,
    )
  }
}

export async function acceptTask(
  runtime: PublicRuntime,
  root: string,
  input: {
    readonly runId: string
    readonly runRevision: number
    readonly taskGeneration: number
    readonly agentId: string
    readonly suffix: string
    readonly exitCode?: number | undefined
    readonly expectedKind?: "accepted" | "rejected" | "needs_parent_decision" | undefined
    readonly parentDecision?: "accept_after_review" | undefined
  },
): Promise<void> {
  const head = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim()
  const evidenceRoot = evidenceRootPath(completionRoot(root), input.runId, 1)
  await mkdir(evidenceRoot, { recursive: true })
  const artifactPath = join(evidenceRoot, `result-${input.suffix}.txt`)
  const cleanupPath = join(evidenceRoot, `cleanup-${input.suffix}.json`)
  const receiptPath = join(evidenceRoot, `receipt-${input.suffix}.json`)
  await writeFile(artifactPath, `accepted ${input.suffix}\n`)
  await writeFile(
    cleanupPath,
    JSON.stringify({
      schemaVersion: 1,
      kind: "omp_lazy_cleanup",
      runId: input.runId,
      attempt: 1,
      actualAgentId: input.agentId,
      resourceId: `process-${input.suffix}`,
      status: "cleaned",
      captureCommit: head,
    }),
  )
  await writeFile(
    receiptPath,
    JSON.stringify({
      schemaVersion: 1,
      kind: "omp_lazy_worker_evidence",
      runId: input.runId,
      attempt: 1,
      runRevision: input.runRevision,
      ownerEpoch: 1,
      taskGeneration: input.taskGeneration,
      workerRole: "omp-lazy-worker-low",
      actualAgentId: input.agentId,
      actualJobId: input.agentId,
      captureCommit: head,
      output: {
        exitCode: input.exitCode ?? 0,
        truncated: false,
        schemaOverridden: false,
        aborted: false,
        blocked: false,
      },
      artifacts: [
        {
          path: relative(root, artifactPath),
          capture: { runId: input.runId, attempt: 1, commit: head },
        },
      ],
      cleanup: [
        { resourceId: `process-${input.suffix}`, receiptPath: relative(root, cleanupPath) },
      ],
    }),
  )
  const acceptance = runtime.extension.tools.get("omp_lazy_accept_worker_result")?.definition
  if (acceptance === undefined) throw new Error("public acceptance tool missing")
  const accepted = await acceptance.execute(
    `accept-${input.suffix}`,
    {
      agentId: input.agentId,
      receiptPath: relative(root, receiptPath),
      ...(input.parentDecision === undefined ? {} : { parentDecision: input.parentDecision }),
    },
    undefined,
    undefined,
    {
      cwd: root,
      sessionManager: { getSessionId: () => "parent-session" },
    } as Parameters<typeof acceptance.execute>[4],
  )
  expect(accepted.details).toMatchObject({ kind: input.expectedKind ?? "accepted" })
}

export async function checkPlan(root: string): Promise<void> {
  await writeFile(
    join(root, ".omo", "plans", "work.md"),
    workflowPlan.replace("- [ ] **T1. Complete fixture**", "- [x] **T1. Complete fixture**"),
  )
}

export async function stop(runtime: PublicRuntime, root: string, leafId: string): Promise<void> {
  const handlers = runtime.extension.handlers.get("session_stop") ?? []
  expect(handlers).toHaveLength(1)
  await handlers[0]?.(
    { session_id: "parent-session", turn_id: 0, stop_hook_active: false },
    {
      cwd: root,
      getContextUsage: () => ({ percent: 10 }),
      sessionManager: {
        getSessionId: () => "parent-session",
        getLeafId: () => leafId,
      },
    },
  )
}
