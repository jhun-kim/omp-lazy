import { afterEach, describe, expect, test } from "bun:test"
import { TaskEventLedger } from "../../src/gates/task-event-ledger"
import { TaskSpawnGuard } from "../../src/gates/task-spawn-guard"
import { decodeIrcResult } from "../../src/observers/irc-result-codec"
import { decodeJobResult } from "../../src/observers/job-result-codec"
import { decodeTaskResult } from "../../src/observers/task-result-codec"
import { ToolResultObserver } from "../../src/observers/tool-result-observer"
import { newRunId, type StateEvent } from "../../src/state/domain"
import { deadlineAfter } from "../../src/state/repo-lock"
import { removeTestTree } from "../fixtures/remove-test-tree"
import { initializedStore, pauseEvent, temporaryRoot } from "../fixtures/store-fixtures"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTestTree))
})

function taskDetails(ids: readonly string[], primaryJobId: string | null) {
  return {
    projectAgentsDir: null,
    results: [],
    totalDurationMs: 1,
    progress: ids.map((id, index) => ({
      index,
      id,
      agent: "reviewer",
      status: "running",
    })),
    ...(primaryJobId === null
      ? {}
      : { async: { state: "running", jobId: primaryJobId, type: "task" } }),
  }
}

function jobDetails(ids: readonly string[]) {
  return {
    jobs: ids.map((id) => ({
      id,
      type: "task",
      status: "running",
      label: id,
      durationMs: 1,
    })),
  }
}

async function runtime(label: string) {
  const root = await temporaryRoot(label)
  roots.push(root.displayPath)
  const { store, run } = await initializedStore(root)
  const ledger = new TaskEventLedger(store)
  return {
    store,
    run,
    ledger,
    guard: new TaskSpawnGuard(ledger, 8),
    observer: new ToolResultObserver(ledger),
  }
}

describe("OMP 17.0.5 result codecs", () => {
  test("Given pinned task and job details When decoded Then actual IDs remain typed", () => {
    // Given / When
    const task = decodeTaskResult(taskDetails(["worker-2"], "worker-2"))
    const job = decodeJobResult(jobDetails(["worker-2"]))

    // Then
    expect(String(task.ok && task.value.progress?.[0]?.id)).toBe("worker-2")
    expect(String(job.ok && job.value.jobs[0]?.id)).toBe("worker-2")
  })

  test.each([
    ["task", () => decodeTaskResult({ progress: [{ id: "worker" }] })],
    ["job", () => decodeJobResult({ jobs: [{ id: "worker", status: "success" }] })],
  ])("Given malformed %s details When decoded Then misleading shapes fail closed", (_name, decode) => {
    // Given / When / Then
    expect(decode().ok).toBeFalse()
  })

  test("Given additive OMP 17 fields When decoded Then consumed identity fields remain valid", () => {
    const task = decodeTaskResult({
      ...taskDetails(["worker"], "worker"),
      async: { state: "running", jobId: "worker", type: "task", future: true },
    })
    const job = decodeJobResult({
      op: "cancel",
      jobs: [],
      cancelled: [{ id: "worker", status: "cancelled", future: true }],
      agents: [{ id: "worker", ageMs: 1, future: true }],
    })
    const irc = decodeIrcResult({
      op: "send",
      receipts: [{ to: "worker", outcome: "injected", future: true }],
    })

    expect(task.ok).toBeTrue()
    expect(job.ok).toBeTrue()
    expect(irc.ok).toBeTrue()
  })
})

test("Given duplicate requested names When task returns suffixed IDs Then returned IDs persist", async () => {
  // Given
  const { ledger, guard, observer } = await runtime("task-identities-duplicate")
  await guard.handle({
    toolName: "task",
    toolCallId: "tool-duplicate",
    input: {
      context: "shared",
      tasks: [
        { name: "worker", agent: "reviewer", task: "one" },
        { name: "worker", agent: "reviewer", task: "two" },
      ],
    },
    sessionId: "session-a",
  })

  // When
  const observed = await observer.observe({
    toolName: "task",
    toolCallId: "tool-duplicate",
    input: {},
    details: taskDetails(["worker", "worker-2"], "worker"),
    isError: false,
    sessionId: "session-a",
  })

  // Then
  expect(observed).toEqual({ kind: "recorded", capability: "pending" })
  expect(await ledger.identities("session-a")).toMatchObject([
    { requestedName: "worker", actualAgentId: "worker", actualJobId: "worker" },
    { requestedName: "worker", actualAgentId: "worker-2", actualJobId: null },
  ])
})

