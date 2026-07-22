import { afterEach, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { AgentIdSchema } from "../../src/contracts/agent-ids"
import {
  rejectionLedgerV2Schema,
  WorkerAcceptanceLedger,
} from "../../src/contracts/worker-acceptance-ledger"
import { migrateLifecycleState } from "../../src/state/migration"
import { migrateLifecycleRecord } from "../../src/state/migration-records"
import { deadlineAfter } from "../../src/state/repo-lock"
import { removeTestTree } from "../fixtures/remove-test-tree"
import { initializedStore, temporaryRoot } from "../fixtures/store-fixtures"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTestTree))
})

test("Given worker A exhausts one exact attempt When worker B starts Then B retains its entire rejection budget", async () => {
  // Given
  const root = await temporaryRoot("worker-retry-isolation")
  roots.push(root.displayPath)
  const { store, run } = await initializedStore(root)
  expect(await migrateLifecycleState({ root })).toEqual({ ok: true, status: "migrated" })
  const ledger = new WorkerAcceptanceLedger(store)
  const common = {
    runId: run.runId,
    attempt: 0,
    runRevision: run.revision,
    ownerEpoch: run.owner.epoch,
    taskGeneration: 1,
    role: "omp-lazy-worker-low" as const,
    semanticAttempt: 1,
  }
  const workerA = {
    ...common,
    taskId: "worker-a",
    actualAgentId: AgentIdSchema.parse("agent-a"),
  }
  const workerB = {
    ...common,
    taskId: "worker-b",
    actualAgentId: AgentIdSchema.parse("agent-b"),
  }

  // When
  for (let failure = 0; failure < 3; failure += 1) {
    await ledger.reject(workerA, deadlineAfter(2_000))
  }

  // Then
  expect(await ledger.rejectionCount(workerA)).toBe(3)
  expect(await ledger.rejectionCount(workerB)).toBe(0)
  expect(JSON.parse(await readFile(ledger.rejectionPath(run.runId), "utf8")).entries).toEqual([
    expect.objectContaining({
      runId: run.runId,
      taskId: "worker-a",
      taskGeneration: 1,
      role: "omp-lazy-worker-low",
      semanticAttempt: 1,
      count: 3,
    }),
  ])
})

test("Given the same task changes generation, role, or semantic attempt When counted Then every budget is isolated", async () => {
  // Given
  const root = await temporaryRoot("worker-retry-dimensions")
  roots.push(root.displayPath)
  const { store, run } = await initializedStore(root)
  expect(await migrateLifecycleState({ root })).toEqual({ ok: true, status: "migrated" })
  const ledger = new WorkerAcceptanceLedger(store)
  const base = {
    runId: run.runId,
    attempt: 0,
    runRevision: run.revision,
    ownerEpoch: run.owner.epoch,
    taskGeneration: 1,
    taskId: "shared-task",
    role: "omp-lazy-worker-low" as const,
    semanticAttempt: 1,
    actualAgentId: AgentIdSchema.parse("agent-a"),
  }
  await ledger.reject(base, deadlineAfter(2_000))

  // When
  const counts = await Promise.all([
    ledger.rejectionCount({ ...base, taskGeneration: 2 }),
    ledger.rejectionCount({ ...base, role: "omp-lazy-worker-medium" }),
    ledger.rejectionCount({ ...base, semanticAttempt: 2 }),
  ])

  // Then
  expect(counts).toEqual([0, 0, 0])
})

test("Given a T05 v1 rejection count When migrated Then it binds to semantic attempt one", () => {
  // Given
  const runId = "11111111-1111-4111-8111-111111111111"
  const bytes = JSON.stringify({
    schemaVersion: 1,
    runId,
    entries: [
      {
        runId,
        attempt: 0,
        runRevision: 2,
        ownerEpoch: 1,
        taskGeneration: 1,
        actualAgentId: "agent-a",
        count: 2,
        status: "retry_allowed",
      },
    ],
  })

  // When
  const migrated = migrateLifecycleRecord(`worker-rejections/${runId}.json`, bytes, [
    {
      runId,
      taskId: "worker-a",
      role: "omp-lazy-worker-low",
      agentId: "agent-a",
    },
  ])

  // Then
  expect(migrated.kind).toBe("migrated")
  if (migrated.kind === "migrated") {
    const parsed = rejectionLedgerV2Schema.safeParse(JSON.parse(migrated.bytes))
    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data.entries[0]?.semanticAttempt : null).toBe(1)
  }
})

test("Given a v2 rejection identity When semantic attempt is zero Then the schema rejects it", () => {
  // Given
  const runId = "11111111-1111-4111-8111-111111111111"

  // When
  const parsed = rejectionLedgerV2Schema.safeParse({
    schemaVersion: 2,
    runId,
    entries: [
      {
        runId,
        attempt: 0,
        runRevision: 2,
        ownerEpoch: 1,
        taskGeneration: 1,
        actualAgentId: "agent-a",
        count: 1,
        status: "retry_allowed",
        taskId: "worker-a",
        role: "omp-lazy-worker-low",
        semanticAttempt: 0,
      },
    ],
  })

  // Then
  expect(parsed.success).toBe(false)
})

test("Given multiple v1 counts map to one worker When migrated Then one exact bounded count remains", () => {
  // Given
  const runId = "11111111-1111-4111-8111-111111111111"
  const entry = {
    runId,
    runRevision: 2,
    ownerEpoch: 1,
    taskGeneration: 1,
    actualAgentId: "agent-a",
    count: 2,
    status: "retry_allowed",
  } as const
  const bytes = JSON.stringify({
    schemaVersion: 1,
    runId,
    entries: [
      { ...entry, attempt: 0 },
      { ...entry, attempt: 1 },
    ],
  })

  // When
  const migrated = migrateLifecycleRecord(`worker-rejections/${runId}.json`, bytes, [
    {
      runId,
      taskId: "worker-a",
      role: "omp-lazy-worker-low",
      agentId: "agent-a",
    },
  ])

  // Then
  expect(migrated.kind).toBe("migrated")
  if (migrated.kind === "migrated") {
    expect(JSON.parse(migrated.bytes).entries).toEqual([
      expect.objectContaining({
        taskId: "worker-a",
        role: "omp-lazy-worker-low",
        semanticAttempt: 1,
        count: 3,
        status: "needs_parent_decision",
      }),
    ])
  }
})
