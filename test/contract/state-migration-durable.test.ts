import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentIdSchema } from "../../src/contracts/agent-ids"
import { WorkerAcceptanceLedger } from "../../src/contracts/worker-acceptance-ledger"
import { newRunId, UuidSchema } from "../../src/state/domain"
import { migrateLifecycleState, recoverLifecycleMigration } from "../../src/state/migration"
import { runSnapshotPath } from "../../src/state/paths"
import { deadlineAfter } from "../../src/state/repo-lock"
import { TransactionStore } from "../../src/state/transaction-store"
import { durableStateVersions, writeDurableV1State } from "../fixtures/migration-fixtures"
import { removeTestTree } from "../fixtures/remove-test-tree"
import { temporaryRoot } from "../fixtures/store-fixtures"

const roots: string[] = []

async function fixture(label: string) {
  const root = await temporaryRoot(label)
  roots.push(root.displayPath)
  return writeDurableV1State(root)
}

describe("durable lifecycle migration publication", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(removeTestTree))
  })

  test("Given non-empty v1 task, acceptance, WAL, rejection, run, event, and team stores When migrated Then each maps to a strict v2 identity", async () => {
    // Given
    const state = await fixture("migration-durable-stores")

    // When
    const result = await migrateLifecycleState({ root: state.root })

    // Then
    expect(result).toEqual({ ok: true, status: "migrated" })
    expect(await durableStateVersions(state)).toEqual(state.durablePaths.map(() => 2))
    const acceptance = JSON.parse(
      await readFile(join(state.paths.root, state.durablePaths[4] ?? ""), "utf8"),
    )
    const rejection = JSON.parse(
      await readFile(join(state.paths.root, state.durablePaths[6] ?? ""), "utf8"),
    )
    const wal = JSON.parse(
      (await readFile(join(state.paths.root, state.durablePaths[5] ?? ""), "utf8")).trim(),
    )
    expect(acceptance.entries[0]).toMatchObject({
      taskId: "TASK-ALPHA",
      role: "omp-lazy-worker-medium",
      semanticAttempt: 1,
    })
    expect(rejection.entries[0]).toMatchObject({
      taskId: "TASK-ALPHA",
      role: "omp-lazy-worker-medium",
      semanticAttempt: 1,
    })
    expect(wal).toMatchObject({ taskId: "TASK-ALPHA", semanticAttempt: 1, schemaVersion: 2 })
    expect(await migrateLifecycleState({ root: state.root })).toEqual({
      ok: true,
      status: "already_current",
    })
  })

  test("Given a crash after every publication boundary When recovery runs Then it leaves one complete authority version", async () => {
    const boundaries = [
      "backed_up",
      "staged",
      "publishing",
      "published:task-facts/11111111-1111-4111-8111-111111111111.json",
      "published:worker-acceptance/11111111-1111-4111-8111-111111111111.json",
      "published:worker-acceptance/11111111-1111-4111-8111-111111111111.wal.jsonl",
      "published:worker-rejections/11111111-1111-4111-8111-111111111111.json",
      "published:runs/11111111-1111-4111-8111-111111111111/run.json",
      "published:events/0000000000000001-55555555-5555-4555-8555-555555555555.json",
      "published:teams/alpha.json",
      "published:active.json",
      "commit_marker",
    ] as const
    for (const boundary of boundaries) {
      // Given
      const state = await fixture(`migration-boundary-${boundary.replaceAll(/[^a-z]/g, "-")}`)

      // When
      const failed = await migrateLifecycleState({
        root: state.root,
        crash: (point) => {
          if (point === boundary) throw new Error("injected crash")
        },
      })
      const recovered = await recoverLifecycleMigration(state.root)

      // Then
      expect(failed).toEqual({ ok: false, code: "migration_interrupted" })
      expect(recovered).toEqual(
        boundary === "commit_marker"
          ? { ok: true, status: "finalized" }
          : { ok: true, status: "restored" },
      )
      expect(await durableStateVersions(state)).toEqual(
        state.durablePaths.map(() => (boundary === "commit_marker" ? 2 : 1)),
      )
    }
  })

  test("Given crashes after every pre-marker boundary When recovered Then migration reruns from full v1", async () => {
    const paths = [
      "task-facts/11111111-1111-4111-8111-111111111111.json",
      "worker-acceptance/11111111-1111-4111-8111-111111111111.json",
      "worker-acceptance/11111111-1111-4111-8111-111111111111.wal.jsonl",
      "worker-rejections/11111111-1111-4111-8111-111111111111.json",
      "runs/11111111-1111-4111-8111-111111111111/run.json",
      "events/0000000000000001-55555555-5555-4555-8555-555555555555.json",
      "teams/alpha.json",
      "active.json",
    ] as const
    const boundaries = [
      ...paths.flatMap(
        (path) => [`backup:${path}`, `staged:${path}`, `published:${path}`] as const,
      ),
      "backing_up",
      "backed_up",
      "staged",
      "publishing",
    ] as const
    for (const boundary of boundaries) {
      // Given
      const state = await fixture(`migration-granular-${boundary.replaceAll(/[^a-z]/g, "-")}`)

      // When
      const failed = await migrateLifecycleState({
        root: state.root,
        crash: (point) => {
          if (point === boundary) throw new Error("injected crash")
        },
      })
      const recovered = await recoverLifecycleMigration(state.root)
      const rerun = await migrateLifecycleState({ root: state.root })

      // Then
      expect(failed).toEqual({ ok: false, code: "migration_interrupted" })
      expect(recovered).toEqual({ ok: true, status: "restored" })
      expect(rerun).toEqual({ ok: true, status: "migrated" })
      expect(await durableStateVersions(state)).toEqual(state.durablePaths.map(() => 2))
    }
  }, 30_000)

  test("Given migrated acceptance and rejection journals When runtime readers load them Then v2 identities remain exact", async () => {
    // Given
    const state = await fixture("migration-v2-runtime-readers")
    await migrateLifecycleState({ root: state.root })
    const ledger = new WorkerAcceptanceLedger(new TransactionStore(state.root))
    const runId = UuidSchema.parse("11111111-1111-4111-8111-111111111111")
    const exact = {
      runId,
      attempt: 1,
      runRevision: 1,
      ownerEpoch: 1,
      taskGeneration: 1,
      actualAgentId: AgentIdSchema.parse("migration-worker-a"),
      taskId: "TASK-ALPHA",
      role: "omp-lazy-worker-medium",
      semanticAttempt: 1,
    }
    const differentIdentity = { ...exact, taskId: "TASK-BETA" }

    // When
    const entries = await ledger.entries(runId)
    const exactCount = await ledger.rejectionCount(exact)
    const differentCount = await ledger.rejectionCount(differentIdentity)
    const nextCount = await ledger.reject(exact, deadlineAfter(2_000))
    const persistedRejections = JSON.parse(await readFile(ledger.rejectionPath(runId), "utf8"))

    // Then
    expect(entries).toHaveLength(1)
    expect(exactCount).toBe(2)
    expect(differentCount).toBe(0)
    expect(nextCount).toBe(3)
    expect(persistedRejections).toMatchObject({
      schemaVersion: 2,
      entries: [
        {
          runId,
          taskId: "TASK-ALPHA",
          taskGeneration: 1,
          role: "omp-lazy-worker-medium",
          semanticAttempt: 1,
          count: 3,
        },
      ],
    })
  })

  test("Given migrated v2 state When a normal lifecycle write commits Then no record downgrades or rolls back", async () => {
    // Given
    const state = await fixture("migration-post-write-authority")
    await migrateLifecycleState({ root: state.root })
    const store = new TransactionStore(state.root)
    const run = await store.readRun("11111111-1111-4111-8111-111111111111")
    if (run === null) throw new Error("run missing")

    // When
    const committed = await store.commit(
      {
        schemaVersion: 1,
        eventId: newRunId(),
        sequence: 2,
        runId: run.runId,
        workflow: run.workflow,
        kind: "workflow_controlled",
        expected: {
          indexRevision: 1,
          runRevision: run.revision,
          ownerSessionId: run.owner.sessionId,
          ownerEpoch: run.owner.epoch,
        },
        mutation: { kind: "workflow_controlled", control: "pause" },
        at: "2026-07-22T00:00:00.000Z",
      },
      { deadline: deadlineAfter(2_000) },
    )
    const fresh = new TransactionStore(state.root)
    const index = await fresh.readIndex()
    const events = await fresh.events.readAll()

    // Then
    expect(committed).toMatchObject({ ok: true, index: { schemaVersion: 2, revision: 2 } })
    expect(index).toMatchObject({ schemaVersion: 2, revision: 2 })
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ schemaVersion: 2, sequence: 2 })
    expect(
      JSON.parse(await readFile(runSnapshotPath(state.root, run.runId), "utf8")),
    ).toMatchObject({
      schemaVersion: 2,
      transactionRevision: 2,
    })
  })

  test("Given active index published before a crash When a fresh reader opens state Then publishing recovery completes", async () => {
    // Given
    const state = await fixture("migration-reader-recovers-publishing")
    const failed = await migrateLifecycleState({
      root: state.root,
      crash: (boundary) => {
        if (boundary === "published:active.json") throw new Error("injected crash")
      },
    })
    const journalPath = join(state.paths.root, "migration", "journal.json")
    expect(failed).toEqual({ ok: false, code: "migration_interrupted" })
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({ phase: "publishing" })

    // When
    const index = await new TransactionStore(state.root).readIndex()

    // Then
    expect(index).toMatchObject({ schemaVersion: 2, revision: 1 })
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({ phase: "committed" })
    expect(await durableStateVersions(state)).toEqual(state.durablePaths.map(() => 2))
    expect(await readdir(join(state.paths.root, "migration", "history"))).not.toHaveLength(0)
  })

  test("Given staged migration bytes are altered before publication When migration publishes Then it refuses the corrupt staged authority", async () => {
    // Given
    const state = await fixture("migration-staged-authority")

    // When
    const result = await migrateLifecycleState({
      root: state.root,
      crash: (boundary) => {
        if (boundary === "staged") {
          writeFileSync(join(state.paths.root, "migration", "staged", "active.json"), "corrupt")
        }
      },
    })

    // Then
    expect(result).toEqual({ ok: false, code: "migration_recovery_required" })
  })
})
