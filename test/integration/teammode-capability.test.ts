import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions"
import { TaskEventLedger } from "../../src/gates/task-event-ledger"
import { TaskSpawnGuard } from "../../src/gates/task-spawn-guard"
import { checkTaskSurfaces, ToolResultObserver } from "../../src/observers/tool-result-observer"
import { initializedStore, temporaryRoot } from "../fixtures/store-fixtures"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function taskDetails(ids: readonly string[], asyncJobId?: string) {
  return {
    projectAgentsDir: null,
    results: [],
    totalDurationMs: 1,
    progress: ids.map((id, index) => ({ index, id, agent: "reviewer", status: "running" })),
    ...(asyncJobId === undefined
      ? {}
      : { async: { state: "running", jobId: asyncJobId, type: "task" } }),
  }
}

function jobDetails(ids: readonly string[]) {
  return {
    jobs: ids.map((id) => ({
      id,
      type: "task",
      status: "running",
      label: id,
      durationMs: 1,
    })),
  }
}

async function runtime(label: string) {
  const root = await temporaryRoot(label)
  roots.push(root.displayPath)
  const { store } = await initializedStore(root)
  const ledger = new TaskEventLedger(store)
  return { ledger, guard: new TaskSpawnGuard(ledger, 8), observer: new ToolResultObserver(ledger) }
}

async function reserveAndObserve(
  runtimeValue: Awaited<ReturnType<typeof runtime>>,
  details: unknown,
) {
  await runtimeValue.guard.handle({
    toolName: "task",
    toolCallId: "tool-task",
    input: { context: "shared", tasks: [{ task: "one" }, { task: "two" }] },
    sessionId: "session-a",
  })
  return runtimeValue.observer.observe({
    toolName: "task",
    toolCallId: "tool-task",
    input: {},
    details,
    isError: false,
    sessionId: "session-a",
  })
}

test("Given the public extension surface When loaded Then one result observer is registered", async () => {
  // Given / When
  const loaded = await loadExtensions(
    [join(process.cwd(), "test", "fixtures", "todo8-task-plugin", "extension.ts")],
    process.cwd(),
  )

  // Then
  expect(loaded.errors).toEqual([])
  expect(loaded.extensions[0]?.handlers.get("tool_result")?.length).toBe(1)
})

