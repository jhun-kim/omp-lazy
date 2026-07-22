import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { migrateLifecycleState, recoverLifecycleMigration } from "../../src/state/migration"
import { runSnapshotPath, statePaths } from "../../src/state/paths"
import { initializedStore, temporaryRoot } from "../fixtures/store-fixtures"

const migrationRoots: string[] = []

async function migrationRoot(label: string) {
  const root = await temporaryRoot(label)
  migrationRoots.push(root.displayPath)
  return root
}

describe("durable lifecycle migration", () => {
  afterEach(async () => {
    await Promise.all(
      migrationRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    )
  })

  test("Given a complete v1 state When migrated Then every persisted lifecycle document is v2", async () => {
    // Given
    const root = await migrationRoot("migration-v1-v2")
    const { run } = await initializedStore(root)
    const paths = statePaths(root)
    await mkdir(join(paths.root, "teams"), { recursive: true })
    await writeFile(
      join(paths.root, "teams", "alpha.json"),
      JSON.stringify({
        schemaVersion: 1,
        teamName: "alpha",
        runId: run.runId,
        attempt: 0,
        revision: 1,
        status: "active",
        members: [],
      }),
    )

    // When
    const result = await migrateLifecycleState({ root })

    // Then
    expect(result).toEqual({ ok: true, status: "migrated" })
    expect(JSON.parse(await readFile(paths.activeIndex, "utf8"))).toMatchObject({
      schemaVersion: 2,
      migrationRevision: 1,
    })
    expect(JSON.parse(await readFile(runSnapshotPath(root, run.runId), "utf8"))).toMatchObject({
      schemaVersion: 2,
    })
    expect(
      JSON.parse(await readFile(join(paths.root, "teams", "alpha.json"), "utf8")),
    ).toMatchObject({
      schemaVersion: 2,
      status: "bound",
    })
  })

  test("Given an interruption at every durable boundary When recovery runs Then it restores v1 or completes v2", async () => {
    for (const boundary of [
      "prepared",
      "backed_up",
      "staged",
      "publishing",
      "commit_marker",
      "committed",
    ] as const) {
      // Given
      const root = await migrationRoot(`migration-crash-${boundary}`)
      await initializedStore(root)

      // When
      const failed = await migrateLifecycleState({
        root,
        crash: (point) => {
          if (point === boundary) throw new Error("injected crash")
        },
      })
      const recovered = await recoverLifecycleMigration(root)

      // Then
      expect(failed).toEqual({ ok: false, code: "migration_interrupted" })
      expect(recovered).toEqual(
        boundary === "prepared"
          ? { ok: false, code: "migration_recovery_required" }
          : boundary === "committed"
            ? { ok: true, status: "finalized" }
            : { ok: true, status: "restored" },
      )
      expect(JSON.parse(await readFile(statePaths(root).activeIndex, "utf8"))).toMatchObject({
        schemaVersion: boundary === "committed" ? 2 : 1,
      })
    }
  })

  test("Given a future persisted version When preflight runs Then it rejects without mutation", async () => {
    // Given
    const root = await migrationRoot("migration-future")
    const paths = statePaths(root)
    await mkdir(paths.root, { recursive: true })
    await writeFile(
      paths.activeIndex,
      JSON.stringify({ schemaVersion: 3, revision: 0, entries: [] }),
    )

    // When
    const result = await migrateLifecycleState({ root })

    // Then
    expect(result).toEqual({ ok: false, code: "unknown_schema_version" })
  })

  test("Given a damaged v1 backup When recovery runs Then it refuses partial restoration", async () => {
    // Given
    const root = await migrationRoot("migration-damaged-backup")
    await initializedStore(root)
    await migrateLifecycleState({
      root,
      crash: (boundary) => {
        if (boundary === "backed_up") throw new Error("injected crash")
      },
    })
    await writeFile(join(statePaths(root).root, "migration", "backup", "active.json"), "damaged")

    // When
    const result = await recoverLifecycleMigration(root)

    // Then
    expect(result).toEqual({ ok: false, code: "migration_recovery_required" })
  })
})
