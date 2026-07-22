import { afterEach, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
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

test("Given a capped prior dispatch When its owner adopts and rebinds Then the new identity is isolated", async () => {
  const value = await acceptanceRuntime("adopted-review-fence")
  runtimes.push(value)
  const initial = await writeEvidence(value)
  await writeFile(initial.artifactPath, "")
  const oldCaller = { sessionId: value.run.owner.sessionId, cwd: value.displayPath }
  const strikes = []
  for (let index = 0; index < 3; index += 1) {
    strikes.push(
      await value.acceptance.accept(oldCaller, {
        agentId: value.agentId,
        receiptPath: initial.receiptPath,
      }),
    )
  }
  await controlRun(value, { kind: "workflow_controlled", control: "pause" })
  const adopted = await controlRun(value, { kind: "owner_adopted", sessionId: "session-b" })
  const agentId = AgentIdSchema.parse("adopted-worker")
  const jobId = JobIdSchema.parse("adopted-worker")
  const guard = new TaskSpawnGuard(value.ledger, 8)
  const observer = new ToolResultObserver(value.ledger)
  await guard.handle({
    toolName: "task",
    toolCallId: "adopted-dispatch",
    input: { agent: "omp-lazy-worker-low", task: "current owner" },
    sessionId: adopted.owner.sessionId,
  })
  await observer.observe({
    toolName: "task",
    toolCallId: "adopted-dispatch",
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
  const oldOwner = await value.acceptance.accept(oldCaller, {
    agentId: value.agentId,
    receiptPath: initial.receiptPath,
  })
  const current = await writeEvidence(value, {
    workerRole: "omp-lazy-worker-low",
    actualAgentId: agentId,
    actualJobId: jobId,
  })
  const currentCaller = { sessionId: adopted.owner.sessionId, cwd: value.displayPath }
  const input = { agentId, receiptPath: current.receiptPath }
  const accepted = await value.acceptance.accept(currentCaller, input)
  const bytesAfterAcceptance = await acceptanceBytes(value)
  const replay = await value.acceptance.accept(currentCaller, input)
  const entries = await value.acceptance.acceptanceLedger.entries(value.run.runId)

  expect(strikes.map((result) => result.kind)).toEqual([
    "rejected",
    "rejected",
    "needs_parent_decision",
  ])
  expect(current.receiptPath).toBe(initial.receiptPath)
  expect(oldOwner).toMatchObject({ kind: "rejected", code: "current_parent_required" })
  expect(accepted.kind).toBe("accepted")
  expect(replay.kind).toBe("replayed")
  expect(entries).toHaveLength(1)
  expect(entries[0]?.parentDecision).toBeUndefined()
  expect(await acceptanceBytes(value)).toBe(bytesAfterAcceptance)
})

test("Given a capped semantic role When only run progress advances Then its budget remains exhausted", async () => {
  const value = await acceptanceRuntime("new-attempt-review-fence")
  runtimes.push(value)
  const initial = await writeEvidence(value)
  await writeFile(initial.artifactPath, "")
  const caller = { sessionId: value.run.owner.sessionId, cwd: value.displayPath }
  for (let index = 0; index < 3; index += 1) {
    await value.acceptance.accept(caller, {
      agentId: value.agentId,
      receiptPath: initial.receiptPath,
    })
  }
  const advanced = await controlRun(value, {
    kind: "plan_reconciled",
    taskIds: ["next-result-target"],
    taskFingerprint: "b".repeat(64),
  })
  const next = await writeEvidence(value)

  const accepted = await value.acceptance.accept(caller, {
    agentId: value.agentId,
    receiptPath: next.receiptPath,
  })

  expect(advanced.progressRevision).toBe(value.run.progressRevision + 1)
  expect(accepted).toMatchObject({
    kind: "needs_parent_decision",
    code: "retry_cap_reached",
    rejectionCount: 3,
  })
  expect(await value.acceptance.acceptanceLedger.entries(value.run.runId)).toHaveLength(0)
})
