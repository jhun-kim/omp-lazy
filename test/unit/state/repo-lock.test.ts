import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { deadlineAfter, RepoLock } from "../../../src/state/repo-lock"
import { temporaryRoot } from "../../fixtures/store-fixtures"

describe("repository lock", () => {
  test("Given an unowned lock When acquired and released Then only its nonce is removed", async () => {
    // Given
    const root = await temporaryRoot("lock-acquire")
    const lock = new RepoLock(join(root.displayPath, "state.lock"))

    // When
    const handle = await lock.tryAcquire({
      deadline: deadlineAfter(1_000),
      purpose: "command",
      sessionId: "session-a",
      maxWaitMs: 100,
    })
    if (handle === null) throw new Error("lock not acquired")
    const released = await handle.release()

    // Then
    expect(handle.metadata.nonce).toMatch(/^[0-9a-f-]{36}$/)
    expect(released).toBeTrue()
    expect(await lock.readMetadata()).toBeNull()
  })

  test("Given a timestamp-old held lock When another owner times out Then it is never stolen", async () => {
    // Given
    const root = await temporaryRoot("lock-held")
    const path = join(root.displayPath, "state.lock")
    const lock = new RepoLock(path)
    const owner = await lock.tryAcquire({
      deadline: deadlineAfter(1_000),
      purpose: "command",
      sessionId: "session-a",
      maxWaitMs: 100,
    })
    if (owner === null) throw new Error("owner lock not acquired")
    const before = await readFile(path, "utf8")

    // When
    const contender = await lock.tryAcquire({
      deadline: deadlineAfter(30),
      purpose: "stop",
      sessionId: "session-b",
      maxWaitMs: 25,
    })

    // Then
    expect(contender).toBeNull()
    expect(await readFile(path, "utf8")).toBe(before)
    await owner.release()
  })
})
