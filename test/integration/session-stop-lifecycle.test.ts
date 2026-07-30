import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import type { ActivationSuppressionPort } from "../../src/activation/types"
import type {
  ContinuationCoordinatorPort,
  CoordinatorRequest,
} from "../../src/continuation/continuation-coordinator"
import { createDeadlineFence } from "../../src/continuation/deadline-fence"
import { DurableContinuationCoordinator } from "../../src/continuation/durable-continuation"
import {
  handleSessionStop,
  registerSessionStop,
  type SessionStopInput,
  type SessionStopRegistrationApi,
} from "../../src/continuation/register-session-stop"
import { STEERING_REMINDER } from "../../src/continuation/steering-reminder"
import {
  durableDependencies,
  initializedContinuationStore,
} from "../fixtures/continuation-fixtures"

function suppression(messages: string[]): ActivationSuppressionPort {
  return {
    suppressNext: async (request) => {
      messages.push(request.text)
    },
    runCommand: async (_sessionId, operation) => operation(),
  }
}

function input(overrides: Partial<SessionStopInput> = {}): SessionStopInput {
  return {
    contextPercent: 10,
    contextSessionId: "session-a",
    cwd: process.cwd(),
    diagnosticTurnId: 0,
    leafId: "leaf-1",
    sessionId: "session-a",
    stopHookActive: false,
    ...overrides,
  }
}

describe("session stop lifecycle", () => {
  test("Given two natural turn-zero stops and one replay When handled Then distinct leaves continue once", async () => {
    // Given
    const seen = new Set<string>()
    const requests: CoordinatorRequest[] = []
    const coordinator: ContinuationCoordinatorPort = {
      handle: async (request) => {
        requests.push(request)
        if (seen.has(request.leafId)) return { kind: "quiet" }
        seen.add(request.leafId)
        return { kind: "continue", additionalContext: "Continue the authoritative workflow." }
      },
    }
    const messages: string[] = []
    const dependencies = {
      coordinator,
      suppression: suppression(messages),
      createFence: () => createDeadlineFence(250),
    }

    // When
    const first = await handleSessionStop(input({ leafId: "leaf-1" }), dependencies)
    const replay = await handleSessionStop(input({ leafId: "leaf-1" }), dependencies)
    const second = await handleSessionStop(input({ leafId: "leaf-2" }), dependencies)

    // Then
    expect(first).toEqual({
      continue: true,
      additionalContext: `Continue the authoritative workflow.\n\n${STEERING_REMINDER}`,
    })
    expect(replay).toBeUndefined()
    expect(second).toEqual({
      continue: true,
      additionalContext: `Continue the authoritative workflow.\n\n${STEERING_REMINDER}`,
    })
    expect(requests.map((request) => [request.diagnosticTurnId, request.leafId])).toEqual([
      [0, "leaf-1"],
      [0, "leaf-1"],
      [0, "leaf-2"],
    ])
    expect(messages).toHaveLength(2)
  })

  test("Given unsafe lifecycle guards When handled Then no coordinator or suppression is reached", async () => {
    // Given
    let calls = 0
    const coordinator: ContinuationCoordinatorPort = {
      handle: async () => {
        calls += 1
        return { kind: "continue", additionalContext: "late" }
      },
    }
    const messages: string[] = []
    const dependencies = {
      coordinator,
      suppression: suppression(messages),
      createFence: () => createDeadlineFence(250),
    }

    // When
    const results = await Promise.all([
      handleSessionStop(input({ leafId: null }), dependencies),
      handleSessionStop(input({ leafId: "  " }), dependencies),
      handleSessionStop(input({ stopHookActive: true }), dependencies),
      handleSessionStop(input({ contextPercent: undefined }), dependencies),
      handleSessionStop(input({ contextPercent: 90 }), dependencies),
      handleSessionStop(input({ contextSessionId: "foreign" }), dependencies),
      handleSessionStop(input({ sessionId: " " }), dependencies),
    ])

    // Then
    expect(results.every((result) => result === undefined)).toBeTrue()
    expect(calls).toBe(0)
    expect(messages).toEqual([])
  })

  test("Given durable state When a leaf is replayed and a new turn-zero leaf arrives Then state and messages advance exactly twice", async () => {
    // Given
    const { root, run, store } = await initializedContinuationStore("continuation-lifecycle")
    const coordinator = new DurableContinuationCoordinator(durableDependencies(root, store))
    const messages: string[] = []
    const dependencies = {
      coordinator,
      suppression: suppression(messages),
      createFence: () => createDeadlineFence(250),
    }

    // When
    const first = await handleSessionStop(
      input({ cwd: root.displayPath, leafId: "leaf-a" }),
      dependencies,
    )
    const replay = await handleSessionStop(
      input({ cwd: root.displayPath, leafId: "leaf-a" }),
      dependencies,
    )
    const second = await handleSessionStop(
      input({ cwd: root.displayPath, leafId: "leaf-b" }),
      dependencies,
    )

    // Then
    const persisted = await store.readRun(run.runId)
    const index = await store.readIndex()
    const events = await store.events.readAll()
    expect(first?.continue).toBeTrue()
    expect(replay).toBeUndefined()
    expect(second?.continue).toBeTrue()
    expect(persisted?.continuation.lastProcessedLeafId).toBe("leaf-b")
    expect(persisted?.transactionRevision).toBe(3)
    expect(index.revision).toBe(3)
    expect(events).toHaveLength(3)
    expect(messages).toHaveLength(2)
    expect(await Bun.file(store.paths.lock).exists()).toBeFalse()
  })

  test("Given a competing CAS winner When continuation commits Then it stays quiet without suppression", async () => {
    // Given
    const { root, run, store } = await initializedContinuationStore("continuation-contention")
    const base = durableDependencies(root, store)
    const coordinator = new DurableContinuationCoordinator({
      ...base,
      openStore: () => ({
        readIndex: () => store.readIndex(),
        readRun: (runId) => store.readRun(runId),
        commit: async () => ({ ok: false, code: "revision_conflict" }),
      }),
    })
    const messages: string[] = []

    // When
    const result = await handleSessionStop(input({ cwd: root.displayPath }), {
      coordinator,
      suppression: suppression(messages),
      createFence: () => createDeadlineFence(250),
    })

    // Then
    expect(result).toBeUndefined()
    expect((await store.readRun(run.runId))?.revision).toBe(run.revision)
    expect(messages).toEqual([])
    expect(await Bun.file(store.paths.lock).exists()).toBeFalse()
  })

  test("Given the product registration When inventoried Then exactly one session_stop handler exists", async () => {
    // Given
    let count = 0
    const api: SessionStopRegistrationApi = {
      on: (event) => {
        if (event === "session_stop") count += 1
      },
    }
    const coordinator: ContinuationCoordinatorPort = { handle: async () => ({ kind: "quiet" }) }

    // When
    registerSessionStop(api, coordinator, suppression([]))
    const source = await readFile("src/continuation/register-session-stop.ts", "utf8")
    const sourceOccurrences = source.match(/\.on\("session_stop"/g)?.length ?? 0

    // Then
    expect(count).toBe(1)
    expect(sourceOccurrences).toBe(1)
  })
})