test("Given returned agent IDs When a job snapshot arrives Then every returned job ID is bound", async () => {
  // Given
  const { ledger, guard, observer } = await runtime("task-identities-jobs")
  await guard.handle({
    toolName: "task",
    toolCallId: "tool-jobs",
    input: { context: "shared", tasks: [{ task: "one" }, { task: "two" }] },
    sessionId: "session-a",
  })
  await observer.observe({
    toolName: "task",
    toolCallId: "tool-jobs",
    input: {},
    details: taskDetails(["parent.worker", "parent.worker-2"], "parent.worker"),
    isError: false,
    sessionId: "session-a",
  })
  await guard.handle({
    toolName: "job",
    toolCallId: "tool-job-list",
    input: { list: true },
    sessionId: "session-a",
  })

  // When
  const observed = await observer.observe({
    toolName: "job",
    toolCallId: "tool-job-list",
    input: { list: true },
    details: jobDetails(["parent.worker", "parent.worker-2"]),
    isError: false,
    sessionId: "session-a",
  })

  // Then
  expect(observed).toEqual({ kind: "recorded", capability: "proven" })
  expect(
    (await ledger.identities("session-a")).map((identity) => String(identity.actualJobId)),
  ).toEqual(["parent.worker", "parent.worker-2"])
  expect(await ledger.capability("session-a")).toEqual({
    status: "proven",
    reason: "matching_job_snapshot",
  })
})

test("Given a nested returned ID When IRC targets the requested label Then it is blocked pre-call", async () => {
  // Given
  const { guard, observer } = await runtime("task-identities-irc-refuse")
  await guard.handle({
    toolName: "task",
    toolCallId: "tool-nested",
    input: { name: "child", task: "one" },
    sessionId: "session-a",
  })
  await observer.observe({
    toolName: "task",
    toolCallId: "tool-nested",
    input: {},
    details: taskDetails(["parent.child"], "parent.child"),
    isError: false,
    sessionId: "session-a",
  })

  // When
  const observed = await guard.handle({
    toolName: "irc",
    toolCallId: "tool-irc",
    input: { op: "send", to: "child", message: "hello" },
    sessionId: "session-a",
  })

  // Then
  expect(observed).toEqual({ block: true, reason: "omp-lazy: unowned agent" })
})

test("Given a nested returned ID When IRC returns its receipt Then the actual ID is recorded", async () => {
  // Given
  const { ledger, guard, observer } = await runtime("task-identities-irc-owned")
  await guard.handle({
    toolName: "task",
    toolCallId: "tool-nested",
    input: { name: "child", task: "one" },
    sessionId: "session-a",
  })
  await observer.observe({
    toolName: "task",
    toolCallId: "tool-nested",
    input: {},
    details: taskDetails(["parent.child"], "parent.child"),
    isError: false,
    sessionId: "session-a",
  })
  await guard.handle({
    toolName: "irc",
    toolCallId: "tool-irc",
    input: { op: "send", to: "parent.child", message: "hello" },
    sessionId: "session-a",
  })

  // When
  const observed = await observer.observe({
    toolName: "irc",
    toolCallId: "tool-irc",
    input: { op: "send", to: "parent.child", message: "hello" },
    details: {
      op: "send",
      receipts: [{ to: "parent.child", outcome: "injected" }],
    },
    isError: false,
    sessionId: "session-a",
  })

  // Then
  expect(observed).toEqual({ kind: "recorded", capability: "pending" })
  expect(
    (await ledger.receipts("session-a")).some(
      (fact) => fact.receipt.kind === "irc" && fact.receipt.agentId === "parent.child",
    ),
  ).toBeTrue()
})

test("Given an owned returned job When cancellation receipt succeeds Then success is recorded", async () => {
  // Given
  const { guard, observer } = await runtime("task-identities-cancel-owned")
  await guard.handle({
    toolName: "task",
    toolCallId: "tool-owned",
    input: { task: "one" },
    sessionId: "session-a",
  })
  await observer.observe({
    toolName: "task",
    toolCallId: "tool-owned",
    input: {},
    details: taskDetails(["actual-worker"], "actual-worker"),
    isError: false,
    sessionId: "session-a",
  })
  await guard.handle({
    toolName: "job",
    toolCallId: "tool-cancel",
    input: { cancel: ["actual-worker"] },
    sessionId: "session-a",
  })

  // When
  const observed = await observer.observe({
    toolName: "job",
    toolCallId: "tool-cancel",
    input: { cancel: ["actual-worker"] },
    details: { jobs: [], cancelled: [{ id: "actual-worker", status: "cancelled" }] },
    isError: false,
    sessionId: "session-a",
  })

  // Then
  expect(observed).toEqual({ kind: "recorded", capability: "pending" })
})

