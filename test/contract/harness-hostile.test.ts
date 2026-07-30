import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { evidenceRootPath } from "../../src/contracts/artifact-containment"
import { canonicalComparisonPath, runSnapshotPath } from "../../src/state/paths"
import { TransactionStore } from "../../src/state/transaction-store"
import {
  cleanupWorkflowRoots,
  publicWorkflowRuntime,
  workflowRepository,
} from "../fixtures/workflow-lifecycle-fixtures"

afterEach(async () => {
  await cleanupWorkflowRoots()
})

describe("harness hostile fail-closed behavior through installed surfaces", () => {
  test("Given an active FAST packet When an unauthorized agent type reaches the registered tool_call handler Then it is blocked", async () => {
    // Given: the production extension owns a run whose current packet is FAST.
    const displayPath = await workflowRepository("hostile-unauthorized")
    const runtime = await publicWorkflowRuntime(displayPath)
    await runtime.invoke("ulw-loop(omp)", "create hostile unauthorized agent")
    const root = { canonicalPath: canonicalComparisonPath(displayPath), displayPath }
    const store = new TransactionStore(root)
    const index = await store.readIndex()
    const entry = index.entries[0]
    if (entry === undefined) throw new Error("active run missing")
    const run = await store.readRun(entry.runId)
    if (run === null || run.schemaVersion !== 2) throw new Error("v2 run missing")
    const packetHash = "d".repeat(64)
    await writeFile(runSnapshotPath(root, run.runId), JSON.stringify({ ...run, packetHash }))
    await mkdir(join(store.paths.root, "task-facts"), { recursive: true })
    await writeFile(
      join(store.paths.root, "task-facts", `${run.runId}.json`),
      JSON.stringify({
        schemaVersion: 2,
        runId: run.runId,
        ledgerRevision: 0,
        entries: [],
        packetHash,
        tier: "FAST",
        reservationId: "hostile-unauthorized",
      }),
    )
    const handlers = runtime.extension.handlers.get("tool_call")
    const handler = handlers?.[handlers.length - 1]
    if (handler === undefined) throw new Error("public tool_call handler missing")
    const context = {
      cwd: displayPath,
      sessionManager: { getSessionId: () => "parent-session" },
      settings: { get: () => [] as readonly string[] },
    }

    // When: an agent type that does not exist in the public schema reaches the handler.
    const unauthorized = await handler(
      {
        toolName: "task",
        toolCallId: "hostile-unauthorized-agent",
        input: { agent: "omp-lazy-worker-ultra", task: "unauthorized escalation" },
      },
      context,
    )

    // Then: the unknown agent type is blocked by the production surface.
    expect(unauthorized).toEqual({
      block: true,
      reason:
        "omp-lazy: agent not allowed by packet (FAST tier; eligible: omp-lazy-explorer, omp-lazy-librarian, omp-lazy-planner, omp-lazy-researcher, omp-lazy-worker-low)",
    })
  })

  test("Given an active FAST packet When a tier-ineligible high worker reaches the registered tool_call handler Then it is blocked", async () => {
    // Given: the production extension owns a run whose current packet is FAST.
    const displayPath = await workflowRepository("hostile-tier")
    const runtime = await publicWorkflowRuntime(displayPath)
    await runtime.invoke("ulw-loop(omp)", "create hostile tier mismatch")
    const root = { canonicalPath: canonicalComparisonPath(displayPath), displayPath }
    const store = new TransactionStore(root)
    const index = await store.readIndex()
    const entry = index.entries[0]
    if (entry === undefined) throw new Error("active run missing")
    const run = await store.readRun(entry.runId)
    if (run === null || run.schemaVersion !== 2) throw new Error("v2 run missing")
    const packetHash = "e".repeat(64)
    await writeFile(runSnapshotPath(root, run.runId), JSON.stringify({ ...run, packetHash }))
    await mkdir(join(store.paths.root, "task-facts"), { recursive: true })
    await writeFile(
      join(store.paths.root, "task-facts", `${run.runId}.json`),
      JSON.stringify({
        schemaVersion: 2,
        runId: run.runId,
        ledgerRevision: 0,
        entries: [],
        packetHash,
        tier: "FAST",
        reservationId: "hostile-tier",
      }),
    )
    const handlers = runtime.extension.handlers.get("tool_call")
    const handler = handlers?.[handlers.length - 1]
    if (handler === undefined) throw new Error("public tool_call handler missing")
    const context = {
      cwd: displayPath,
      sessionManager: { getSessionId: () => "parent-session" },
      settings: { get: () => [] as readonly string[] },
    }

    // When: a FAST-ineligible high worker and medium worker reach the handler.
    const high = await handler(
      {
        toolName: "task",
        toolCallId: "hostile-high",
        input: { agent: "omp-lazy-worker-high", task: "tier-ineligible high work" },
      },
      context,
    )
    const medium = await handler(
      {
        toolName: "task",
        toolCallId: "hostile-medium",
        input: { agent: "omp-lazy-worker-medium", task: "tier-ineligible medium work" },
      },
      context,
    )

    // Then: both tier-ineligible agents are blocked by the production surface.
    expect(high).toEqual({
      block: true,
      reason:
        "omp-lazy: agent not allowed by packet (FAST tier; eligible: omp-lazy-explorer, omp-lazy-librarian, omp-lazy-planner, omp-lazy-researcher, omp-lazy-worker-low)",
    })
    expect(medium).toEqual({
      block: true,
      reason:
        "omp-lazy: agent not allowed by packet (FAST tier; eligible: omp-lazy-explorer, omp-lazy-librarian, omp-lazy-planner, omp-lazy-researcher, omp-lazy-worker-low)",
    })
  })

  test("Given an active run When a forged green receipt reaches the registered acceptance tool Then it is rejected", async () => {
    // Given: the production extension owns an active ULW run with a bound task identity.
    const displayPath = await workflowRepository("hostile-forged")
    const runtime = await publicWorkflowRuntime(displayPath)
    await runtime.invoke("ulw-loop(omp)", "create hostile forged receipt")
    const created = runtime.results[0]
    if (created?.runId === null || created?.runId === undefined || created.revision === null) {
      throw new Error("ULW create result missing scope")
    }
    const root = { canonicalPath: canonicalComparisonPath(displayPath), displayPath }
    const store = new TransactionStore(root)
    const run = await store.readRun(created.runId)
    if (run === null || run.schemaVersion !== 2) throw new Error("v2 run missing")

    // Bind a task identity through the production tool_call and tool_result handlers.
    const toolCallHandlers = runtime.extension.handlers.get("tool_call") ?? []
    const toolResultHandlers = runtime.extension.handlers.get("tool_result") ?? []
    const handlerContext = {
      cwd: displayPath,
      sessionManager: { getSessionId: () => "parent-session" },
    }
    for (const handler of toolCallHandlers) {
      await handler(
        {
          toolName: "task",
          toolCallId: "hostile-dispatch",
          input: { name: "T1", agent: "omp-lazy-worker-low", task: "complete T1" },
        },
        handlerContext,
      )
    }
    for (const handler of toolResultHandlers) {
      await handler(
        {
          toolName: "task",
          toolCallId: "hostile-dispatch",
          input: {},
          details: {
            projectAgentsDir: null,
            results: [],
            totalDurationMs: 1,
            progress: [
              { index: 0, id: "hostile-agent", agent: "omp-lazy-worker-low", status: "running" },
            ],
            async: { state: "running", jobId: "hostile-agent", type: "task" },
          },
          isError: false,
        },
        handlerContext,
      )
    }

    // Provision a forged receipt with a wrong ownerEpoch (999 instead of the real epoch).
    const head = Bun.spawnSync(["git", "-C", displayPath, "rev-parse", "HEAD"])
      .stdout.toString()
      .trim()
    const evidenceRoot = evidenceRootPath(root, created.runId, 1)
    await mkdir(evidenceRoot, { recursive: true })
    const artifactPath = join(evidenceRoot, "result-forged.txt")
    const cleanupPath = join(evidenceRoot, "cleanup-forged.json")
    const receiptPath = join(evidenceRoot, "receipt-forged.json")
    await writeFile(artifactPath, "forged green result\n")
    await writeFile(
      cleanupPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "omp_lazy_cleanup",
        runId: created.runId,
        attempt: 1,
        actualAgentId: "hostile-agent",
        resourceId: "process-forged",
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
        ownerEpoch: 999,
        taskGeneration: 2,
        workerRole: "omp-lazy-worker-low",
        actualAgentId: "hostile-agent",
        actualJobId: "hostile-agent",
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
            path: relative(displayPath, artifactPath),
            capture: { runId: created.runId, attempt: 1, commit: head },
          },
        ],
        cleanup: [
          { resourceId: "process-forged", receiptPath: relative(displayPath, cleanupPath) },
        ],
      }),
    )

    // When: the forged receipt reaches the registered acceptance tool.
    const acceptance = runtime.extension.tools.get("omp_lazy_accept_worker_result")?.definition
    if (acceptance === undefined) throw new Error("public acceptance tool missing")
    const result = await acceptance.execute(
      "accept-forged",
      { agentId: "hostile-agent", receiptPath: relative(displayPath, receiptPath) },
      undefined,
      undefined,
      {
        cwd: displayPath,
        sessionManager: { getSessionId: () => "parent-session" },
      } as Parameters<typeof acceptance.execute>[4],
    )

    // Then: the forged receipt is rejected by the production surface.
    expect(result.details).toMatchObject({ kind: "rejected" })
  }, 30_000)

  test("Given an active run When a receipt with a wrong runId reaches the registered acceptance tool Then it is rejected", async () => {
    // Given: the production extension owns an active ULW run with a bound task identity.
    const displayPath = await workflowRepository("hostile-wrong-run")
    const runtime = await publicWorkflowRuntime(displayPath)
    await runtime.invoke("ulw-loop(omp)", "create hostile wrong run receipt")
    const created = runtime.results[0]
    if (created?.runId === null || created?.runId === undefined || created.revision === null) {
      throw new Error("ULW create result missing scope")
    }
    const root = { canonicalPath: canonicalComparisonPath(displayPath), displayPath }
    const store = new TransactionStore(root)
    const run = await store.readRun(created.runId)
    if (run === null || run.schemaVersion !== 2) throw new Error("v2 run missing")

    // Bind a task identity through the production tool_call and tool_result handlers.
    const toolCallHandlers = runtime.extension.handlers.get("tool_call") ?? []
    const toolResultHandlers = runtime.extension.handlers.get("tool_result") ?? []
    const handlerContext = {
      cwd: displayPath,
      sessionManager: { getSessionId: () => "parent-session" },
    }
    for (const handler of toolCallHandlers) {
      await handler(
        {
          toolName: "task",
          toolCallId: "hostile-wrong-run-dispatch",
          input: { name: "T1", agent: "omp-lazy-worker-low", task: "complete T1" },
        },
        handlerContext,
      )
    }
    for (const handler of toolResultHandlers) {
      await handler(
        {
          toolName: "task",
          toolCallId: "hostile-wrong-run-dispatch",
          input: {},
          details: {
            projectAgentsDir: null,
            results: [],
            totalDurationMs: 1,
            progress: [
              { index: 0, id: "wrong-run-agent", agent: "omp-lazy-worker-low", status: "running" },
            ],
            async: { state: "running", jobId: "wrong-run-agent", type: "task" },
          },
          isError: false,
        },
        handlerContext,
      )
    }

    // Provision a receipt with a completely wrong runId.
    const head = Bun.spawnSync(["git", "-C", displayPath, "rev-parse", "HEAD"])
      .stdout.toString()
      .trim()
    const evidenceRoot = evidenceRootPath(root, created.runId, 1)
    await mkdir(evidenceRoot, { recursive: true })
    const artifactPath = join(evidenceRoot, "result-wrong-run.txt")
    const cleanupPath = join(evidenceRoot, "cleanup-wrong-run.json")
    const receiptPath = join(evidenceRoot, "receipt-wrong-run.json")
    await writeFile(artifactPath, "wrong run result\n")
    await writeFile(
      cleanupPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "omp_lazy_cleanup",
        runId: "00000000-0000-4000-8000-000000000000",
        attempt: 1,
        actualAgentId: "wrong-run-agent",
        resourceId: "process-wrong-run",
        status: "cleaned",
        captureCommit: head,
      }),
    )
    await writeFile(
      receiptPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "omp_lazy_worker_evidence",
        runId: "00000000-0000-4000-8000-000000000000",
        attempt: 1,
        runRevision: created.revision,
        ownerEpoch: run.owner.epoch,
        taskGeneration: 2,
        workerRole: "omp-lazy-worker-low",
        actualAgentId: "wrong-run-agent",
        actualJobId: "wrong-run-agent",
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
            path: relative(displayPath, artifactPath),
            capture: { runId: "00000000-0000-4000-8000-000000000000", attempt: 1, commit: head },
          },
        ],
        cleanup: [
          { resourceId: "process-wrong-run", receiptPath: relative(displayPath, cleanupPath) },
        ],
      }),
    )

    // When: the wrong-run receipt reaches the registered acceptance tool.
    const acceptance = runtime.extension.tools.get("omp_lazy_accept_worker_result")?.definition
    if (acceptance === undefined) throw new Error("public acceptance tool missing")
    const result = await acceptance.execute(
      "accept-wrong-run",
      { agentId: "wrong-run-agent", receiptPath: relative(displayPath, receiptPath) },
      undefined,
      undefined,
      {
        cwd: displayPath,
        sessionManager: { getSessionId: () => "parent-session" },
      } as Parameters<typeof acceptance.execute>[4],
    )

    // Then: the wrong-run receipt is rejected by the production surface.
    expect(result.details).toMatchObject({ kind: "rejected" })
  }, 30_000)
})
