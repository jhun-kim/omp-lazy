import { afterEach, describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions"
import { TaskEventLedger } from "../../src/gates/task-event-ledger"
import {
  canonicalTaskProjection,
  parseTaskSpawn,
  TaskSpawnGuard,
} from "../../src/gates/task-spawn-guard"
import { TransactionStore } from "../../src/state/transaction-store"
import { removeTestTree } from "../fixtures/remove-test-tree"
import { initializedStore, temporaryRoot } from "../fixtures/store-fixtures"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTestTree))
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
        requests: [
          {
            canonicalInputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            itemIndex: 0,
            requestedName: "worker",
            agentType: "reviewer",
          },
        ],
      },
    })
  })

  test("Given equivalent Task fields When projected Then bytes use the frozen lexical key order", () => {
    // Given: Task values with omitted defaults and surrounding whitespace.
    const input = { agent: " reviewer ", name: " worker ", task: " Review safely " }

    // When: the coordinator projects the trusted spawn input.
    const projection = canonicalTaskProjection(input)

    // Then: all four keys and defaults serialize in exact lexical order without whitespace.
    expect(projection).toBe(
      '{"agent":"reviewer","isolated":false,"name":"worker","task":"Review safely"}',
    )
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
  test("Given a FAST packet When high and low agents spawn Then only the exact allowlist passes", async () => {
    // Given
    const root = await temporaryRoot("task-guard-fast-allowlist")
    roots.push(root.displayPath)
    const { store } = await initializedStore(root)
    const ledger = new TaskEventLedger(store)
    const guard = new TaskSpawnGuard(ledger, 1, {
      packetHash: "a".repeat(64),
      tier: "FAST",
      allowedAgentTypes: ["omp-lazy-worker-low"],
    })

    // When
    const hiddenHigh = await guard.handle({
      toolName: "task",
      toolCallId: "tool-hidden-high",
      input: { agent: "omp-lazy-worker-high", task: "attempt forbidden escalation" },
      sessionId: "session-a",
    })
    const allowedLow = await guard.handle({
      toolName: "task",
      toolCallId: "tool-allowed-low",
      input: { agent: "omp-lazy-worker-low", task: "execute packet" },
      sessionId: "session-a",
    })

    // Then
    expect(hiddenHigh).toEqual({
      block: true,
      reason: "omp-lazy: agent not allowed by packet (FAST tier; eligible: omp-lazy-worker-low)",
    })
    expect(allowedLow).toBeUndefined()
    expect(
      (await ledger.reservations("session-a")).map((reservation) => String(reservation.toolCallId)),
    ).toEqual(["tool-allowed-low"])
  })

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

describe("corrective spawn-block reasons", () => {
  test("Given a FAST-tier packet When a tier-ineligible agent is requested Then the reason names the tier and sorted eligible agents", async () => {
    // Given
    const root = await temporaryRoot("task-guard-corrective-fast")
    roots.push(root.displayPath)
    const { store } = await initializedStore(root)
    const ledger = new TaskEventLedger(store)
    const guard = new TaskSpawnGuard(ledger, 3, {
      packetHash: "f".repeat(64),
      tier: "FAST",
      allowedAgentTypes: [
        "omp-lazy-explorer",
        "omp-lazy-librarian",
        "omp-lazy-planner",
        "omp-lazy-researcher",
        "omp-lazy-worker-low",
      ],
    })

    // When
    const result = await guard.handle({
      toolName: "task",
      toolCallId: "tool-corrective-fast",
      input: { agent: "omp-lazy-worker-high", task: "attempt escalation" },
      sessionId: "session-a",
    })

    // Then: reason preserves the omp-lazy: prefix, includes the tier and sorted eligible agents
    expect(result).toBeDefined()
    const blocked = result as { block: true; reason: string }
    expect(blocked.block).toBe(true)
    expect(blocked.reason).toContain("omp-lazy: ")
    expect(blocked.reason).toContain("FAST")
    expect(blocked.reason).toContain("omp-lazy-explorer")
    expect(blocked.reason).toContain("omp-lazy-librarian")
    expect(blocked.reason).toContain("omp-lazy-planner")
    expect(blocked.reason).toContain("omp-lazy-researcher")
    expect(blocked.reason).toContain("omp-lazy-worker-low")
    // Agents must be sorted
    const reason = blocked.reason
    const explorerIdx = reason.indexOf("omp-lazy-explorer")
    const librarianIdx = reason.indexOf("omp-lazy-librarian")
    const plannerIdx = reason.indexOf("omp-lazy-planner")
    const researcherIdx = reason.indexOf("omp-lazy-researcher")
    const workerLowIdx = reason.indexOf("omp-lazy-worker-low")
    expect(explorerIdx).toBeLessThan(librarianIdx)
    expect(librarianIdx).toBeLessThan(plannerIdx)
    expect(plannerIdx).toBeLessThan(researcherIdx)
    expect(researcherIdx).toBeLessThan(workerLowIdx)
  })

  test("Given a STANDARD-tier packet When a tier-ineligible agent is requested Then the reason names STANDARD and its sorted eligible agents", async () => {
    // Given
    const root = await temporaryRoot("task-guard-corrective-std")
    roots.push(root.displayPath)
    const { store } = await initializedStore(root)
    const ledger = new TaskEventLedger(store)
    const guard = new TaskSpawnGuard(ledger, 3, {
      packetHash: "d".repeat(64),
      tier: "STANDARD",
      allowedAgentTypes: [
        "omp-lazy-explorer",
        "omp-lazy-librarian",
        "omp-lazy-metis",
        "omp-lazy-planner",
        "omp-lazy-qa",
        "omp-lazy-researcher",
        "omp-lazy-reviewer",
        "omp-lazy-worker-low",
        "omp-lazy-worker-medium",
      ],
    })

    // When
    const result = await guard.handle({
      toolName: "task",
      toolCallId: "tool-corrective-std",
      input: { agent: "omp-lazy-worker-high", task: "attempt deep escalation" },
      sessionId: "session-a",
    })

    // Then
    expect(result).toBeDefined()
    const blocked = result as { block: true; reason: string }
    expect(blocked.block).toBe(true)
    expect(blocked.reason).toContain("omp-lazy: ")
    expect(blocked.reason).toContain("STANDARD")
    expect(blocked.reason).toContain("omp-lazy-worker-medium")
    expect(blocked.reason).not.toContain("omp-lazy-worker-high")
  })

  test("Given the state-conflict path When it triggers Then it still returns its original reason unchanged", async () => {
    // Given
    const root = await temporaryRoot("task-guard-state-conflict-unchanged")
    roots.push(root.displayPath)
    const { store } = await initializedStore(root)
    await writeFile(store.paths.activeIndex, "{not-json", "utf8")
    const guard = new TaskSpawnGuard(new TaskEventLedger(store), 2)

    // When
    const result = await guard.handle({
      toolName: "task",
      toolCallId: "tool-state-conflict",
      input: { task: "test" },
      sessionId: "session-a",
    })

    // Then: the state-conflict reason is EXACTLY the original string, unchanged
    expect(result).toEqual({ block: true, reason: "omp-lazy: task state conflict" })
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
