import { describe, expect, test } from "bun:test"
import { decideContinuation } from "../../../src/continuation/continuation-coordinator"
import type { ActiveIndex } from "../../../src/state/domain"
import { activeIndex, startWorkRun, ulwLoopRun } from "../../fixtures/state-fixtures"

function dualSnapshot() {
  const start = startWorkRun()
  const loop = {
    ...ulwLoopRun(),
    transactionRevision: start.transactionRevision,
    owner: { sessionId: start.owner.sessionId, epoch: 2 },
  }
  const first = activeIndex().entries[0]
  if (first === undefined) throw new Error("fixture entry missing")
  const index: ActiveIndex = {
    ...activeIndex(),
    entries: [
      first,
      {
        workflow: "ulw_loop",
        sessionId: loop.owner.sessionId,
        runId: loop.runId,
        ownerEpoch: loop.owner.epoch,
        runRevision: loop.revision,
        transactionRevision: loop.transactionRevision,
        statusHint: "active",
      },
    ],
  }
  return {
    index,
    start,
    loop,
    plan: {
      taskIds: start.payload.plan.taskIds,
      remainingTaskIds: [start.payload.plan.taskIds[0] ?? "build state"],
      fingerprint: start.payload.plan.taskFingerprint,
    },
  }
}

describe("pure continuation coordinator", () => {
  test("Given eligible start-work and ULW runs When selected Then start-work has internal priority", () => {
    const fixture = dualSnapshot()

    const result = decideContinuation({
      sessionId: "session-a",
      leafId: "leaf-1",
      snapshot: {
        index: fixture.index,
        runs: [fixture.start, fixture.loop],
        plans: [{ runId: fixture.start.runId, snapshot: fixture.plan }],
      },
    })

    expect(result).toMatchObject({
      kind: "continue",
      run: { workflow: "start_work" },
      mutation: { kind: "continuation_attempted", leafId: "leaf-1" },
    })
  })

  test("Given paused start-work and active ULW When selected Then ULW is eligible", () => {
    const fixture = dualSnapshot()
    const paused = {
      ...fixture.start,
      payload: { ...fixture.start.payload, status: "paused" as const },
    }
    const first = fixture.index.entries[0]
    if (first === undefined) throw new Error("fixture entry missing")
    const index = {
      ...fixture.index,
      entries: [{ ...first, statusHint: "paused" as const }, fixture.index.entries[1] ?? first],
    }

    const result = decideContinuation({
      sessionId: "session-a",
      leafId: "leaf-2",
      snapshot: { index, runs: [paused, fixture.loop], plans: [] },
    })

    expect(result).toMatchObject({ kind: "continue", run: { workflow: "ulw_loop" } })
  })

  test("Given a replayed leaf or missing indexed target When selected Then it stays quiet", () => {
    const fixture = dualSnapshot()
    const replay = {
      ...fixture.start,
      continuation: { ...fixture.start.continuation, lastProcessedLeafId: "leaf-1" },
    }

    expect(
      decideContinuation({
        sessionId: "session-a",
        leafId: "leaf-1",
        snapshot: { index: fixture.index, runs: [replay, fixture.loop], plans: [] },
      }),
    ).toEqual({ kind: "quiet" })
    expect(
      decideContinuation({
        sessionId: "session-a",
        leafId: "leaf-new",
        snapshot: { index: fixture.index, runs: [], plans: [] },
      }),
    ).toEqual({ kind: "quiet" })
  })

  test("Given two unchanged ULW attempts When a distinct leaf stops Then it persists stuck without continuing", () => {
    const fixture = dualSnapshot()
    const loop = {
      ...fixture.loop,
      continuation: {
        ...fixture.loop.continuation,
        progressRevisionSeen: fixture.loop.progressRevision,
        noProgressAttempts: 2,
      },
    }

    const result = decideContinuation({
      sessionId: "session-a",
      leafId: "leaf-3",
      snapshot: { index: fixture.index, runs: [fixture.start, loop], plans: [] },
    })

    expect(result).toMatchObject({
      kind: "stuck",
      run: { workflow: "ulw_loop" },
      mutation: { kind: "continuation_stuck", leafId: "leaf-3" },
    })
  })

  test("Given malformed, foreign, or terminal ownership When selected Then it stays quiet", () => {
    const fixture = dualSnapshot()
    const first = fixture.index.entries[0]
    if (first === undefined) throw new Error("fixture entry missing")
    const terminal = {
      ...fixture.start,
      payload: { ...fixture.start.payload, status: "completed" as const },
    }
    const malformed = { ...fixture.index, entries: [first, { ...first }] }

    const decisions = [
      decideContinuation({
        sessionId: "session-a",
        leafId: "leaf-malformed",
        snapshot: { index: malformed, runs: [fixture.start], plans: [] },
      }),
      decideContinuation({
        sessionId: "foreign-session",
        leafId: "leaf-foreign",
        snapshot: {
          index: fixture.index,
          runs: [fixture.start, fixture.loop],
          plans: [{ runId: fixture.start.runId, snapshot: fixture.plan }],
        },
      }),
      decideContinuation({
        sessionId: "session-a",
        leafId: "leaf-terminal",
        snapshot: { index: fixture.index, runs: [terminal, fixture.loop], plans: [] },
      }),
    ]

    expect(decisions).toEqual([{ kind: "quiet" }, { kind: "quiet" }, { kind: "quiet" }])
  })
})