test("Given an unowned job When cancellation is requested Then it is blocked pre-call", async () => {
  // Given
  const { guard } = await runtime("task-identities-cancel-unowned")

  // When
  const observed = await guard.handle({
    toolName: "job",
    toolCallId: "tool-cancel",
    input: { cancel: ["foreign-worker"] },
    sessionId: "session-a",
  })

  // Then
  expect(observed).toEqual({ block: true, reason: "omp-lazy: unowned job" })
})

test("Given owned and foreign controls When guarded Then ownership is enforced before execution", async () => {
  // Given
  const { guard, observer } = await runtime("task-identities-pre-call")
  await guard.handle({
    toolName: "task",
    toolCallId: "tool-owned",
    input: { task: "one" },
    sessionId: "session-a",
  })
  await observer.observe({
    toolName: "task",
    toolCallId: "tool-owned",
    input: {},
    details: taskDetails(["parent.actual"], "parent.actual"),
    isError: false,
    sessionId: "session-a",
  })

  // When
  const ownedJob = await guard.handle({
    toolName: "job",
    toolCallId: "job-owned",
    input: { cancel: ["parent.actual"] },
    sessionId: "session-a",
  })
  const foreignJob = await guard.handle({
    toolName: "job",
    toolCallId: "job-foreign",
    input: { cancel: ["parent.foreign"] },
    sessionId: "session-a",
  })
  const ownedIrc = await guard.handle({
    toolName: "irc",
    toolCallId: "irc-owned",
    input: { op: "send", to: "parent.actual", message: "hello" },
    sessionId: "session-a",
  })
  const foreignIrc = await guard.handle({
    toolName: "irc",
    toolCallId: "irc-foreign",
    input: { op: "send", to: "parent.foreign", message: "hello" },
    sessionId: "session-a",
  })
  const malformed = await guard.handle({
    toolName: "job",
    toolCallId: "job-malformed",
    input: { cancel: "parent.actual" },
    sessionId: "session-a",
  })

  // Then
  expect([ownedJob, ownedIrc]).toEqual([undefined, undefined])
  expect(foreignJob).toEqual({ block: true, reason: "omp-lazy: unowned job" })
  expect(foreignIrc).toEqual({ block: true, reason: "omp-lazy: unowned agent" })
  expect(malformed).toEqual({ block: true, reason: "omp-lazy: malformed job control" })
})

test("Given an exact task result replay When observed Then immutable facts and revisions do not change", async () => {
  // Given
  const { store, ledger, guard, observer } = await runtime("task-identities-replay")
  await guard.handle({
    toolName: "task",
    toolCallId: "tool-replay",
    input: { task: "one" },
    sessionId: "session-a",
  })
  const observation = {
    toolName: "task",
    toolCallId: "tool-replay",
    input: {},
    details: taskDetails(["actual-worker"], "actual-worker"),
    isError: false,
    sessionId: "session-a",
  } as const
  await observer.observe(observation)
  const before = await store.readIndex()
  const beforeLedgerRevision = await ledger.ledgerRevision("session-a")

  // When
  const replayed = await observer.observe(observation)
  const after = await store.readIndex()
  const afterLedgerRevision = await ledger.ledgerRevision("session-a")
  const facts = (await ledger.facts("session-a")).filter(
    (fact) => fact.kind === "task_identities_bound",
  )

  // Then
  expect(replayed).toEqual({ kind: "recorded", capability: "pending" })
  expect(facts).toHaveLength(1)
  expect(afterLedgerRevision).toBe(beforeLedgerRevision)
  expect(after.revision).toBe(before.revision)
})

