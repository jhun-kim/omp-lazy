import { afterEach, expect, test } from "bun:test"
import type { StateEventV2 } from "../../src/state/domain"
import { UuidSchema } from "../../src/state/domain"
import { deadlineAfter } from "../../src/state/repo-lock"
import { TransactionStore } from "../../src/state/transaction-store"
import {
  acceptTask,
  bindTask,
  completionRoot,
  stop,
} from "../fixtures/workflow-completion-fixtures"
import {
  cleanupWorkflowRoots,
  publicWorkflowRuntime,
  workflowRepository,
} from "../fixtures/workflow-lifecycle-fixtures"

afterEach(async () => {
  await cleanupWorkflowRoots()
})

async function currentParentReviewedCriterion(label: string) {
  const root = await workflowRepository(label)
  const runtime = await publicWorkflowRuntime(root)
  await runtime.invoke("ulw-loop(omp)", "create complete parent-reviewed evidence")
  const created = runtime.results[0]
  if (created?.runId === null || created?.runId === undefined || created.revision === null) {
    throw new Error("ULW create result missing scope")
  }
  await bindTask(runtime, root, {
    toolCallId: "criterion-dispatch",
    taskId: "criterion-1",
    agentId: "criterion-agent",
  })
  for (const [index, expectedKind] of (
    ["rejected", "rejected", "needs_parent_decision"] as const
  ).entries()) {
    await acceptTask(runtime, root, {
      runId: created.runId,
      runRevision: created.revision,
      taskGeneration: 2,
      agentId: "criterion-agent",
      suffix: `rejected-${index}`,
      exitCode: 1,
      expectedKind,
    })
  }
  await acceptTask(runtime, root, {
    runId: created.runId,
    runRevision: created.revision,
    taskGeneration: 2,
    agentId: "criterion-agent",
    suffix: "parent-reviewed",
    parentDecision: "accept_after_review",
  })
  return { root, runtime, runId: created.runId }
}

test("Given three current ULW rejections and parent-reviewed evidence When the session stops Then the criterion and run complete without failure", async () => {
  // Given
  const { root, runtime, runId } = await currentParentReviewedCriterion(
    "continuation-parent-reviewed",
  )

  // When
  await stop(runtime, root, "leaf-parent-reviewed")
  await runtime.invoke("ulw-loop(omp)", `status ${runId}`)

  // Then
  const store = new TransactionStore(completionRoot(root))
  const run = await store.readRun(runId)
  const failedEvents = (await store.events.readAll()).filter(
    (event) =>
      event.runId === runId &&
      event.mutation.kind === "workflow_terminal" &&
      event.mutation.status === "failed",
  )
  expect(runtime.results[1]).toMatchObject({ operation: "status", runStatus: "completed" })
  expect(run?.payload.status).toBe("completed")
  expect(run?.workflow === "ulw_loop" ? run.payload.goals[0]?.status : undefined).toBe("complete")
  expect(run?.workflow === "ulw_loop" ? run.payload.goals[0]?.criteria[0]?.status : undefined).toBe(
    "pass",
  )
  expect(failedEvents).toEqual([])
}, 30_000)

test("Given accepted current evidence after rejection exhaustion When a failure event is forged Then state authority rejects it", async () => {
  // Given
  const { root, runId } = await currentParentReviewedCriterion("continuation-forged-failure")
  const store = new TransactionStore(completionRoot(root))
  const index = await store.readIndex()
  const run = await store.readRun(runId)
  if (run === null || run.schemaVersion !== 2) throw new Error("current ULW run missing")
  const event: StateEventV2 = {
    schemaVersion: 2,
    eventId: UuidSchema.parse("77777777-7777-4777-8777-777777777777"),
    sequence: index.revision + 1,
    runId: run.runId,
    workflow: run.workflow,
    kind: "workflow_terminal",
    expected: {
      indexRevision: index.revision,
      runRevision: run.revision,
      ownerSessionId: run.owner.sessionId,
      ownerEpoch: run.owner.epoch,
      expectedHead: run.expectedHead,
      taskGeneration: 2,
    },
    mutation: { kind: "workflow_terminal", status: "failed", taskId: "criterion-1" },
    legacyHeadUnbound: false,
    at: "2026-07-23T00:00:00.000Z",
  }

  // When
  const committed = await store.commit(event, { deadline: deadlineAfter(2_000) })

  // Then
  expect(committed).toEqual({ ok: false, code: "invalid_mutation" })
  expect((await store.readRun(runId))?.payload.status).toBe("active")
}, 30_000)
