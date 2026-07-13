import { afterEach, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader"
import { AgentIdSchema, JobIdSchema } from "../../src/contracts/agent-ids"
import { TaskSpawnGuard } from "../../src/gates/task-spawn-guard"
import { ToolResultObserver } from "../../src/observers/tool-result-observer"
import {
  type AcceptanceRuntime,
  acceptanceBytes,
  acceptanceRuntime,
  controlRun,
  removeRuntime,
  writeEvidence,
} from "../fixtures/worker-acceptance-fixtures"

const runtimes: AcceptanceRuntime[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(removeRuntime))
})

async function runtime(label: string): Promise<AcceptanceRuntime> {
  const value = await acceptanceRuntime(label)
  runtimes.push(value)
  return value
}

test("Given the Todo 9 fixture When loaded Then exactly one model tool and no commands ship", async () => {
  const loaded = await loadExtensions(
    [join(process.cwd(), "test", "fixtures", "todo9-worker-plugin", "extension.ts")],
    process.cwd(),
  )

  expect(loaded.errors).toEqual([])
  expect(loaded.extensions.flatMap((extension) => [...extension.tools.keys()])).toEqual([
    "omp_lazy_accept_worker_result",
  ])
  expect(loaded.extensions.flatMap((extension) => [...extension.commands.keys()])).toEqual([])
})

test("Given worker and parent callers When both submit Then only the current parent can accept", async () => {
  const value = await runtime("caller-boundary")
  const evidence = await writeEvidence(value)

  const worker = await value.acceptance.accept(
    { sessionId: "worker-session", cwd: value.displayPath },
    { agentId: value.agentId, receiptPath: evidence.receiptPath },
  )
  const afterWorker = await acceptanceBytes(value)
  const parent = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    { agentId: value.agentId, receiptPath: evidence.receiptPath },
  )

  expect(worker).toMatchObject({ kind: "rejected", code: "caller_not_current_parent" })
  expect(afterWorker).toBeNull()
  expect(parent.kind).toBe("accepted")
})

test("Given a misleading worker self-report When no parent tool runs Then no criterion-side state advances", async () => {
  const value = await runtime("self-report")
  const evidence = await writeEvidence(value)
  await writeFile(evidence.artifactPath, "ACCEPTED: all criteria complete\n")
  const before = await value.store.readRun(value.run.runId)

  const entries = await value.acceptance.acceptanceLedger.entries(value.run.runId)
  const after = await value.store.readRun(value.run.runId)

  expect(entries).toEqual([])
  expect(await acceptanceBytes(value)).toBeNull()
  expect(after?.revision).toBe(before?.revision)
})

test("Given a prior task generation When a real later task result binds Then only the later IDs accept", async () => {
  const value = await runtime("generation")
  const prior = await writeEvidence(value)
  const guard = new TaskSpawnGuard(value.ledger, 8)
  const observer = new ToolResultObserver(value.ledger)
  const agentId = AgentIdSchema.parse("actual-worker-2")
  const jobId = JobIdSchema.parse("actual-worker-2")
  await guard.handle({
    toolName: "task",
    toolCallId: "later-dispatch",
    input: { name: "worker", agent: "omp-lazy-worker-high", task: "later" },
    sessionId: value.run.owner.sessionId,
  })
  await observer.observe({
    toolName: "task",
    toolCallId: "later-dispatch",
    input: {},
    details: {
      projectAgentsDir: null,
      results: [],
      totalDurationMs: 1,
      progress: [{ index: 0, id: agentId, agent: "omp-lazy-worker-high", status: "running" }],
      async: { state: "running", jobId, type: "task" },
    },
    isError: false,
    sessionId: value.run.owner.sessionId,
  })

  const stale = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    { agentId: value.agentId, receiptPath: prior.receiptPath },
  )
  const current = await writeEvidence(value, {
    workerRole: "omp-lazy-worker-high",
    actualAgentId: agentId,
    actualJobId: jobId,
  })
  const accepted = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    { agentId, receiptPath: current.receiptPath },
  )

  expect(stale).toMatchObject({ kind: "rejected", code: "unowned_worker" })
  expect(accepted).toMatchObject({ kind: "accepted" })
})