test("Given exact job and IRC result replays When observed Then receipts and revisions do not change", async () => {
  const { store, ledger, guard, observer } = await runtime("task-receipts-replay")
  await guard.handle({
    toolName: "task",
    toolCallId: "task-receipt-replay",
    input: { task: "one" },
    sessionId: "session-a",
  })
  await observer.observe({
    toolName: "task",
    toolCallId: "task-receipt-replay",
    input: {},
    details: taskDetails(["actual-worker"], "actual-worker"),
    isError: false,
    sessionId: "session-a",
  })
  const jobObservation = {
    toolName: "job",
    toolCallId: "job-receipt-replay",
    input: { list: true },
    details: jobDetails(["actual-worker"]),
    isError: false,
    sessionId: "session-a",
  } as const
  await guard.handle({
    toolName: jobObservation.toolName,
    toolCallId: jobObservation.toolCallId,
    input: jobObservation.input,
    sessionId: jobObservation.sessionId,
  })
  await observer.observe(jobObservation)
  const jobRevision = await ledger.ledgerRevision("session-a")
  const jobIndex = await store.readIndex()

  const replayedJob = await observer.observe(jobObservation)
  expect(replayedJob).toEqual({ kind: "recorded", capability: "proven" })
  expect(await ledger.ledgerRevision("session-a")).toBe(jobRevision)
  expect((await store.readIndex()).revision).toBe(jobIndex.revision)

  const ircInput = { op: "send", to: "actual-worker", message: "hello" } as const
  await guard.handle({
    toolName: "irc",
    toolCallId: "irc-receipt-replay",
    input: ircInput,
    sessionId: "session-a",
  })
  const ircObservation = {
    toolName: "irc",
    toolCallId: "irc-receipt-replay",
    input: ircInput,
    details: { op: "send", receipts: [{ to: "actual-worker", outcome: "injected" }] },
    isError: false,
    sessionId: "session-a",
  } as const
  await observer.observe(ircObservation)
  const ircRevision = await ledger.ledgerRevision("session-a")
  const replayedIrc = await observer.observe(ircObservation)
  const receipts = await ledger.receipts("session-a")

  expect(replayedIrc).toEqual({ kind: "recorded", capability: "pending" })
  expect(await ledger.ledgerRevision("session-a")).toBe(ircRevision)
  expect(receipts.filter((fact) => fact.receipt.kind === "job")).toHaveLength(1)
  expect(receipts.filter((fact) => fact.receipt.kind === "irc")).toHaveLength(1)
})

test("Given owner adoption When prior-epoch identities exist Then only a current-epoch bind owns them", async () => {
  // Given
  const { store, run, ledger, guard, observer } = await runtime("task-owner-epoch")
  await guard.handle({
    toolName: "task",
    toolCallId: "prior-owner-task",
    input: { task: "prior owner" },
    sessionId: "session-a",
  })
  await observer.observe({
    toolName: "task",
    toolCallId: "prior-owner-task",
    input: {},
    details: taskDetails(["shared-worker"], "shared-worker"),
    isError: false,
    sessionId: "session-a",
  })
  const paused = await store.commit(pauseEvent(run), { deadline: deadlineAfter(2_000) })
  if (!paused.ok) throw new Error(paused.code)
  const adoption: StateEvent = {
    schemaVersion: 1,
    eventId: newRunId(),
    sequence: paused.index.revision + 1,
    runId: paused.run.runId,
    workflow: paused.run.workflow,
    kind: "owner_adopted",
    expected: {
      indexRevision: paused.index.revision,
      runRevision: paused.run.revision,
      ownerSessionId: paused.run.owner.sessionId,
      ownerEpoch: paused.run.owner.epoch,
    },
    mutation: { kind: "owner_adopted", sessionId: "session-b" },
    at: "2026-07-13T00:04:00.000Z",
  }
  const adopted = await store.commit(adoption, { deadline: deadlineAfter(2_000) })
  if (!adopted.ok) throw new Error(adopted.code)

  // When
  const inherited = await guard.handle({
    toolName: "irc",
    toolCallId: "inherited-control",
    input: { op: "send", to: "shared-worker", message: "before rebind" },
    sessionId: "session-b",
  })
  const oldOwner = await guard.handle({
    toolName: "irc",
    toolCallId: "old-owner-control",
    input: { op: "send", to: "shared-worker", message: "foreign session" },
    sessionId: "session-a",
  })
  await guard.handle({
    toolName: "task",
    toolCallId: "current-owner-task",
    input: { task: "current owner" },
    sessionId: "session-b",
  })
  await observer.observe({
    toolName: "task",
    toolCallId: "current-owner-task",
    input: {},
    details: taskDetails(["shared-worker"], "shared-worker"),
    isError: false,
    sessionId: "session-b",
  })
  const rebound = await guard.handle({
    toolName: "irc",
    toolCallId: "rebound-control",
    input: { op: "send", to: "shared-worker", message: "after rebind" },
    sessionId: "session-b",
  })

  // Then
  expect(adopted.run.owner).toEqual({ sessionId: "session-b", epoch: 2 })
  expect(inherited).toEqual({ block: true, reason: "omp-lazy: unowned agent" })
  expect(oldOwner).toBeUndefined()
  expect(rebound).toBeUndefined()
  expect(await ledger.identities("session-b")).toMatchObject([
    { toolCallId: "current-owner-task", actualAgentId: "shared-worker" },
  ])
})
