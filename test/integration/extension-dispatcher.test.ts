import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskEventLedger } from "../../src/gates/task-event-ledger"
import { registerToolCallDispatcher } from "../../src/gates/tool-call-dispatcher"
import { ToolResultObserver } from "../../src/observers/tool-result-observer"
import type { CanonicalRoot } from "../../src/state/domain"
import { canonicalComparisonPath } from "../../src/state/paths"
import { TransactionStore } from "../../src/state/transaction-store"
import { removeTestTree } from "../fixtures/remove-test-tree"
import { initializedStore } from "../fixtures/store-fixtures"

const roots: string[] = []

type DispatcherEvent = {
  readonly toolName: string
  readonly toolCallId: string
  readonly input: Record<string, unknown>
}

type DispatcherContext = {
  readonly cwd: string
  readonly sessionManager: { readonly getSessionId: () => string }
}

type DispatcherResult = { readonly block?: boolean; readonly reason?: string } | undefined
type DispatcherHandler = (
  event: DispatcherEvent,
  context: DispatcherContext,
) => Promise<DispatcherResult>

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTestTree))
})

function runGit(root: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}

async function repositoryRoot(label: string): Promise<CanonicalRoot> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), `omp-lazy-dispatcher-${label}-`)))
  roots.push(directory)
  runGit(directory, ["init", "--quiet"])
  const root = { canonicalPath: canonicalComparisonPath(directory), displayPath: directory }
  await initializedStore(root)
  return root
}

function captureDispatcher(): DispatcherHandler {
  let registered: DispatcherHandler | undefined
  const api = {
    on(_event: "tool_call", handler: DispatcherHandler) {
      registered = handler
    },
  }
  registerToolCallDispatcher(api, 4)
  if (registered === undefined) throw new Error("dispatcher not registered")
  return registered
}

function context(root: CanonicalRoot, sessionId = "session-a"): DispatcherContext {
  return { cwd: root.displayPath, sessionManager: { getSessionId: () => sessionId } }
}

async function bindActualWorker(root: CanonicalRoot): Promise<TaskEventLedger> {
  const store = new TransactionStore(root)
  const ledger = new TaskEventLedger(store)
  const dispatch = captureDispatcher()
  await dispatch(
    { toolName: "task", toolCallId: "task-owned", input: { task: "one" } },
    context(root),
  )
  await new ToolResultObserver(ledger).observe({
    toolName: "task",
    toolCallId: "task-owned",
    input: {},
    details: {
      projectAgentsDir: null,
      results: [],
      totalDurationMs: 1,
      progress: [{ index: 0, id: "actual-worker", agent: "worker", status: "running" }],
      async: { state: "running", jobId: "actual-worker", type: "task" },
    },
    isError: false,
    sessionId: "session-a",
  })
  return ledger
}

