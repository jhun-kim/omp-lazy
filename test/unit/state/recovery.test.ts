import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { statePaths } from "../../../src/state/paths"
import { clearConfirmedStaleLock, inspectRecovery, repairState } from "../../../src/state/recovery"
import { deadlineAfter } from "../../../src/state/repo-lock"
import { initializedStore, pauseEvent, temporaryRoot } from "../../fixtures/store-fixtures"

describe("explicit state recovery", () => {
  test("Given one complete event ahead When explicitly repaired Then all revision views converge", async () => {
    // Given
    const root = await temporaryRoot("recovery-event-ahead")
    const { store, run } = await initializedStore(root)
    await expect(
      store.commit(pauseEvent(run), {
        deadline: deadlineAfter(2_000),
        crash: (point) => {
          if (point === "after_event") throw new Error("crash after event")
        },
      }),
    ).rejects.toThrow("crash after event")

    // When
    const before = await inspectRecovery(root)
    const repaired = await repairState(root, deadlineAfter(2_000))
    const after = await inspectRecovery(root)

    // Then
    expect(before).toEqual({ kind: "repairable", eventSequence: 2 })
    expect(repaired).toMatchObject({
      ok: true,
      run: { transactionRevision: 2, payload: { status: "paused" } },
      index: { revision: 2, entries: [{ transactionRevision: 2 }] },
    })
    expect(after).toEqual({ kind: "healthy", revision: 2 })
  })

  test("Given a stale lock When confirmation or liveness proof is absent Then it is preserved", async () => {
    // Given
    const root = await temporaryRoot("recovery-lock-refuse")
    const path = statePaths(root).lock
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        nonce: "88888888-8888-4888-8888-888888888888",
        pid: 999_999,
        sessionId: "session-a",
        purpose: "command",
        acquiredAt: "2020-01-01T00:00:00.000Z",
      }),
    )

    // When
    const unconfirmed = await clearConfirmedStaleLock({
      lockPath: path,
      expectedNonce: "88888888-8888-4888-8888-888888888888",
      ownerAlive: false,
      confirmed: false,
    })
    const alive = await clearConfirmedStaleLock({
      lockPath: path,
      expectedNonce: "88888888-8888-4888-8888-888888888888",
      ownerAlive: true,
      confirmed: true,
    })

    // Then
    expect(unconfirmed).toEqual({ ok: false, code: "confirmation_required" })
    expect(alive).toEqual({ ok: false, code: "owner_alive" })
  })

  test("Given a proven-dead owner and exact nonce When confirmed Then stale lock clears once", async () => {
    // Given
    const root = await temporaryRoot("recovery-lock-clear")
    const path = statePaths(root).lock
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        nonce: "99999999-9999-4999-8999-999999999999",
        pid: 999_999,
        sessionId: "session-a",
        purpose: "command",
        acquiredAt: "2020-01-01T00:00:00.000Z",
      }),
    )

    // When
    const result = await clearConfirmedStaleLock({
      lockPath: path,
      expectedNonce: "99999999-9999-4999-8999-999999999999",
      ownerAlive: false,
      confirmed: true,
    })

    // Then
    expect(result).toEqual({ ok: true })
  })

  test("Given a malformed active index When inspected Then corruption is reported without repair", async () => {
    // Given
    const root = await temporaryRoot("recovery-corrupt-index")
    const path = statePaths(root).activeIndex
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, "{")

    // When
    const result = await inspectRecovery(root)

    // Then
    expect(result).toEqual({ kind: "conflict", code: "corrupt" })
  })
})
