import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader"
import { canonicalComparisonPath, runSnapshotPath } from "../../src/state/paths"
import { TransactionStore } from "../../src/state/transaction-store"
import { writeDurableV1State } from "../fixtures/migration-fixtures"
import {
  cleanupWorkflowRoots,
  publicWorkflowRuntime,
  workflowPlan,
  workflowRepository,
} from "../fixtures/workflow-lifecycle-fixtures"

afterEach(async () => {
  await cleanupWorkflowRoots()
})

describe("installed behavioral coverage through production surfaces", () => {
  test("Given the production extension When loaded Then it registers all expected handlers, commands, and tools", async () => {
    // Given: the production entrypoint loaded through the host loader.
    const loaded = await loadExtensions([join(process.cwd(), "src", "index.ts")], process.cwd())
    const extension = loaded.extensions[0]
    if (extension === undefined) throw new Error("product extension missing")

    // Then: every declared handler surface is registered.
    for (const surface of [
      "input",
      "before_agent_start",
      "session_stop",
      "tool_call",
      "tool_result",
    ] as const) {
      const handlers = extension.handlers.get(surface)
      expect(handlers, `${surface} handler missing`).toBeDefined()
      expect(handlers?.length).toBeGreaterThan(0)
    }

    // Then: every canonical and alias command is registered exactly once.
    const expectedCommands = [
      "omp-lazy-teammode(omp)",
      "teammode(omp)",
      "omp-lazy-start-work(omp)",
      "start-work(omp)",
      "omp-lazy-ultrawork(omp)",
      "ultrawork(omp)",
      "ulw(omp)",
      "ulw-loop(omp)",
      "omp-lazy-ulw-plan(omp)",
      "ulw-plan(omp)",
      "omp-lazy-ulw-research(omp)",
      "ulw-research(omp)",
      "omp-lazy-doctor(omp)",
      "lcx-doctor(omp)",
      "omp-lazy-report-bug(omp)",
      "lcx-report-bug(omp)",
      "omp-lazy-contribute-bug-fix(omp)",
      "lcx-contribute-bug-fix(omp)",
    ]
    for (const name of expectedCommands) {
      expect(extension.commands.has(name), `${name} command missing`).toBeTrue()
    }
    expect(extension.commands.size).toBe(expectedCommands.length)

    // Then: the worker acceptance tool is registered.
    expect(extension.tools.has("omp_lazy_accept_worker_result")).toBeTrue()
  })

  test("Given an approved plan When start-work runs through registered commands Then lifecycle persists without a model turn", async () => {
    // Given: a clean repository and an approved plan provisioned before launch.
    const root = await workflowRepository("installed-start")
    await mkdir(join(root, ".omo", "plans"), { recursive: true })
    await writeFile(join(root, ".omo", "plans", "work.md"), workflowPlan)
    const hash = createHash("sha256").update(workflowPlan).digest("hex")
    const runtime = await publicWorkflowRuntime(root)

    // When: approval, start, and status execute through registered commands only.
    await runtime.invoke("ulw-plan(omp)", `approve .omo/plans/work.md ${hash}`)
    await runtime.invoke("start-work(omp)", "start .omo/plans/work.md")
    await runtime.invoke("start-work(omp)", "status")

    // Then: all operations are typed PASS results with one durable run and no model prompt.
    expect(runtime.results.map((result) => [result.operation, result.status])).toEqual([
      ["approve", "PASS"],
      ["start", "PASS"],
      ["status", "PASS"],
    ])
    expect(runtime.results[1]?.runId).toBeString()
    expect(runtime.results[2]?.runId).toBe(runtime.results[1]?.runId)
    expect(runtime.prompts).toEqual([])
  })

  test("Given a ULW run When created and statused through registered commands Then the loop lifecycle is durable", async () => {
    // Given: the production extension loaded against a clean repository.
    const root = await workflowRepository("installed-ulw")
    const runtime = await publicWorkflowRuntime(root)

    // When: create and status run through the registered ulw-loop command.
    await runtime.invoke("ulw-loop(omp)", "create installed behavioral objective")
    await runtime.invoke("ulw-loop(omp)", `status ${runtime.results[0]?.runId}`)

    // Then: both operations pass and no model prompt is emitted.
    expect(runtime.results[0]).toMatchObject({ operation: "create", status: "PASS" })
    expect(runtime.results[1]).toMatchObject({ operation: "status", status: "PASS" })
    expect(runtime.prompts).toEqual([])
  })

  test("Given a team roster When prepared through registered commands Then the reservation is durable", async () => {
    // Given: an active parent run and a non-overlapping two-member roster.
    const root = await workflowRepository("installed-team")
    const runtime = await publicWorkflowRuntime(root)
    await runtime.invoke("ulw-loop(omp)", "create coordinate the installed fixture")
    await mkdir(join(root, ".omo"), { recursive: true })
    await writeFile(
      join(root, ".omo", "team.json"),
      JSON.stringify({
        teamName: "installed-alpha",
        members: [
          {
            requestedName: "installed-one",
            agentType: "omp-lazy-worker-low",
            focus: "installed slice",
            ownership: ["src/one"],
            deliverable: "installed result",
            isolated: false,
          },
          {
            requestedName: "installed-two",
            agentType: "omp-lazy-worker-low",
            focus: "second installed slice",
            ownership: ["src/two"],
            deliverable: "second installed result",
            isolated: false,
          },
        ],
      }),
    )

    // When: prepare and status run through the registered teammode command.
    await runtime.invoke("teammode(omp)", "prepare installed-alpha .omo/team.json")
    await runtime.invoke("teammode(omp)", "status installed-alpha")

    // Then: prepare passes and status correctly reports no created team yet.
    expect(runtime.results[1]).toMatchObject({ operation: "prepare", status: "PASS" })
    expect(runtime.results[2]).toMatchObject({
      operation: "status",
      status: "BLOCKED",
      code: "missing_target",
    })
    expect(runtime.prompts).toEqual([])
  })

  test("Given a FAST packet When a tier-ineligible agent reaches the registered tool_call handler Then it is blocked", async () => {
    // Given: the production extension owns a run whose current packet is FAST.
    const displayPath = await workflowRepository("installed-packet")
    const runtime = await publicWorkflowRuntime(displayPath)
    await runtime.invoke("ulw-loop(omp)", "create installed packet dispatch")
    const root = { canonicalPath: canonicalComparisonPath(displayPath), displayPath }
    const store = new TransactionStore(root)
    const index = await store.readIndex()
    const entry = index.entries[0]
    if (entry === undefined) throw new Error("active run missing")
    const run = await store.readRun(entry.runId)
    if (run === null || run.schemaVersion !== 2) throw new Error("v2 run missing")
    const packetHash = "c".repeat(64)
    await writeFile(runSnapshotPath(root, run.runId), JSON.stringify({ ...run, packetHash }))
    await mkdir(join(store.paths.root, "task-facts"), { recursive: true })
    await writeFile(
      join(store.paths.root, "task-facts", `${run.runId}.json`),
      JSON.stringify({
        schemaVersion: 2,
        runId: run.runId,
        ledgerRevision: 0,
        entries: [],
        packetHash,
        tier: "FAST",
        reservationId: "installed-fast",
      }),
    )
    const handlers = runtime.extension.handlers.get("tool_call")
    const handler = handlers?.[handlers.length - 1]
    if (handler === undefined) throw new Error("public tool_call handler missing")
    const context = {
      cwd: displayPath,
      sessionManager: { getSessionId: () => "parent-session" },
      settings: { get: () => [] as readonly string[] },
    }

    // When: a FAST-ineligible high worker and a FAST-eligible low worker reach the handler.
    const ineligible = await handler(
      {
        toolName: "task",
        toolCallId: "installed-ineligible",
        input: { agent: "omp-lazy-worker-high", task: "tier-ineligible escalation" },
      },
      context,
    )
    const eligible = await handler(
      {
        toolName: "task",
        toolCallId: "installed-eligible",
        input: { agent: "omp-lazy-worker-low", task: "FAST-eligible work" },
      },
      context,
    )

    // Then: packet tier authorization decides the outcome through the production surface.
    expect(ineligible).toEqual({ block: true, reason: "omp-lazy: agent not allowed by packet" })
    expect(eligible).toBeUndefined()
  })

  test("Given an active ULW run When session-stop fires twice without progress Then the third stop is stuck", async () => {
    // Given: the production extension loaded with an active ULW run.
    const root = await workflowRepository("installed-noprogress")
    const runtime = await publicWorkflowRuntime(root)
    await runtime.invoke("ulw-loop(omp)", "create no-progress bound fixture")
    const created = runtime.results[0]
    if (created?.runId === null || created?.runId === undefined) {
      throw new Error("ULW create result missing scope")
    }
    const handlers = runtime.extension.handlers.get("session_stop")
    expect(handlers).toHaveLength(1)
    const sessionStop = handlers?.[0]
    if (sessionStop === undefined) throw new Error("session_stop handler missing")
    const stopContext = {
      cwd: root,
      getContextUsage: () => ({ percent: 10 }),
      sessionManager: {
        getSessionId: () => "parent-session",
        getLeafId: () => "installed-leaf",
      },
    }

    // When: three consecutive session-stop events fire with the same leaf and no progress.
    const first = await sessionStop(
      { session_id: "parent-session", turn_id: 0, stop_hook_active: false },
      stopContext,
    )
    const second = await sessionStop(
      { session_id: "parent-session", turn_id: 1, stop_hook_active: false },
      {
        ...stopContext,
        sessionManager: { ...stopContext.sessionManager, getLeafId: () => "installed-leaf-2" },
      },
    )
    const third = await sessionStop(
      { session_id: "parent-session", turn_id: 2, stop_hook_active: false },
      {
        ...stopContext,
        sessionManager: { ...stopContext.sessionManager, getLeafId: () => "installed-leaf-3" },
      },
    )

    // Then: the first two stops continue, the third is quiet (stuck recorded, no continuation).
    expect(first).toMatchObject({ continue: true })
    expect(second).toMatchObject({ continue: true })
    expect(third).toBeUndefined()

    // Then: the run is marked stuck in durable state.
    await runtime.invoke("ulw-loop(omp)", `status ${created.runId}`)
    const status = runtime.results[1]
    expect(status).toMatchObject({ operation: "status", runStatus: "stuck" })
  }, 30_000)

  test("Given a frozen v1 fixture When the production extension loads Then migration produces valid v2 state", async () => {
    // Given: a frozen v1 state provisioned before plugin launch.
    const displayPath = await workflowRepository("installed-migration")
    const root = { canonicalPath: canonicalComparisonPath(displayPath), displayPath }
    const fixture = await writeDurableV1State(root)

    // When: the production extension loads and a command triggers migration.
    const runtime = await publicWorkflowRuntime(displayPath)
    await runtime.invoke("start-work(omp)", "status")

    // Then: every durable lifecycle document is now v2.
    for (const path of fixture.durablePaths) {
      const bytes = await readFile(join(fixture.paths.root, path), "utf8")
      const records = path.endsWith(".jsonl")
        ? bytes
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [JSON.parse(bytes)]
      for (const record of records) {
        expect(record.schemaVersion, `${path} not migrated to v2`).toBe(2)
      }
    }

    // Then: the active index carries the migration revision marker.
    const activeBytes = JSON.parse(await readFile(fixture.paths.activeIndex, "utf8"))
    expect(activeBytes).toMatchObject({ schemaVersion: 2, migrationRevision: 1 })
  }, 30_000)
})
