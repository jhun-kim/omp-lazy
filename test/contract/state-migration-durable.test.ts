import { afterEach, describe, expect, test } from "bun:test"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { migrateLifecycleState, recoverLifecycleMigration } from "../../src/state/migration"
import { durableStateVersions, writeDurableV1State } from "../fixtures/migration-fixtures"
import { temporaryRoot } from "../fixtures/store-fixtures"

const roots: string[] = []

async function fixture(label: string) {
  const root = await temporaryRoot(label)
  roots.push(root.displayPath)
  return writeDurableV1State(root)
}

describe("durable lifecycle migration publication", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  test("Given non-empty v1 task, acceptance, WAL, rejection, run, event, and team stores When migrated Then each maps to a strict v2 identity", async () => {
    // Given
    const state = await fixture("migration-durable-stores")

    // When
    const result = await migrateLifecycleState({ root: state.root })

    // Then
    expect(result).toEqual({ ok: true, status: "migrated" })
    expect(await durableStateVersions(state)).toEqual(state.durablePaths.map(() => 2))
    const acceptance = JSON.parse(
      await readFile(join(state.paths.root, state.durablePaths[4] ?? ""), "utf8"),
    )
    const rejection = JSON.parse(
      await readFile(join(state.paths.root, state.durablePaths[6] ?? ""), "utf8"),
    )
    const wal = JSON.parse(
      (await readFile(join(state.paths.root, state.durablePaths[5] ?? ""), "utf8")).trim(),
    )
    expect(acceptance.entries[0]).toMatchObject({
      taskId: "TASK-ALPHA",
      role: "omp-lazy-worker-medium",
      semanticAttempt: 1,
    })
    expect(rejection.entries[0]).toMatchObject({
      taskId: "TASK-ALPHA",
      role: "omp-lazy-worker-medium",
      semanticAttempt: 1,
    })
    expect(wal).toMatchObject({ taskId: "TASK-ALPHA", semanticAttempt: 1, schemaVersion: 2 })
    expect(await migrateLifecycleState({ root: state.root })).toEqual({
      ok: true,
      status: "already_current",
    })
  })

  test("Given a crash after every publication boundary When recovery runs Then it leaves one complete authority version", async () => {
    const boundaries = [
      "backed_up",
      "staged",
      "publishing",
      "published:task-facts/11111111-1111-4111-8111-111111111111.json",
      "published:worker-acceptance/11111111-1111-4111-8111-111111111111.json",
      "published:worker-acceptance/11111111-1111-4111-8111-111111111111.wal.jsonl",
      "published:worker-rejections/11111111-1111-4111-8111-111111111111.json",
      "published:runs/11111111-1111-4111-8111-111111111111/run.json",
      "published:events/0000000000000001-55555555-5555-4555-8555-555555555555.json",
      "published:teams/alpha.json",
      "published:active.json",
      "commit_marker",
    ] as const
    for (const boundary of boundaries) {
      // Given
      const state = await fixture(`migration-boundary-${boundary.replaceAll(/[^a-z]/g, "-")}`)

      // When
      const failed = await migrateLifecycleState({
        root: state.root,
        crash: (point) => {
          if (point === boundary) throw new Error("injected crash")
        },
      })
      const recovered = await recoverLifecycleMigration(state.root)

      // Then
      expect(failed).toEqual({ ok: false, code: "migration_interrupted" })
      expect(recovered).toEqual(
        boundary === "commit_marker"
          ? { ok: true, status: "finalized" }
          : { ok: true, status: "restored" },
      )
      expect(await durableStateVersions(state)).toEqual(
        state.durablePaths.map(() => (boundary === "commit_marker" ? 2 : 1)),
      )
    }
  })

  test("Given crashes after every pre-marker boundary When recovered Then migration reruns from full v1", async () => {
    const paths = [
      "task-facts/11111111-1111-4111-8111-111111111111.json",
      "worker-acceptance/11111111-1111-4111-8111-111111111111.json",
      "worker-acceptance/11111111-1111-4111-8111-111111111111.wal.jsonl",
      "worker-rejections/11111111-1111-4111-8111-111111111111.json",
      "runs/11111111-1111-4111-8111-111111111111/run.json",
      "events/0000000000000001-55555555-5555-4555-8555-555555555555.json",
      "teams/alpha.json",
      "active.json",
    ] as const
    const boundaries = [
      ...paths.flatMap(
        (path) => [`backup:${path}`, `staged:${path}`, `published:${path}`] as const,
      ),
      "backing_up",
      "backed_up",
      "staged",
      "publishing",
    ] as const
    for (const boundary of boundaries) {
      // Given
      const state = await fixture(`migration-granular-${boundary.replaceAll(/[^a-z]/g, "-")}`)

      // When
      const failed = await migrateLifecycleState({
        root: state.root,
        crash: (point) => {
          if (point === boundary) throw new Error("injected crash")
        },
      })
      const recovered = await recoverLifecycleMigration(state.root)
      const rerun = await migrateLifecycleState({ root: state.root })

      // Then
      expect(failed).toEqual({ ok: false, code: "migration_interrupted" })
      expect(recovered).toEqual({ ok: true, status: "restored" })
      expect(rerun).toEqual({ ok: true, status: "migrated" })
      expect(await durableStateVersions(state)).toEqual(state.durablePaths.map(() => 2))
    }
  }, 30_000)
})
