import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { ActivationSuppressionPort } from "../../src/activation/types"
import { createDeadlineFence } from "../../src/continuation/deadline-fence"
import { DurableContinuationCoordinator } from "../../src/continuation/durable-continuation"
import { handleSessionStop } from "../../src/continuation/register-session-stop"
import { decodeRun } from "../../src/state/codec"
import type { StartWorkRun } from "../../src/state/domain"
import { UuidSchema } from "../../src/state/domain"
import { deadlineAfter } from "../../src/state/repo-lock"
import { TransactionStore } from "../../src/state/transaction-store"
import { parseStartWorkPlan } from "../../src/workflows/start-work-plan"
import { validUlwLoopJson } from "../fixtures/state-fixtures"
import { createEvent, startRun, temporaryRoot } from "../fixtures/store-fixtures"

// ────── BASELINE ──────

describe("durable continuation eligibility – BASELINE characterization", () => {
  test("Given NO active run When session stops Then continuation returns undefined (no continuation)", async () => {
    // This pins existing behavior: empty state root = no continuation
    const root = await temporaryRoot("baseline-no-run")
    const store = new TransactionStore(root)
    const coordinator = new DurableContinuationCoordinator({
      resolveRoot: async () => root,
      openStore: () => store,
      readPlan: async () => null,
      eventId: () => UuidSchema.parse(crypto.randomUUID()),
      nowIso: () => new Date().toISOString(),
    })
    const result = await coordinator.handle({
      cwd: root.displayPath,
      diagnosticTurnId: 0,
      fence: createDeadlineFence(2000),
      leafId: "leaf-baseline-1",
      sessionId: "session-a",
    })
    expect(result).toEqual({ kind: "quiet" })
  })

  test("Given an active start-work run with remaining items When session stops below 90% context Then continuation fires with additionalContext", async () => {
    // This pins existing behavior: active run + remaining items = continue
    const root = await temporaryRoot("baseline-active-run")
    const planMarkdown =
      "<!-- omp-lazy-ulw-plan:plan:v1 -->\n## TODOs\n- [x] First task\n- [x] Second task\n- [ ] Third task\n- [ ] Fourth task\n- [ ] Fifth task\n\n## Final Verification Wave\n- [ ] Final review\n"
    const plan = parseStartWorkPlan(planMarkdown)
    const seed = startRun(root)
    const run: StartWorkRun = {
      ...seed,
      payload: {
        ...seed.payload,
        plan: {
          ...seed.payload.plan,
          taskFingerprint: plan.fingerprint,
          taskIds: plan.taskIds,
        },
      },
    }
    await mkdir(dirname(run.payload.plan.displayPath), { recursive: true })
    await writeFile(run.payload.plan.displayPath, planMarkdown)
    const store = new TransactionStore(root)
    const created = await store.commit(createEvent(run), { deadline: deadlineAfter(2_000) })
    if (!created.ok || created.run.workflow !== "start_work") {
      throw new Error("fixture commit failed")
    }
    const coordinator = new DurableContinuationCoordinator({
      resolveRoot: async () => root,
      openStore: () => store,
      readPlan: async (path) => readFile(path, "utf8"),
      eventId: () => UuidSchema.parse(crypto.randomUUID()),
      nowIso: () => new Date().toISOString(),
    })
    const result = await coordinator.handle({
      cwd: root.displayPath,
      diagnosticTurnId: 0,
      fence: createDeadlineFence(2000),
      leafId: "leaf-baseline-2",
      sessionId: "session-a",
    })
    expect(result.kind).toBe("continue")
    if (result.kind === "continue") {
      expect(typeof result.additionalContext).toBe("string")
      expect(result.additionalContext.length).toBeGreaterThan(0)
    }
  })

  test("Given context percent >= 90 When session stops Then no continuation (existing context-pressure guard)", async () => {
    // This pins the existing session_stop guard: high context pressure = no continuation
    const suppression: ActivationSuppressionPort = {
      suppressNext: async () => {},
      runCommand: async (_sessionId, operation) => operation(),
    }
    const result = await handleSessionStop(
      {
        contextPercent: 90,
        contextSessionId: "session-a",
        cwd: process.cwd(),
        diagnosticTurnId: 0,
        leafId: "leaf-baseline-3",
        sessionId: "session-a",
        stopHookActive: false,
      },
      {
        coordinator: {
          handle: async () => ({ kind: "continue", additionalContext: "should never reach" }),
        },
        suppression,
        createFence: () => createDeadlineFence(2000),
      },
    )
    expect(result).toBeUndefined()
  })
})

