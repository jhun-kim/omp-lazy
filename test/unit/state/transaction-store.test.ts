import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { type PersistedStateEvent, type StateEventV2, UuidSchema } from "../../../src/state/domain"
import { runSnapshotPath, statePaths } from "../../../src/state/paths"
import { deadlineAfter } from "../../../src/state/repo-lock"
import { TransactionStore } from "../../../src/state/transaction-store"
import {
  createEvent,
  initializedStore,
  pauseEvent,
  startRun,
  temporaryRoot,
} from "../../fixtures/store-fixtures"

describe("event-first transaction store", () => {
  test("Given empty state When a create event commits Then run/index/event converge", async () => {
    // Given
    const root = await temporaryRoot("transaction-create")
    const run = startRun(root)
    const store = new TransactionStore(root)

    // When
    const result = await store.commit(createEvent(run), { deadline: deadlineAfter(2_000) })

    // Then
    expect(result).toMatchObject({
      ok: true,
      run: { transactionRevision: 1 },
      index: { revision: 1, entries: [{ transactionRevision: 1 }] },
    })
  })

  test("Given two stale writers at revision one When both commit Then only one wins CAS", async () => {
    // Given
    const root = await temporaryRoot("transaction-cas")
    const { store, run } = await initializedStore(root)
    const firstEvent = pauseEvent(run)
    const secondEvent = pauseEvent(run, "77777777-7777-4777-8777-777777777777")

    // When
    const first = await store.commit(firstEvent, { deadline: deadlineAfter(2_000) })
    const second = await store.commit(secondEvent, { deadline: deadlineAfter(2_000) })

    // Then
    expect(first.ok).toBeTrue()
    expect(second).toEqual({ ok: false, code: "index_revision_conflict" })
  })

  test("Given an expired deadline When committing Then all durable bytes remain identical", async () => {
    // Given
    const root = await temporaryRoot("transaction-deadline")
    const { store, run } = await initializedStore(root)
    const paths = statePaths(root)
    const beforeIndex = await readFile(paths.activeIndex, "utf8")
    const beforeRun = await readFile(runSnapshotPath(root, run.runId), "utf8")

    // When
    const result = await store.commit(pauseEvent(run), { deadline: deadlineAfter(0) })

    // Then
    expect(result).toEqual({ ok: false, code: "deadline_expired" })
    expect(await readFile(paths.activeIndex, "utf8")).toBe(beforeIndex)
    expect(await readFile(runSnapshotPath(root, run.runId), "utf8")).toBe(beforeRun)
  })

  test("Given an exact v2 event replay and a conflicting reuse When committed Then only the exact replay no-ops", async () => {
    // Given: migrated v2 state and one deterministic control event identity.
    const root = await temporaryRoot("transaction-idempotency")
    const { store, run } = await initializedStore(root)
    const index = await store.readIndex()
    const current = await store.readRun(run.runId)
    if (current === null) throw new Error("run missing")
    const event: StateEventV2 = {
      schemaVersion: 2,
      eventId: UuidSchema.parse("77777777-7777-4777-8777-777777777777"),
      sequence: index.revision + 1,
      runId: current.runId,
      workflow: current.workflow,
      kind: "workflow_controlled",
      expected: {
        indexRevision: index.revision,
        runRevision: current.revision,
        ownerSessionId: current.owner.sessionId,
        ownerEpoch: current.owner.epoch,
        expectedHead: null,
        taskGeneration: null,
      },
      mutation: { kind: "workflow_controlled", control: "pause" },
      legacyHeadUnbound: false,
      at: "2026-07-22T00:00:00.000Z",
    }

    // When: the event is committed, replayed exactly, and reused with another mutation.
    const committed = await store.commit(event, { deadline: deadlineAfter(2_000) })
    const replayed = await store.commit(event, { deadline: deadlineAfter(2_000) })
    const conflicting: PersistedStateEvent = {
      ...event,
      mutation: { kind: "workflow_controlled", control: "cancel" },
    }
    const rejected = await store.commit(conflicting, { deadline: deadlineAfter(2_000) })

    // Then: replay is explicit and conflicting semantics never mutate the run.
    expect(committed).toMatchObject({ ok: true, status: "committed" })
    expect(replayed).toMatchObject({ ok: true, status: "replayed" })
    expect(rejected).toEqual({ ok: false, code: "idempotency_conflict" })
    expect((await store.readRun(run.runId))?.payload.status).toBe("paused")
  })
})