describe("honest async capability", () => {
  test("Given active tools When task or job is absent Then the surface is blocked", () => {
    expect(checkTaskSurfaces(["task", "job"])).toEqual({ status: "surface_available" })
    expect(checkTaskSurfaces(["task"])).toEqual({
      status: "blocked",
      reason: "task_or_job_surface_missing",
    })
  })

  test("Given an inline task result When observed Then async capability stays blocked", async () => {
    const value = await runtime("capability-inline")

    const result = await reserveAndObserve(value, taskDetails(["worker", "worker-2"]))

    expect(result).toEqual({ kind: "recorded", capability: "blocked" })
    expect(await value.ledger.capability("session-a")).toEqual({
      status: "blocked",
      reason: "async_unavailable_or_inline",
    })
  })

  test("Given async task and matching jobs When observed Then capability becomes proven", async () => {
    const value = await runtime("capability-proven")
    await reserveAndObserve(value, taskDetails(["worker", "worker-2"], "worker"))
    await value.guard.handle({
      toolName: "job",
      toolCallId: "tool-job",
      input: { list: true },
      sessionId: "session-a",
    })

    const result = await value.observer.observe({
      toolName: "job",
      toolCallId: "tool-job",
      input: { list: true },
      details: jobDetails(["worker", "worker-2"]),
      isError: false,
      sessionId: "session-a",
    })

    expect(result).toEqual({ kind: "recorded", capability: "proven" })
    expect(await value.ledger.capability("session-a")).toEqual({
      status: "proven",
      reason: "matching_job_snapshot",
    })
  })

  test("Given a partial job snapshot When observed Then identity capability is blocked", async () => {
    const value = await runtime("capability-partial")
    await reserveAndObserve(value, taskDetails(["worker", "worker-2"], "worker"))
    await value.guard.handle({
      toolName: "job",
      toolCallId: "tool-job",
      input: { list: true },
      sessionId: "session-a",
    })

    const result = await value.observer.observe({
      toolName: "job",
      toolCallId: "tool-job",
      input: { list: true },
      details: jobDetails(["worker"]),
      isError: false,
      sessionId: "session-a",
    })

    expect(result).toEqual({ kind: "recorded", capability: "blocked" })
    expect(await value.ledger.capability("session-a")).toMatchObject({
      status: "blocked",
      reason: "identity_mapping_incomplete",
    })
  })

  test("Given malformed or stale task results When observed Then they fail closed", async () => {
    const value = await runtime("capability-invalid")
    const malformed = await reserveAndObserve(value, { success: true, agentId: "invented" })
    const stale = await value.observer.observe({
      toolName: "task",
      toolCallId: "missing-reservation",
      input: {},
      details: taskDetails(["invented"], "invented"),
      isError: false,
      sessionId: "session-a",
    })

    expect(malformed).toEqual({ kind: "blocked", reason: "invalid task result" })
    expect(stale).toEqual({ kind: "blocked", reason: "identity_mapping_incomplete" })
    expect(await value.ledger.identities("session-a")).toEqual([])
  })

  test("Given an unrelated job result without a current pre-call permit Then it cannot prove capability", async () => {
    // Given
    const value = await runtime("capability-unrelated")
    await reserveAndObserve(value, taskDetails(["worker", "worker-2"], "worker"))

    // When
    const result = await value.observer.observe({
      toolName: "job",
      toolCallId: "unrelated-job-call",
      input: { list: true },
      details: jobDetails(["worker", "worker-2"]),
      isError: false,
      sessionId: "session-a",
    })

    // Then
    expect(result).toEqual({ kind: "blocked", reason: "uncorrelated job result" })
    expect(await value.ledger.capability("session-a")).toEqual({ status: "unknown" })
  })

  test("Given a job permit from an older task generation Then its result cannot prove capability", async () => {
    const value = await runtime("capability-stale-generation")
    await reserveAndObserve(value, taskDetails(["worker", "worker-2"], "worker"))
    await value.guard.handle({
      toolName: "job",
      toolCallId: "stale-job-call",
      input: { list: true },
      sessionId: "session-a",
    })
    await value.guard.handle({
      toolName: "task",
      toolCallId: "new-task",
      input: { task: "new generation" },
      sessionId: "session-a",
    })
    await value.observer.observe({
      toolName: "task",
      toolCallId: "new-task",
      input: {},
      details: taskDetails(["worker-3"], "worker-3"),
      isError: false,
      sessionId: "session-a",
    })

    const result = await value.observer.observe({
      toolName: "job",
      toolCallId: "stale-job-call",
      input: { list: true },
      details: jobDetails(["worker", "worker-2", "worker-3"]),
      isError: false,
      sessionId: "session-a",
    })

    expect(result).toEqual({ kind: "blocked", reason: "stale task generation" })
    expect(await value.ledger.capability("session-a")).toEqual({ status: "unknown" })
  })

  test("Given older and current bound generations When the current jobs return Then capability is proven", async () => {
    // Given
    const value = await runtime("capability-current-generation")
    await reserveAndObserve(value, taskDetails(["older", "older-2"], "older"))
    await value.guard.handle({
      toolName: "task",
      toolCallId: "current-task",
      input: { task: "current generation" },
      sessionId: "session-a",
    })
    await value.observer.observe({
      toolName: "task",
      toolCallId: "current-task",
      input: {},
      details: taskDetails(["current"], "current"),
      isError: false,
      sessionId: "session-a",
    })
    const permitted = await value.guard.handle({
      toolName: "job",
      toolCallId: "current-job-call",
      input: { list: true },
      sessionId: "session-a",
    })

    // When
    const result = await value.observer.observe({
      toolName: "job",
      toolCallId: "current-job-call",
      input: { list: true },
      details: jobDetails(["current"]),
      isError: false,
      sessionId: "session-a",
    })

    // Then
    expect(permitted).toBeUndefined()
    expect(result).toEqual({ kind: "recorded", capability: "proven" })
    expect(await value.ledger.capability("session-a")).toEqual({
      status: "proven",
      reason: "matching_job_snapshot",
    })
  })
})
