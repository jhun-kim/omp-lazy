import { afterEach, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createDeadlineFence } from "../../src/continuation/deadline-fence"
import { DurableContinuationCoordinator } from "../../src/continuation/durable-continuation"
import { type StateEventV2, UuidSchema } from "../../src/state/domain"
import { inspectRecovery, repairState } from "../../src/state/recovery"
import { deadlineAfter } from "../../src/state/repo-lock"
import { TransactionStore } from "../../src/state/transaction-store"
import {
  acceptTask,
  bindTask,
  checkPlan,
  completionRoot,
  startApprovedWork,
  stop,
} from "../fixtures/workflow-completion-fixtures"
import { cleanupWorkflowRoots } from "../fixtures/workflow-lifecycle-fixtures"

afterEach(async () => {
  await cleanupWorkflowRoots()
})

test("Given checked plan bytes without receipts When reconciled Then Markdown cannot forge completion", async () => {
  const { root, runtime, runId } = await startApprovedWork("completion-forged")
  await checkPlan(root)

  await runtime.invoke("start-work(omp)", `reconcile ${runId} .omo/plans/work.md`)
  await runtime.invoke("start-work(omp)", `status ${runId}`)

  expect(runtime.results[2]).toMatchObject({ operation: "reconcile", runStatus: "active" })
  expect(runtime.results[3]).toMatchObject({ operation: "status", runStatus: "active" })
  expect((await new TransactionStore(completionRoot(root)).readRun(runId))?.progressRevision).toBe(
    1,
  )
}, 30_000)

test("Given a forged terminal receipt event When committed Then state authority rejects it", async () => {
  const { root, runId } = await startApprovedWork("completion-forged-event")
  const store = new TransactionStore(completionRoot(root))
  const index = await store.readIndex()
  const run = await store.readRun(runId)
  if (run === null || run.schemaVersion !== 2) throw new Error("current run missing")
  const event: StateEventV2 = {
    schemaVersion: 2,
    eventId: UuidSchema.parse("88888888-8888-4888-8888-888888888888"),
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
      taskGeneration: 1,
    },
    mutation: { kind: "workflow_terminal", status: "completed", acceptanceIds: ["forged"] },
    legacyHeadUnbound: false,
    at: "2026-07-23T00:00:00.000Z",
  }

  const committed = await store.commit(event, { deadline: deadlineAfter(2_000) })

  expect(committed).toEqual({ ok: false, code: "invalid_mutation" })
  expect((await store.readRun(runId))?.payload.status).toBe("active")
}, 30_000)

test("Given a stale and then current task generation When completion is reconciled Then only current accepted evidence completes", async () => {
  const { root, runtime, runId, revision } = await startApprovedWork("completion-current")
  await bindTask(runtime, root, {
    toolCallId: "dispatch-old",
    taskId: "T1",
    agentId: "worker-old",
  })
  await acceptTask(runtime, root, {
    runId,
    runRevision: revision,
    taskGeneration: 2,
    agentId: "worker-old",
    suffix: "old",
  })
  await bindTask(runtime, root, {
    toolCallId: "dispatch-current",
    taskId: "T1",
    agentId: "worker-current",
  })
  await checkPlan(root)

  await stop(runtime, root, "leaf-stale")
  await runtime.invoke("start-work(omp)", `status ${runId}`)
  await acceptTask(runtime, root, {
    runId,
    runRevision: revision,
    taskGeneration: 4,
    agentId: "worker-current",
    suffix: "current",
  })
  const currentStore = new TransactionStore(completionRoot(root))
  const currentRun = await currentStore.readRun(runId)
  if (currentRun === null) throw new Error("current run missing")
  const authority = await currentStore.readReceiptAuthority(currentRun)
  expect(authority.taskGeneration).toBe(4)
  expect(authority.accepted.at(-1)).toMatchObject({ taskId: "T1", taskGeneration: 4 })
  await stop(runtime, root, "leaf-current")
  await runtime.invoke("start-work(omp)", `status ${runId}`)

  expect(runtime.results[2]).toMatchObject({ operation: "status", runStatus: "active" })
  expect(runtime.results[3]).toMatchObject({ operation: "status", runStatus: "completed" })
  expect((await new TransactionStore(completionRoot(root)).readRun(runId))?.progressRevision).toBe(
    2,
  )
}, 30_000)

