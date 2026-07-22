import { describe, expect, test } from "bun:test"
import { parseStartWorkPlan } from "../../../src/workflows/start-work-plan"
import { reduceWorkflowControl } from "../../../src/workflows/workflow-control"
import { startWorkRun, ulwLoopRun } from "../../fixtures/state-fixtures"

describe("pure workflow control", () => {
  test("Given active work When paused then resumed Then owner epoch is preserved", () => {
    // Given
    const run = startWorkRun()
    const paused = reduceWorkflowControl(run, {
      kind: "pause",
      sessionId: "session-a",
      expectedEpoch: 1,
    })
    if (!paused.ok) throw new Error(paused.code)

    // When
    const resumed = reduceWorkflowControl(paused.run, {
      kind: "resume",
      sessionId: "session-a",
      expectedEpoch: 1,
    })

    // Then
    expect(resumed).toMatchObject({
      ok: true,
      run: { owner: { sessionId: "session-a", epoch: 1 }, payload: { status: "active" } },
    })
  })

  test("Given paused work When adopted Then ownership changes and epoch increments exactly once", () => {
    // Given
    const run = startWorkRun()
    const paused = reduceWorkflowControl(run, {
      kind: "pause",
      sessionId: "session-a",
      expectedEpoch: 1,
    })
    if (!paused.ok) throw new Error(paused.code)

    // When
    const adopted = reduceWorkflowControl(paused.run, {
      kind: "adopt",
      sessionId: "session-b",
      expectedEpoch: 1,
    })

    // Then
    expect(adopted).toMatchObject({
      ok: true,
      run: { owner: { sessionId: "session-b", epoch: 2 } },
    })
  })

  test("Given a foreign or stale owner When controlled Then bytes-equivalent input is returned as conflict", () => {
    // Given
    const run = startWorkRun()

    // When
    const foreign = reduceWorkflowControl(run, {
      kind: "pause",
      sessionId: "session-b",
      expectedEpoch: 1,
    })
    const stale = reduceWorkflowControl(run, {
      kind: "pause",
      sessionId: "session-a",
      expectedEpoch: 0,
    })

    // Then
    expect(foreign).toEqual({ ok: false, code: "owner_mismatch" })
    expect(stale).toEqual({ ok: false, code: "epoch_mismatch" })
  })

  test.each([
    "completed",
    "cancelled",
    "failed",
    "abandoned",
  ] as const)("Given terminal start-work %s When resumed or adopted Then it is rejected", (status) => {
    // Given
    const run = startWorkRun()
    const terminal = { ...run, payload: { ...run.payload, status } }

    // When
    const resumed = reduceWorkflowControl(terminal, {
      kind: "resume",
      sessionId: "session-a",
      expectedEpoch: 1,
    })
    const adopted = reduceWorkflowControl(terminal, {
      kind: "adopt",
      sessionId: "session-b",
      expectedEpoch: 1,
    })

    // Then
    expect(resumed).toEqual({ ok: false, code: "terminal" })
    expect(adopted).toEqual({ ok: false, code: "terminal" })
  })

  test("Given a replacement plan identity When reconciled Then new static tasks become authoritative", () => {
    // Given
    const run = startWorkRun()
    const plan = parseStartWorkPlan(
      "<!-- omp-lazy-ulw-plan:plan:v1 -->\n## TODOs\n- [ ] **REPLACEMENT. Replacement task**\n\n## Final Verification Wave\n- [ ] **REVIEW. Review**\n",
    )

    // When
    const result = reduceWorkflowControl(run, {
      kind: "reconcile_plan",
      sessionId: "session-a",
      expectedEpoch: 1,
      plan,
    })

    // Then
    expect(result).toMatchObject({
      ok: true,
      run: {
        payload: {
          plan: { taskIds: ["REPLACEMENT", "REVIEW"], taskFingerprint: plan.fingerprint },
        },
      },
    })
  })

  test("Given ULW blocked work When adopted Then it activates without a Goal runtime", () => {
    // Given
    const run = ulwLoopRun()
    const blocked = { ...run, payload: { ...run.payload, status: "blocked" as const } }

    // When
    const result = reduceWorkflowControl(blocked, {
      kind: "adopt",
      sessionId: "session-b",
      expectedEpoch: 2,
    })

    // Then
    expect(result).toMatchObject({
      ok: true,
      run: { owner: { sessionId: "session-b", epoch: 3 }, payload: { status: "active" } },
    })
  })
})
