import { afterEach, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { evidenceRootPath } from "../../src/contracts/artifact-containment"
import {
  cleanupWorkflowRoots,
  publicWorkflowRuntime,
  workflowRepository,
} from "../fixtures/workflow-lifecycle-fixtures"

afterEach(async () => {
  await cleanupWorkflowRoots()
})

test("Given current accepted evidence When checkpoint runs Then the reducer completes the ULW run", async () => {
  // Given: a public ULW run with one coordinator-reserved and host-bound child result.
  const root = await workflowRepository("checkpoint-accepted")
  const runtime = await publicWorkflowRuntime(root)
  await runtime.invoke("ulw-loop(omp)", "create complete accepted evidence")
  const created = runtime.results[0]
  if (created?.runId === null || created?.runId === undefined || created.revision === null) {
    throw new Error("ULW create result missing scope")
  }
  const sessionId = "parent-session"
  const context = {
    cwd: root,
    sessionManager: { getSessionId: () => sessionId },
  }
  const toolCallId = "criterion-dispatch"
  for (const handler of runtime.extension.handlers.get("tool_call") ?? []) {
    await handler(
      {
        toolName: "task",
        toolCallId,
        input: {
          name: "criterion-1",
          agent: "omp-lazy-worker-low",
          task: "produce criterion evidence",
        },
      },
      context,
    )
  }
  for (const handler of runtime.extension.handlers.get("tool_result") ?? []) {
    await handler(
      {
        toolName: "task",
        toolCallId,
        input: {},
        details: {
          projectAgentsDir: null,
          results: [],
          totalDurationMs: 1,
          progress: [
            {
              index: 0,
              id: "criterion-agent",
              agent: "omp-lazy-worker-low",
              status: "running",
            },
          ],
          async: { state: "running", jobId: "criterion-agent", type: "task" },
        },
        isError: false,
      },
      context,
    )
  }
  const head = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim()
  const evidenceRoot = evidenceRootPath(
    { canonicalPath: root.replaceAll("\\", "/").toLowerCase(), displayPath: root },
    created.runId,
    1,
  )
  const artifactPath = join(evidenceRoot, "result.txt")
  const cleanupPath = join(evidenceRoot, "cleanup.json")
  const receiptPath = join(evidenceRoot, "receipt.json")
  await mkdir(evidenceRoot, { recursive: true })
  await writeFile(artifactPath, "accepted evidence\n")
  await writeFile(
    cleanupPath,
    JSON.stringify({
      schemaVersion: 1,
      kind: "omp_lazy_cleanup",
      runId: created.runId,
      attempt: 1,
      actualAgentId: "criterion-agent",
      resourceId: "criterion-process",
      status: "cleaned",
      captureCommit: head,
    }),
  )
  await writeFile(
    receiptPath,
    JSON.stringify({
      schemaVersion: 1,
      kind: "omp_lazy_worker_evidence",
      runId: created.runId,
      attempt: 1,
      runRevision: created.revision,
      ownerEpoch: 1,
      taskGeneration: 2,
      workerRole: "omp-lazy-worker-low",
      actualAgentId: "criterion-agent",
      actualJobId: "criterion-agent",
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
          path: relative(root, artifactPath),
          capture: { runId: created.runId, attempt: 1, commit: head },
        },
      ],
      cleanup: [{ resourceId: "criterion-process", receiptPath: relative(root, cleanupPath) }],
    }),
  )
  const acceptance = runtime.extension.tools.get("omp_lazy_accept_worker_result")?.definition
  if (acceptance === undefined) throw new Error("public acceptance tool missing")

  // When: the current parent accepts the bound receipt and invokes trusted checkpoint.
  const accepted = await acceptance.execute(
    "accept-call",
    { agentId: "criterion-agent", receiptPath: relative(root, receiptPath) },
    undefined,
    undefined,
    context as Parameters<typeof acceptance.execute>[4],
  )
  await runtime.invoke(
    "ulw-loop(omp)",
    `checkpoint ${created.runId} criterion-1 ${relative(root, receiptPath).replaceAll("\\", "/")}`,
  )

  // Then: exactly the public parent tool accepted and checkpoint derived terminal completion.
  expect(accepted.details).toMatchObject({ kind: "accepted" })
  expect(runtime.results[1]).toMatchObject({
    operation: "checkpoint",
    status: "PASS",
    runStatus: "completed",
  })
  expect(runtime.prompts).toEqual([])
})
