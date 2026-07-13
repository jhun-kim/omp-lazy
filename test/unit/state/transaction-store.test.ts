import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
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
})
