import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentIdSchema, ToolCallIdSchema } from "../../src/contracts/agent-ids"
import { WorkerAcceptanceLedger } from "../../src/contracts/worker-acceptance-ledger"
import { appendAcceptanceWal } from "../../src/contracts/worker-acceptance-wal"
import { TaskSidecarStore } from "../../src/gates/task-sidecar-store"
import { deadlineAfter } from "../../src/state/repo-lock"
import { TeammodeStateStore } from "../../src/workflows/teammode-state-store"
import { initializedStore, temporaryRoot } from "../fixtures/store-fixtures"
import { removeTeamRuntime, teamDefinition, teamRuntime } from "../fixtures/teammode-fixtures"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

async function redirectedStore(descendant: string) {
  const root = await temporaryRoot(`descendant-${descendant}`)
  const external = await temporaryRoot(`external-${descendant}`)
  roots.push(root.displayPath, external.displayPath)
  const { store, run } = await initializedStore(root)
  const path = join(store.paths.root, descendant)
  await mkdir(store.paths.root, { recursive: true })
  await symlink(external.displayPath, path, "junction")
  return { external: external.displayPath, run, store }
}

async function outcome(operation: () => Promise<unknown>): Promise<"rejected" | "resolved"> {
  try {
    await operation()
    return "resolved"
  } catch (error) {
    if (error instanceof Error) return "rejected"
    throw error
  }
}

async function externalEntries(path: string): Promise<readonly string[]> {
  return (await readdir(path, { recursive: true })).map(String).toSorted()
}

describe("state descendant containment", () => {
  test("Given task-facts is a junction When a sidecar is written Then no external bytes appear", async () => {
    // Given
    const { external, run, store } = await redirectedStore("task-facts")
    const sidecars = new TaskSidecarStore(store)

    // When
    const result = await outcome(() =>
      sidecars.transact(run.owner.sessionId, () => ({
        kind: "append",
        facts: [
          {
            kind: "task_reserved",
            toolCallId: ToolCallIdSchema.parse("redirected-task"),
            itemCount: 1,
            requests: [{ itemIndex: 0, requestedName: null, agentType: null }],
          },
        ],
        value: null,
      })),
    )

    // Then
    expect({ result, external: await externalEntries(external) }).toEqual({
      result: "rejected",
      external: [],
    })
  })

  test("Given worker-rejections is a junction When rejection is persisted Then no external bytes appear", async () => {
    // Given
    const { external, run, store } = await redirectedStore("worker-rejections")
    const ledger = new WorkerAcceptanceLedger(store)

    // When
    const result = await outcome(() =>
      ledger.reject(
        {
          runId: run.runId,
          attempt: run.progressRevision,
          runRevision: run.revision,
          ownerEpoch: run.owner.epoch,
          taskGeneration: 1,
          actualAgentId: AgentIdSchema.parse("redirected-worker"),
        },
        deadlineAfter(2_000),
      ),
    )

    // Then
    expect({ result, external: await externalEntries(external) }).toEqual({
      result: "rejected",
      external: [],
    })
  })

  test("Given worker-acceptance is a junction When entries are read Then external state is rejected", async () => {
    // Given
    const { external, run, store } = await redirectedStore("worker-acceptance")
    await writeFile(
      join(external, `${run.runId}.json`),
      JSON.stringify({ schemaVersion: 1, runId: run.runId, ledgerRevision: 0, entries: [] }),
    )
    const ledger = new WorkerAcceptanceLedger(store)

    // When
    const result = await outcome(() => ledger.entries(run.runId))

    // Then
    expect(result).toBe("rejected")
  })

  test("Given worker-acceptance is a junction When WAL replacement starts Then external bytes remain unchanged", async () => {
    // Given
    const { external, run, store } = await redirectedStore("worker-acceptance")

    // When
    const result = await outcome(() =>
      appendAcceptanceWal(
        join(store.paths.root, "worker-acceptance", `${run.runId}.wal.jsonl`),
        { sequence: 1 },
        { deadline: deadlineAfter(2_000), guard: store.guard },
      ),
    )

    // Then
    expect({ result, external: await externalEntries(external) }).toEqual({
      result: "rejected",
      external: [],
    })
  })

  test("Given teams is a junction When a team is initialized Then no external bytes appear", async () => {
    // Given
    const runtime = await teamRuntime("redirected-team")
    const external = await temporaryRoot("external-team")
    roots.push(external.displayPath)
    await rm(join(runtime.store.paths.root, "teams"), { recursive: true, force: true })
    await symlink(external.displayPath, join(runtime.store.paths.root, "teams"), "junction")

    // When
    const result = await outcome(() => runtime.contract.initialize(runtime.caller, teamDefinition))
    const entries = await externalEntries(external.displayPath)
    await removeTeamRuntime(runtime)

    // Then
    expect({ result, entries }).toEqual({ result: "rejected", entries: [] })
  })

  test("Given teams is a junction When a tombstone is written Then external state is preserved", async () => {
    // Given
    const { external, store } = await redirectedStore("teams")
    const path = join(external, `${teamDefinition.teamName}.json`)
    await writeFile(path, "external team bytes\n")
    const states = new TeammodeStateStore(store)

    // When
    const result = await outcome(() => states.remove(teamDefinition.teamName, deadlineAfter(2_000)))

    // Then
    expect({ result, bytes: await Bun.file(path).text() }).toEqual({
      result: "rejected",
      bytes: "external team bytes\n",
    })
  })
})