describe("composed OMP tool dispatch authorization", () => {
  test("Given an owned run When task fan-out and unrelated tools dispatch Then task reserves and unrelated tools pass through", async () => {
    const root = await repositoryRoot("allowed")
    const dispatch = captureDispatcher()

    const unrelated = await dispatch(
      { toolName: "read", toolCallId: "read-outside", input: { path: "../outside" } },
      context(root),
    )
    const allowed = await dispatch(
      {
        toolName: "task",
        toolCallId: "task-batch",
        input: { context: "shared", tasks: [{ task: "one" }, { task: "two" }] },
      },
      context(root),
    )

    expect(unrelated).toBeUndefined()
    expect(allowed).toBeUndefined()
    expect(
      await new TaskEventLedger(new TransactionStore(root)).reservations("session-a"),
    ).toHaveLength(1)
  })

  test("Given malformed controlled calls When an owned run is active Then they block without partial reservation", async () => {
    const root = await repositoryRoot("malformed")
    const dispatch = captureDispatcher()

    const malformedBatch = await dispatch(
      { toolName: "task", toolCallId: "task-bad", input: { context: "shared", tasks: [] } },
      context(root),
    )
    const malformedJob = await dispatch(
      { toolName: "job", toolCallId: "job-bad", input: { cancel: "actual-worker" } },
      context(root),
    )

    expect(malformedBatch).toEqual({ block: true, reason: "omp-lazy: malformed task input" })
    expect(malformedJob).toEqual({ block: true, reason: "omp-lazy: malformed job control" })
    expect(await new TaskEventLedger(new TransactionStore(root)).reservations("session-a")).toEqual(
      [],
    )
  })

  test("Given malformed controlled calls When no owned run is active Then host behavior passes through", async () => {
    const root = await repositoryRoot("foreign")
    const dispatch = captureDispatcher()

    const malformed = await dispatch(
      { toolName: "job", toolCallId: "job-foreign", input: { cancel: "actual-worker" } },
      context(root, "session-b"),
    )

    expect(malformed).toBeUndefined()
  })

  test("Given ambiguous active state When an unrelated tool dispatches Then host behavior passes through", async () => {
    const root = await repositoryRoot("unrelated-conflict")
    const store = new TransactionStore(root)
    const index = await store.readIndex()
    const entry = index.entries[0]
    if (entry === undefined) throw new Error("missing active entry")
    await writeFile(store.paths.activeIndex, JSON.stringify({ ...index, entries: [entry, entry] }))
    const dispatch = captureDispatcher()

    const result = await dispatch(
      { toolName: "read", toolCallId: "read-conflict", input: { path: "../outside" } },
      context(root),
    )

    expect(result).toBeUndefined()
  })

  test("Given owned IDs When job and IRC controls dispatch Then actual IDs authorize and foreign IDs block pre-host", async () => {
    const root = await repositoryRoot("owned-controls")
    await bindActualWorker(root)
    const dispatch = captureDispatcher()

    const ownedJob = await dispatch(
      { toolName: "job", toolCallId: "job-owned", input: { cancel: ["actual-worker"] } },
      context(root),
    )
    const unownedJob = await dispatch(
      { toolName: "job", toolCallId: "job-foreign", input: { cancel: ["foreign-worker"] } },
      context(root),
    )
    const staleIrc = await dispatch(
      {
        toolName: "irc",
        toolCallId: "irc-stale",
        input: { op: "send", to: "actual-worker", message: "hello" },
      },
      context(root),
    )
    const mixedWait = await dispatch(
      {
        toolName: "hub",
        toolCallId: "hub-mixed-wait",
        input: { op: "wait", ids: ["actual-worker"], from: "actual-worker" },
      },
      context(root),
    )
    const foreignMixedWait = await dispatch(
      {
        toolName: "hub",
        toolCallId: "hub-foreign-wait",
        input: { op: "wait", ids: ["actual-worker"], from: "foreign-worker" },
      },
      context(root),
    )
    await dispatch(
      { toolName: "task", toolCallId: "task-new", input: { task: "new" } },
      context(root),
    )
    const staleResult = await new ToolResultObserver(
      new TaskEventLedger(new TransactionStore(root)),
    ).observe({
      toolName: "irc",
      toolCallId: "irc-stale",
      input: { op: "send", to: "actual-worker", message: "hello" },
      details: { op: "send", receipts: [{ to: "actual-worker", outcome: "injected" }] },
      isError: false,
      sessionId: "session-a",
    })

    expect(ownedJob).toBeUndefined()
    expect(unownedJob).toEqual({ block: true, reason: "omp-lazy: unowned job" })
    expect(staleIrc).toBeUndefined()
    expect(mixedWait).toBeUndefined()
    expect(foreignMixedWait).toEqual({ block: true, reason: "omp-lazy: unowned agent" })
    expect(staleResult).toEqual({ kind: "blocked", reason: "stale task generation" })
  })

  test("Given unknown fields on controlled input When parsed at the boundary Then no reservation is written", async () => {
    const root = await repositoryRoot("unknown-fields")
    const dispatch = captureDispatcher()

    const result = await dispatch(
      { toolName: "task", toolCallId: "task-unknown", input: { task: "one", unknown: true } },
      context(root),
    )

    expect(result).toEqual({ block: true, reason: "omp-lazy: malformed task input" })
    expect(await new TaskEventLedger(new TransactionStore(root)).reservations("session-a")).toEqual(
      [],
    )
  })
})