test("Given owner adoption When prior and current epochs submit Then only the rebound owner accepts", async () => {
  const value = await runtime("owner-epoch")
  const prior = await writeEvidence(value)
  await controlRun(value, { kind: "workflow_controlled", control: "pause" })
  const adopted = await controlRun(value, { kind: "owner_adopted", sessionId: "session-b" })
  const guard = new TaskSpawnGuard(value.ledger, 8)
  const observer = new ToolResultObserver(value.ledger)
  const agentId = AgentIdSchema.parse("epoch-two-worker")
  const jobId = JobIdSchema.parse("epoch-two-worker")
  await guard.handle({
    toolName: "task",
    toolCallId: "epoch-two-dispatch",
    input: { agent: "omp-lazy-worker-low", task: "current owner" },
    sessionId: adopted.owner.sessionId,
  })
  await observer.observe({
    toolName: "task",
    toolCallId: "epoch-two-dispatch",
    input: {},
    details: {
      projectAgentsDir: null,
      results: [],
      totalDurationMs: 1,
      progress: [{ index: 0, id: agentId, agent: "omp-lazy-worker-low", status: "running" }],
      async: { state: "running", jobId, type: "task" },
    },
    isError: false,
    sessionId: adopted.owner.sessionId,
  })

  const oldOwner = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    { agentId: value.agentId, receiptPath: prior.receiptPath },
  )
  const current = await writeEvidence(value, {
    workerRole: "omp-lazy-worker-low",
    actualAgentId: agentId,
    actualJobId: jobId,
  })
  const newOwner = await value.acceptance.accept(
    { sessionId: adopted.owner.sessionId, cwd: value.displayPath },
    { agentId, receiptPath: current.receiptPath },
  )

  expect(oldOwner).toMatchObject({ kind: "rejected", code: "caller_not_current_parent" })
  expect(newOwner).toMatchObject({ kind: "accepted" })
})

test("Given pause and resume after capture When submitted Then stale revision rejects and fresh capture accepts", async () => {
  const value = await runtime("resume")
  const stale = await writeEvidence(value)
  await controlRun(value, { kind: "workflow_controlled", control: "pause" })
  await controlRun(value, { kind: "workflow_controlled", control: "resume" })

  const rejected = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    { agentId: value.agentId, receiptPath: stale.receiptPath },
  )
  const fresh = await writeEvidence(value)
  const accepted = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    { agentId: value.agentId, receiptPath: fresh.receiptPath },
  )

  expect(rejected).toMatchObject({ kind: "rejected", code: "wrong_revision" })
  expect(accepted.kind).toBe("accepted")
})

test("Given cancellation or interruption When submitted Then acceptance bytes remain absent", async () => {
  const cancelled = await runtime("cancelled")
  const cancelledEvidence = await writeEvidence(cancelled)
  await controlRun(cancelled, { kind: "workflow_controlled", control: "cancel" })
  const terminal = await cancelled.acceptance.accept(
    { sessionId: cancelled.run.owner.sessionId, cwd: cancelled.displayPath },
    { agentId: cancelled.agentId, receiptPath: cancelledEvidence.receiptPath },
  )
  const interrupted = await runtime("interrupted")
  const interruptedEvidence = await writeEvidence(interrupted)
  const controller = new AbortController()
  controller.abort()
  const aborted = await interrupted.acceptance.accept(
    { sessionId: interrupted.run.owner.sessionId, cwd: interrupted.displayPath },
    { agentId: interrupted.agentId, receiptPath: interruptedEvidence.receiptPath },
    controller.signal,
  )

  expect(terminal).toMatchObject({ kind: "rejected", code: "caller_not_current_parent" })
  expect(aborted).toMatchObject({ kind: "rejected", code: "interrupted" })
  expect(await acceptanceBytes(cancelled)).toBeNull()
  expect(await acceptanceBytes(interrupted)).toBeNull()
})

test("Given concurrent exact submissions When serialized Then one accepts and one replays", async () => {
  const value = await runtime("concurrent")
  const evidence = await writeEvidence(value)
  const caller = { sessionId: value.run.owner.sessionId, cwd: value.displayPath }
  const input = { agentId: value.agentId, receiptPath: evidence.receiptPath }

  const results = await Promise.all([
    value.acceptance.accept(caller, input),
    value.acceptance.accept(caller, input),
  ])

  expect(results.map((result) => result.kind).sort()).toEqual(["accepted", "replayed"])
  expect(await value.acceptance.acceptanceLedger.entries(value.run.runId)).toHaveLength(1)
})

test("Given an accepted WAL without its snapshot When read Then the accepted event remains durable", async () => {
  const value = await runtime("wal-recovery")
  const evidence = await writeEvidence(value)
  const input = { agentId: value.agentId, receiptPath: evidence.receiptPath }
  await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    input,
  )
  const walPath = value.acceptance.acceptanceLedger.acceptanceWalPath(value.run.runId)
  const walBytes = await readFile(walPath, "utf8")
  await rm(value.acceptance.acceptanceLedger.acceptancePath(value.run.runId))

  const recovered = await value.acceptance.acceptanceLedger.entries(value.run.runId)
  const replay = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    input,
  )

  expect(walBytes.trim().length).toBeGreaterThan(0)
  expect(recovered).toHaveLength(1)
  expect(replay.kind).toBe("replayed")
})
