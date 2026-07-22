import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { migrateLifecycleState, recoverLifecycleMigration } from "../../src/state/migration"
import { migrateLifecycleRecord } from "../../src/state/migration-records"
import { runSnapshotPath, statePaths } from "../../src/state/paths"
import { initializedStore, temporaryRoot } from "../fixtures/store-fixtures"
import "./state-migration-durable.test"

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
        members: [
          {
            requestedName: "alpha-one",
            agentType: "omp-lazy-worker-low",
            focus: "first migration worker",
            ownership: ["src/one"],
            deliverable: "first durable result",
            isolated: false,
            actualAgentId: "alpha-agent-one",
            actualJobId: "alpha-job-one",
            worktreePath: null,
            acceptanceKey: null,
          },
          {
            requestedName: "alpha-two",
            agentType: "omp-lazy-worker-high",
            focus: "second migration worker",
            ownership: ["src/two"],
            deliverable: "second durable result",
            isolated: false,
            actualAgentId: "alpha-agent-two",
            actualJobId: "alpha-job-two",
            worktreePath: null,
            acceptanceKey: null,
          },
        ],
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
      "backing_up",
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
          ? { ok: true, status: "restored" }
          : boundary === "commit_marker" || boundary === "committed"
            ? { ok: true, status: "finalized" }
            : { ok: true, status: "restored" },
      )
      expect(JSON.parse(await readFile(statePaths(root).activeIndex, "utf8"))).toMatchObject({
        schemaVersion: boundary === "commit_marker" || boundary === "committed" ? 2 : 1,
      })
    }
  })

  test("Given a prepared journal without backups When recovery runs Then it safely clears the unpublished migration", async () => {
    // Given
    const root = await migrationRoot("migration-prepared-without-backup")
    await initializedStore(root)
    await migrateLifecycleState({
      root,
      crash: (boundary) => {
        if (boundary === "prepared") throw new Error("injected crash")
      },
    })

    // When
    const recovered = await recoverLifecycleMigration(root)

    // Then
    expect(recovered).toEqual({ ok: true, status: "restored" })
    expect(JSON.parse(await readFile(statePaths(root).activeIndex, "utf8"))).toMatchObject({
      schemaVersion: 1,
    })
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

  test("Given a multiline WAL containing a future schema When migration preflight runs Then it rejects before mutation", async () => {
    // Given
    const root = await migrationRoot("migration-future-wal")
    const state = await initializedStore(root)
    const wal = join(statePaths(root).root, "worker-acceptance", `${state.run.runId}.wal.jsonl`)
    await mkdir(dirname(wal), { recursive: true })
    await writeFile(
      wal,
      `${JSON.stringify({ schemaVersion: 1 })}\n${JSON.stringify({ schemaVersion: 3 })}\n`,
    )

    // When
    const result = await migrateLifecycleState({ root })

    // Then
    expect(result).toEqual({ ok: false, code: "unknown_schema_version" })
    expect(JSON.parse(await readFile(statePaths(root).activeIndex, "utf8"))).toMatchObject({
      schemaVersion: 1,
    })
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

  test("Given a production state reader sees legacy bytes When it opens state Then locked preflight migrates before exposing it", async () => {
    // Given
    const root = await migrationRoot("migration-production-preflight")
    const { store } = await initializedStore(root)

    // When
    const index = await store.readIndex()

    // Then
    expect(index.revision).toBe(1)
    expect(JSON.parse(await readFile(statePaths(root).activeIndex, "utf8"))).toMatchObject({
      schemaVersion: 2,
    })
  })

  test("Given a uniquely mapped legacy task event When migrated Then it binds generation one without a head", () => {
    // Given
    const bytes = JSON.stringify({
      schemaVersion: 1,
      eventId: "44444444-4444-4444-8444-444444444444",
      sequence: 2,
      runId: "11111111-1111-4111-8111-111111111111",
      workflow: "ulw_loop",
      kind: "criterion_failure_recorded",
      expected: { indexRevision: 1, runRevision: 1, ownerSessionId: "session-a", ownerEpoch: 1 },
      mutation: {
        kind: "criterion_failure_recorded",
        goalId: "goal-a",
        criterionId: "criterion-a",
        fingerprint: "failure-a",
      },
      at: "2026-07-13T00:02:00.000Z",
    })

    // When
    const result = migrateLifecycleRecord(
      "events/0000000000000002-44444444-4444-4444-8444-444444444444.json",
      bytes,
      [{ taskId: "TASK-ALPHA", role: "omp-lazy-worker-medium", agentId: "worker-a" }],
    )

    // Then
    expect(result).toMatchObject({ kind: "migrated" })
    if (result.kind === "migrated") {
      expect(JSON.parse(result.bytes)).toMatchObject({
        legacyHeadUnbound: true,
        expected: { expectedHead: null, taskGeneration: 1 },
      })
    }
  })

  test("Given an ambiguously mapped legacy task event When migrated Then conversion blocks", () => {
    // Given
    const bytes = JSON.stringify({
      schemaVersion: 1,
      eventId: "44444444-4444-4444-8444-444444444444",
      sequence: 2,
      runId: "11111111-1111-4111-8111-111111111111",
      workflow: "ulw_loop",
      kind: "criterion_failure_recorded",
      expected: { indexRevision: 1, runRevision: 1, ownerSessionId: "session-a", ownerEpoch: 1 },
      mutation: {
        kind: "criterion_failure_recorded",
        goalId: "goal-a",
        criterionId: "criterion-a",
        fingerprint: "failure-a",
      },
      at: "2026-07-13T00:02:00.000Z",
    })

    // When
    const result = migrateLifecycleRecord(
      "events/0000000000000002-44444444-4444-4444-8444-444444444444.json",
      bytes,
      [],
    )

    // Then
    expect(result).toEqual({ kind: "invalid" })
  })
})