test("Given current complete receipts When the terminal leaf replays Then one durable completion event remains", async () => {
  const { root, runtime, runId, revision } = await startApprovedWork("completion-replay")
  await bindTask(runtime, root, {
    toolCallId: "dispatch-complete",
    taskId: "T1",
    agentId: "worker-complete",
  })
  await acceptTask(runtime, root, {
    runId,
    runRevision: revision,
    taskGeneration: 2,
    agentId: "worker-complete",
    suffix: "complete",
  })
  await checkPlan(root)

  await stop(runtime, root, "leaf-complete")
  await stop(runtime, root, "leaf-complete")

  const store = new TransactionStore(completionRoot(root))
  const terminal = (await store.events.readAll()).filter(
    (event) => event.runId === runId && event.kind === "workflow_terminal",
  )
  expect(terminal).toHaveLength(1)
  expect((await store.readRun(runId))?.payload.status).toBe("completed")
}, 30_000)

test("Given exhausted current task receipts When the session stops Then failure becomes terminal", async () => {
  const { root, runtime, runId, revision } = await startApprovedWork("completion-failed")
  await bindTask(runtime, root, {
    toolCallId: "dispatch-failed",
    taskId: "T1",
    agentId: "worker-failed",
  })
  for (const expectedKind of ["rejected", "rejected", "needs_parent_decision"] as const) {
    await acceptTask(runtime, root, {
      runId,
      runRevision: revision,
      taskGeneration: 2,
      agentId: "worker-failed",
      suffix: "failed",
      exitCode: 1,
      expectedKind,
    })
  }

  await stop(runtime, root, "leaf-failed")
  await runtime.invoke("start-work(omp)", `status ${runId}`)

  expect(runtime.results[2]).toMatchObject({ operation: "status", runStatus: "failed" })
  expect((await new TransactionStore(completionRoot(root)).readRun(runId))?.progressRevision).toBe(
    1,
  )
}, 30_000)

test("Given a crash after the terminal event When repaired and replayed Then completion remains singular", async () => {
  const { root, runtime, runId, revision } = await startApprovedWork("completion-crash")
  await bindTask(runtime, root, {
    toolCallId: "dispatch-crash",
    taskId: "T1",
    agentId: "worker-crash",
  })
  await acceptTask(runtime, root, {
    runId,
    runRevision: revision,
    taskGeneration: 2,
    agentId: "worker-crash",
    suffix: "crash",
  })
  await checkPlan(root)
  const stateRoot = completionRoot(root)
  const store = new TransactionStore(stateRoot)
  let crashed = false
  const coordinator = new DurableContinuationCoordinator({
    resolveRoot: async () => stateRoot,
    openStore: () => ({
      readIndex: () => store.readIndex(),
      readRun: (targetRunId) => store.readRun(targetRunId),
      readReceiptAuthority: (run) => store.readReceiptAuthority(run),
      commit: (event, options) =>
        store.commit(event, {
          deadline: options.deadline,
          crash: (point) => {
            if (!crashed && point === "after_event") {
              crashed = true
              throw new Error("injected terminal crash")
            }
          },
        }),
    }),
    readPlan: async (path) => readFile(path, "utf8"),
    eventId: () => UuidSchema.parse("99999999-9999-4999-8999-999999999999"),
    nowIso: () => "2026-07-23T00:00:00.000Z",
  })

  await expect(
    coordinator.handle({
      cwd: root,
      diagnosticTurnId: 0,
      fence: createDeadlineFence(2_000),
      leafId: "leaf-crash",
      sessionId: "parent-session",
    }),
  ).rejects.toThrow("injected terminal crash")
  expect(await inspectRecovery(stateRoot)).toMatchObject({ kind: "repairable" })
  expect(await repairState(stateRoot, deadlineAfter(2_000))).toMatchObject({ ok: true })

  const replay = await coordinator.handle({
    cwd: root,
    diagnosticTurnId: 0,
    fence: createDeadlineFence(2_000),
    leafId: "leaf-crash",
    sessionId: "parent-session",
  })
  const terminal = (await store.events.readAll()).filter(
    (event) => event.runId === runId && event.kind === "workflow_terminal",
  )
  expect(replay).toEqual({ kind: "quiet" })
  expect(terminal).toHaveLength(1)
  expect((await store.readRun(runId))?.payload.status).toBe("completed")
  expect(await Bun.file(join(store.paths.root, "transaction.lock")).exists()).toBeFalse()
}, 30_000)
