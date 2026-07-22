import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import type { ActivationSuppressionPort } from "../../src/activation/types"
import type {
  ContinuationCoordinatorPort,
  CoordinatorRequest,
  CoordinatorResult,
} from "../../src/continuation/continuation-coordinator"
import { createDeadlineFence } from "../../src/continuation/deadline-fence"
import { DurableContinuationCoordinator } from "../../src/continuation/durable-continuation"
import { handleSessionStop } from "../../src/continuation/register-session-stop"
import { runSnapshotPath } from "../../src/state/paths"
import {
  durableDependencies,
  initializedContinuationStore,
} from "../fixtures/continuation-fixtures"

type Deferred = {
  readonly promise: Promise<CoordinatorResult>
  readonly resolve: (result: CoordinatorResult) => void
}

function deferred(): Deferred {
  let complete: ((result: CoordinatorResult) => void) | undefined
  const promise = new Promise<CoordinatorResult>((resolve) => {
    complete = resolve
  })
  if (complete === undefined) throw new Error("deferred resolver missing")
  return { promise, resolve: complete }
}

describe("session stop timeout fence", () => {
  test("Given blocked coordinator I/O When released after the internal deadline Then no late context or suppression escapes", async () => {
    // Given
    let now = 0
    let captured: CoordinatorRequest | undefined
    const gate = deferred()
    const coordinator: ContinuationCoordinatorPort = {
      handle: async (request) => {
        captured = request
        return gate.promise
      },
    }
    const messages: string[] = []
    const suppression: ActivationSuppressionPort = {
      suppressNext: async (request) => {
        messages.push(request.text)
      },
      runCommand: async (_sessionId, operation) => operation(),
    }
    const pending = handleSessionStop(
      {
        contextPercent: 20,
        contextSessionId: "session-a",
        cwd: process.cwd(),
        diagnosticTurnId: 0,
        leafId: "leaf-late",
        sessionId: "session-a",
        stopHookActive: false,
      },
      {
        coordinator,
        suppression,
        createFence: () => createDeadlineFence(250, { nowMs: () => now }),
      },
    )
    await Promise.resolve()

    // When
    now = 251
    gate.resolve({ kind: "continue", additionalContext: "late continuation" })
    const result = await pending

    // Then
    expect(captured?.leafId).toBe("leaf-late")
    expect(result).toBeUndefined()
    expect(messages).toEqual([])
    expect(captured?.fence.isValid()).toBeFalse()
  })

  test("Given real state and blocked plan I/O When released after expiry Then state, messages, events, and lock bytes stay unchanged", async () => {
    // Given
    const { root, run, store } = await initializedContinuationStore("continuation-late-store")
    let now = 0
    let releasePlan: ((bytes: string) => void) | undefined
    let markEntered: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const blockedPlan = new Promise<string>((resolve) => {
      releasePlan = resolve
    })
    if (releasePlan === undefined || markEntered === undefined) throw new Error("I/O gate missing")
    const base = durableDependencies(root, store)
    const coordinator = new DurableContinuationCoordinator({
      ...base,
      readPlan: async () => {
        markEntered?.()
        return blockedPlan
      },
    })
    const messages: string[] = []
    await store.readIndex()
    const indexBefore = await readFile(store.paths.activeIndex, "utf8")
    const runPath = runSnapshotPath(root, run.runId)
    const runBefore = await readFile(runPath, "utf8")
    const eventsBefore = await readdir(store.paths.events)
    const pending = handleSessionStop(
      {
        contextPercent: 20,
        contextSessionId: "session-a",
        cwd: root.displayPath,
        diagnosticTurnId: 0,
        leafId: "leaf-blocked",
        sessionId: "session-a",
        stopHookActive: false,
      },
      {
        coordinator,
        suppression: {
          suppressNext: async (request) => {
            messages.push(request.text)
          },
          runCommand: async (_sessionId, operation) => operation(),
        },
        createFence: () => createDeadlineFence(250, { nowMs: () => now }),
      },
    )
    await entered

    // When
    now = 251
    releasePlan("## TODOs\n- [ ] late\n")
    const result = await pending

    // Then
    expect(result).toBeUndefined()
    expect(await readFile(store.paths.activeIndex, "utf8")).toBe(indexBefore)
    expect(await readFile(runPath, "utf8")).toBe(runBefore)
    expect(await readdir(store.paths.events)).toEqual(eventsBefore)
    expect(messages).toEqual([])
    expect(await Bun.file(store.paths.lock).exists()).toBeFalse()
  })

  test("Given blocked receipt authority I/O When released after expiry Then no late state or continuation escapes", async () => {
    const { root, run, store } = await initializedContinuationStore("continuation-late-authority")
    let now = 0
    let releaseAuthority: (() => void) | undefined
    let markEntered: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const blockedAuthority = new Promise<void>((resolve) => {
      releaseAuthority = resolve
    })
    if (releaseAuthority === undefined || markEntered === undefined)
      throw new Error("I/O gate missing")
    const base = durableDependencies(root, store)
    const coordinator = new DurableContinuationCoordinator({
      ...base,
      openStore: () => ({
        readIndex: () => store.readIndex(),
        readRun: (runId) => store.readRun(runId),
        readReceiptAuthority: async () => {
          markEntered?.()
          await blockedAuthority
          return { taskGeneration: 0, accepted: [], rejected: [] }
        },
        commit: (event, options) => store.commit(event, options),
      }),
    })
    const before = await store.readRun(run.runId)
    const messages: string[] = []
    const pending = handleSessionStop(
      {
        contextPercent: 20,
        contextSessionId: "session-a",
        cwd: root.displayPath,
        diagnosticTurnId: 0,
        leafId: "leaf-authority",
        sessionId: "session-a",
        stopHookActive: false,
      },
      {
        coordinator,
        suppression: {
          suppressNext: async (request) => {
            messages.push(request.text)
          },
          runCommand: async (_sessionId, operation) => operation(),
        },
        createFence: () => createDeadlineFence(250, { nowMs: () => now }),
      },
    )
    await entered

    now = 251
    releaseAuthority()
    const result = await pending

    expect(result).toBeUndefined()
    expect(await store.readRun(run.runId)).toEqual(before)
    expect(messages).toEqual([])
    expect(await Bun.file(store.paths.lock).exists()).toBeFalse()
  })
})
