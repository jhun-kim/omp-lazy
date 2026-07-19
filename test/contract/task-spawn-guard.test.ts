import { afterEach, describe, expect, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions"
import { TaskEventLedger } from "../../src/gates/task-event-ledger"
import { parseTaskSpawn, TaskSpawnGuard } from "../../src/gates/task-spawn-guard"
import { TransactionStore } from "../../src/state/transaction-store"
import { initializedStore, temporaryRoot } from "../fixtures/store-fixtures"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("OMP 17.0.5 task input parsing", () => {
  test("Given a flat task When parsed Then fan-out is one", () => {
    // Given / When
    const parsed = parseTaskSpawn({ name: "worker", agent: "reviewer", task: "Review" })

    // Then
    expect(parsed).toEqual({
      ok: true,
      value: {
        itemCount: 1,
        requests: [{ itemIndex: 0, requestedName: "worker", agentType: "reviewer" }],
      },
    })
  })

  test("Given a batch task When parsed Then every item consumes fan-out", () => {
    // Given / When
    const parsed = parseTaskSpawn({
      context: "shared",
      tasks: [{ task: "one" }, { name: "worker", task: "two", isolated: true }],
    })

    // Then
    expect(parsed.ok && parsed.value.itemCount).toBe(2)
  })

  test.each([
    ["empty object", {}],
    ["empty batch", { context: "shared", tasks: [] }],
    ["non-array batch", { context: "shared", tasks: "bad" }],
    ["missing batch context", { tasks: [{ task: "one" }] }],
    ["missing item task", { context: "shared", tasks: [{ name: "worker" }] }],
    ["non-object item", { context: "shared", tasks: ["bad"] }],
    ["mixed forms", { context: "shared", tasks: [{ task: "one" }], task: "flat" }],
    ["unknown flat field", { task: "one", surprise: true }],
  ])("Given %s When parsed Then it fails closed", (_name, input) => {
    // Given / When / Then
    expect(parseTaskSpawn(input)).toEqual({ ok: false, code: "malformed_task_input" })
  })
})

describe("durable fan-out reservation", () => {
  test("Given an active run When allowed and blocked calls arrive Then only allowed items persist", async () => {
    // Given
    const root = await temporaryRoot("task-guard-cap")
    roots.push(root.displayPath)
    const { store } = await initializedStore(root)
    const ledger = new TaskEventLedger(store)
    const guard = new TaskSpawnGuard(ledger, 3)

    // When
    const first = await guard.handle({
      toolName: "task",
      toolCallId: "tool-batch",
      input: { context: "shared", tasks: [{ task: "one" }, { task: "two" }] },
      sessionId: "session-a",
    })
    const second = await guard.handle({
      toolName: "task",
      toolCallId: "tool-flat",
      input: { task: "three" },
      sessionId: "session-a",
    })
    const blocked = await guard.handle({
      toolName: "task",
      toolCallId: "tool-over",
      input: { task: "four" },
      sessionId: "session-a",
    })
    const reservations = await ledger.reservations("session-a")

    // Then
    expect([first, second]).toEqual([undefined, undefined])
    expect(blocked).toEqual({ block: true, reason: "omp-lazy: fan-out limit exceeded" })
    expect(reservations.map((reservation) => reservation.itemCount)).toEqual([2, 1])
  })

  test("Given a repeated tool call id When guarded Then reservation is idempotent", async () => {
    // Given
    const root = await temporaryRoot("task-guard-repeat")
    roots.push(root.displayPath)
    const { store } = await initializedStore(root)
    const ledger = new TaskEventLedger(store)
    const guard = new TaskSpawnGuard(ledger, 2)
    const request = {
      toolName: "task",
      toolCallId: "tool-repeat",
      input: { task: "one" },
      sessionId: "session-a",
    } as const

    // When
    await guard.handle(request)
    const repeated = await guard.handle(request)

    // Then
    expect(repeated).toBeUndefined()
    expect(await ledger.reservations("session-a")).toHaveLength(1)
  })

  test("Given a huge batch When it exceeds policy Then no partial reservation persists", async () => {
    // Given
    const root = await temporaryRoot("task-guard-huge")
    roots.push(root.displayPath)
    const { store } = await initializedStore(root)
    const ledger = new TaskEventLedger(store)
    const guard = new TaskSpawnGuard(ledger, 8)

    // When
    const result = await guard.handle({
      toolName: "task",
      toolCallId: "tool-huge",
      input: {
        context: "shared",
        tasks: Array.from({ length: 2_000 }, (_, index) => ({ task: `item-${index}` })),
      },
      sessionId: "session-a",
    })

    // Then
    expect(result).toEqual({ block: true, reason: "omp-lazy: fan-out limit exceeded" })
    expect(await ledger.reservations("session-a")).toEqual([])
  })

  test("Given an unsafe fan-out policy When guarded Then the call fails closed", async () => {
    // Given
    const root = await temporaryRoot("task-guard-invalid-policy")
    roots.push(root.displayPath)
    const { store } = await initializedStore(root)
    const guard = new TaskSpawnGuard(new TaskEventLedger(store), Number.MAX_SAFE_INTEGER + 1)

    // When
    const result = await guard.handle({
      toolName: "task",
      toolCallId: "tool-policy",
      input: { task: "one" },
      sessionId: "session-a",
    })

    // Then
    expect(result).toEqual({ block: true, reason: "omp-lazy: invalid fan-out policy" })
  })

  test("Given no current-session run When a malformed task arrives Then it passes through", async () => {
    // Given
    const root = await temporaryRoot("task-guard-no-run")
    roots.push(root.displayPath)
    const guard = new TaskSpawnGuard(new TaskEventLedger(new TransactionStore(root)), 2)

    // When
    const result = await guard.handle({
      toolName: "task",
      toolCallId: "tool-1",
      input: {},
      sessionId: "session-a",
    })

    // Then
    expect(result).toBeUndefined()
  })

  test("Given only a foreign-session run When job or IRC controls arrive Then they pass unchanged", async () => {
    // Given
    const root = await temporaryRoot("task-guard-foreign-session")
    roots.push(root.displayPath)
    const { store } = await initializedStore(root)
    const guard = new TaskSpawnGuard(new TaskEventLedger(store), 2)

    // When
    const results = await Promise.all([
      guard.handle({
        toolName: "job",
        toolCallId: "job-foreign-session",
        input: { cancel: ["foreign"] },
        sessionId: "session-b",
      }),
      guard.handle({
        toolName: "irc",
        toolCallId: "irc-foreign-session",
        input: { op: "send", to: "foreign", message: "hello" },
        sessionId: "session-b",
      }),
    ])

    // Then
    expect(results).toEqual([undefined, undefined])
  })

  test("Given malformed present state When task controls arrive Then they fail closed", async () => {
    const root = await temporaryRoot("task-guard-malformed-state")
    roots.push(root.displayPath)
    const { store } = await initializedStore(root)
    await writeFile(store.paths.activeIndex, "{not-json", "utf8")
    const guard = new TaskSpawnGuard(new TaskEventLedger(store), 2)

    const results = await Promise.all([
      guard.handle({
        toolName: "job",
        toolCallId: "job-malformed-state",
        input: { list: true },
        sessionId: "session-a",
      }),
      guard.handle({
        toolName: "irc",
        toolCallId: "irc-malformed-state",
        input: { op: "list" },
        sessionId: "session-a",
      }),
    ])

    expect(results).toEqual([
      { block: true, reason: "omp-lazy: task state conflict" },
      { block: true, reason: "omp-lazy: task state conflict" },
    ])
  })
})

test("Given the public extension surface When loaded Then one task guard is registered", async () => {
  // Given / When
  const loaded = await loadExtensions(
    [join(process.cwd(), "test", "fixtures", "todo8-task-plugin", "extension.ts")],
    process.cwd(),
  )

  // Then
  expect(loaded.errors).toEqual([])
  expect(loaded.extensions[0]?.handlers.get("tool_call")?.length).toBe(1)
})
