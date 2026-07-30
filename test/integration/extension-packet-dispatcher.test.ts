import { afterEach, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
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

test("Given an active FAST packet When the public tool_call handler dispatches Then only its allowlisted worker passes independently of host disabled agents", async () => {
  // Given: the production extension owns a run whose current packet is FAST.
  const displayPath = await workflowRepository("packet-dispatch")
  const runtime = await publicWorkflowRuntime(displayPath)
  await runtime.invoke("ulw-loop(omp)", "create packet dispatch regression")
  const root = { canonicalPath: canonicalComparisonPath(displayPath), displayPath }
  const store = new TransactionStore(root)
  const index = await store.readIndex()
  const entry = index.entries[0]
  if (entry === undefined) throw new Error("active run missing")
  const run = await store.readRun(entry.runId)
  if (run === null || run.schemaVersion !== 2) throw new Error("v2 run missing")
  const packetHash = "a".repeat(64)
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
      reservationId: "packet-fast",
    }),
  )
  const handlers = runtime.extension.handlers.get("tool_call")
  const handler = handlers?.[handlers.length - 1]
  if (handler === undefined) throw new Error("public tool_call handler missing")
  const hostTaskSettings = {
    get(key: string): readonly string[] {
      return key === "task.disabledAgents" ? ["omp-lazy-worker-low"] : []
    },
  }
  const context = {
    cwd: displayPath,
    sessionManager: { getSessionId: () => "parent-session" },
    settings: hostTaskSettings,
  }

  // When: a host-enabled high worker and host-disabled low worker reach the registered handler.
  const high = await handler(
    {
      toolName: "task",
      toolCallId: "packet-high",
      input: { agent: "omp-lazy-worker-high", task: "forbidden escalation" },
    },
    context,
  )
  const low = await handler(
    {
      toolName: "task",
      toolCallId: "packet-low",
      input: { agent: "omp-lazy-worker-low", task: "allowed FAST work" },
    },
    context,
  )
  await writeFile(
    runSnapshotPath(root, run.runId),
    JSON.stringify({ ...run, packetHash: "b".repeat(64) }),
  )
  const stale = await handler(
    {
      toolName: "task",
      toolCallId: "packet-stale",
      input: { agent: "omp-lazy-worker-high", task: "new packet work" },
    },
    context,
  )

  // Then: packet authorization, not task.disabledAgents, decides the pre-host outcome.
  expect(high).toEqual({
    block: true,
    reason:
      "omp-lazy: agent not allowed by packet (FAST tier; eligible: omp-lazy-explorer, omp-lazy-librarian, omp-lazy-planner, omp-lazy-researcher, omp-lazy-worker-low)",
  })
  expect(low).toBeUndefined()
  expect(stale).toBeUndefined()
})
