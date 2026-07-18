import { describe, expect, test } from "bun:test"
import { clearConfirmedStaleLock, inspectRecovery, repairState } from "../../src/state/recovery"
import { deadlineAfter, RepoLock } from "../../src/state/repo-lock"
import { initializedStore, pauseEvent, temporaryRoot } from "../fixtures/store-fixtures"

const CRASH_POINTS = [["before_event"], ["after_event"], ["after_run"], ["after_index"]] as const
const EXPECTED = {
  before_event: {
    before: { kind: "healthy", revision: 1 },
    after: { kind: "healthy", revision: 1 },
  },
  after_event: {
    before: { kind: "repairable", eventSequence: 2 },
    after: { kind: "healthy", revision: 2 },
  },
  after_run: {
    before: { kind: "repairable", eventSequence: 2 },
    after: { kind: "healthy", revision: 2 },
  },
  after_index: {
    before: { kind: "healthy", revision: 2 },
    after: { kind: "healthy", revision: 2 },
  },
} as const

describe("transaction crash boundaries", () => {
  test.each(
    CRASH_POINTS,
  )("Given a process crash at %s When explicitly inspected/repaired Then state is last-commit or converged", async (point) => {
    // Given
    const root = await temporaryRoot(`crash-${point}`)
    const { run } = await initializedStore(root)
    const writer = `${process.cwd()}\\test\\fixtures\\state-crash-writer.ts`
    const child = Bun.spawn(
      ["bun", writer, root.displayPath, JSON.stringify(pauseEvent(run)), point],
      { stdout: "ignore", stderr: "ignore" },
    )

    // When
    const exit = await child.exited
    const lock = new RepoLock(`${root.displayPath}\\.omo\\omp-lazy\\state.lock`)
    const metadata = await lock.readMetadata()
    if (metadata === null) throw new Error("crash lock receipt missing")
    const cleared = await clearConfirmedStaleLock({
      root,
      lockPath: lock.path,
      expectedNonce: metadata.nonce,
      ownerAlive: false,
      confirmed: true,
    })
    const before = await inspectRecovery(root)
    if (before.kind === "repairable") {
      const repaired = await repairState(root, deadlineAfter(2_000))
      if (!repaired.ok) throw new Error(repaired.code)
    }
    const after = await inspectRecovery(root)

    // Then
    expect(exit).toBe(86)
    expect(cleared).toEqual({ ok: true })
    expect(before).toEqual(EXPECTED[point].before)
    expect(after).toEqual(EXPECTED[point].after)
  })
})