// ────── NEW ELIGIBILITY CASES (RED → GREEN) ──────

describe("durable continuation eligibility – from durable run state (todo 14)", () => {
  test("Given a plan with 2 of 5 items done When continuation is computed Then it yields {continue:true, additionalContext} naming item 3", async () => {
    // RED: the additionalContext must NAME the next item (task id of item 3)
    const root = await temporaryRoot("eligibility-item-name")
    const planMarkdown =
      "<!-- omp-lazy-ulw-plan:plan:v1 -->\n## TODOs\n- [x] First task\n- [x] Second task\n- [ ] Third task\n- [ ] Fourth task\n- [ ] Fifth task\n\n## Final Verification Wave\n- [ ] Final review\n"
    const plan = parseStartWorkPlan(planMarkdown)
    const seed = startRun(root)
    const run: StartWorkRun = {
      ...seed,
      payload: {
        ...seed.payload,
        plan: {
          ...seed.payload.plan,
          taskFingerprint: plan.fingerprint,
          taskIds: plan.taskIds,
        },
      },
    }
    await mkdir(dirname(run.payload.plan.displayPath), { recursive: true })
    await writeFile(run.payload.plan.displayPath, planMarkdown)
    const store = new TransactionStore(root)
    const created = await store.commit(createEvent(run), { deadline: deadlineAfter(2_000) })
    if (!created.ok || created.run.workflow !== "start_work") {
      throw new Error("fixture commit failed")
    }
    const coordinator = new DurableContinuationCoordinator({
      resolveRoot: async () => root,
      openStore: () => store,
      readPlan: async (path) => readFile(path, "utf8"),
      eventId: () => UuidSchema.parse(crypto.randomUUID()),
      nowIso: () => new Date().toISOString(),
    })
    const result = await coordinator.handle({
      cwd: root.displayPath,
      diagnosticTurnId: 0,
      fence: createDeadlineFence(2000),
      leafId: "leaf-item3",
      sessionId: "session-a",
    })
    expect(result.kind).toBe("continue")
    if (result.kind === "continue") {
      // The additionalContext must name the next task id
      const nextTaskId = plan.remainingTaskIds[0]
      expect(nextTaskId).toBeDefined()
      // Assert the returned context contains the next task's identifier
      expect(result.additionalContext).toContain(nextTaskId ?? "")
    }
  })

  test("Given a COMPLETE plan (all items checked) When continuation is computed Then it yields no continuation", async () => {
    const root = await temporaryRoot("eligibility-complete")
    const planMarkdown =
      "<!-- omp-lazy-ulw-plan:plan:v1 -->\n## TODOs\n- [x] First task\n- [x] Second task\n- [x] Third task\n\n## Final Verification Wave\n- [x] Final review\n"
    const plan = parseStartWorkPlan(planMarkdown)
    const seed = startRun(root)
    const run: StartWorkRun = {
      ...seed,
      payload: {
        ...seed.payload,
        plan: {
          ...seed.payload.plan,
          taskFingerprint: plan.fingerprint,
          taskIds: plan.taskIds,
        },
      },
    }
    await mkdir(dirname(run.payload.plan.displayPath), { recursive: true })
    await writeFile(run.payload.plan.displayPath, planMarkdown)
    const store = new TransactionStore(root)
    const created = await store.commit(createEvent(run), { deadline: deadlineAfter(2_000) })
    if (!created.ok || created.run.workflow !== "start_work") {
      throw new Error("fixture commit failed")
    }
    const coordinator = new DurableContinuationCoordinator({
      resolveRoot: async () => root,
      openStore: () => store,
      readPlan: async (path) => readFile(path, "utf8"),
      eventId: () => UuidSchema.parse(crypto.randomUUID()),
      nowIso: () => new Date().toISOString(),
    })
    const result = await coordinator.handle({
      cwd: root.displayPath,
      diagnosticTurnId: 0,
      fence: createDeadlineFence(2000),
      leafId: "leaf-complete",
      sessionId: "session-a",
    })
    // A complete plan should NOT produce a "continue" result
    expect(result.kind).toBe("quiet")
  })

  test("Given NO active run (empty state root) When continuation is computed Then it yields no continuation and writes nothing", async () => {
    const root = await temporaryRoot("eligibility-empty")
    const store = new TransactionStore(root)
    const coordinator = new DurableContinuationCoordinator({
      resolveRoot: async () => root,
      openStore: () => store,
      readPlan: async () => null,
      eventId: () => UuidSchema.parse(crypto.randomUUID()),
      nowIso: () => new Date().toISOString(),
    })
    const result = await coordinator.handle({
      cwd: root.displayPath,
      diagnosticTurnId: 0,
      fence: createDeadlineFence(2000),
      leafId: "leaf-empty",
      sessionId: "session-a",
    })
    expect(result).toEqual({ kind: "quiet" })
    // Verify nothing was written
    const index = await store.readIndex()
    expect(index.entries).toHaveLength(0)
  })

  test("Given an active ulw-loop run with pending criteria When continuation is computed Then additionalContext names the pending criterion", async () => {
    const root = await temporaryRoot("eligibility-ulw-criterion")
    const raw = JSON.parse(validUlwLoopJson())
    raw.transactionRevision = 1
    raw.owner = { sessionId: "session-a", epoch: 1 }
    const decoded = decodeRun(JSON.stringify(raw), root)
    if (!decoded.ok) throw decoded.error
    if (decoded.value.workflow !== "ulw_loop") throw new Error("fixture workflow mismatch")
    const loopRun = decoded.value

    const store = new TransactionStore(root)
    // Commit creation event for the ulw_loop run
    const { decodeStateEvent } = await import("../../src/state/codec")
    const event = decodeStateEvent(
      JSON.stringify({
        schemaVersion: 1,
        eventId: "77777777-7777-4777-8777-777777777777",
        sequence: 1,
        runId: loopRun.runId,
        workflow: "ulw_loop",
        kind: "run_created",
        expected: {
          indexRevision: 0,
          runRevision: null,
          ownerSessionId: null,
          ownerEpoch: null,
        },
        mutation: { kind: "run_created", run: loopRun },
        at: "2026-07-13T00:02:00.000Z",
      }),
    )
    if (!event.ok) throw event.error
    const created = await store.commit(event.value, { deadline: deadlineAfter(2_000) })
    if (!created.ok) throw new Error(`ulw_loop fixture commit failed: ${created.code}`)

    const coordinator = new DurableContinuationCoordinator({
      resolveRoot: async () => root,
      openStore: () => store,
      readPlan: async () => null,
      eventId: () => UuidSchema.parse(crypto.randomUUID()),
      nowIso: () => new Date().toISOString(),
    })
    const result = await coordinator.handle({
      cwd: root.displayPath,
      diagnosticTurnId: 0,
      fence: createDeadlineFence(2000),
      leafId: "leaf-ulw",
      sessionId: "session-a",
    })
    expect(result.kind).toBe("continue")
    if (result.kind === "continue") {
      // Should name the pending criterion
      expect(result.additionalContext).toContain("criterion-1")
    }
  })
})
