import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { migrateLifecycleState, recoverLifecycleMigration } from "../../src/state/migration"
import { taskIdentities } from "../../src/state/migration-identities"
import { migrateLifecycleRecord } from "../../src/state/migration-records"
import {
  continuationCounterPath,
  directiveActivationPath,
  isValidLifecycleId,
  modelChainProvenancePath,
  runSnapshotPath,
  statePaths,
} from "../../src/state/paths"
import { removeTestTree } from "../fixtures/remove-test-tree"
import { initializedStore, temporaryRoot } from "../fixtures/store-fixtures"
import "./state-migration-durable.test"

const migrationRoots: string[] = []

async function migrationRoot(label: string) {
  const root = await temporaryRoot(label)
  migrationRoots.push(root.displayPath)
  return root
}

async function collectRelativePaths(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await collectRelativePaths(root, full)))
    } else if (entry.isFile()) {
      result.push(relative(root, full).replaceAll("\\", "/"))
    }
  }
  return result
}

describe("durable lifecycle migration", () => {
  afterEach(async () => {
    await Promise.all(migrationRoots.splice(0).map(removeTestTree))
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

  test("Given a task ledger identity When decoded for migration Then its runId remains part of identity", () => {
    // Given
    const runId = "11111111-1111-4111-8111-111111111111"

    // When
    const identities = taskIdentities({
      schemaVersion: 1,
      runId,
      ledgerRevision: 2,
      entries: [
        {
          sequence: 1,
          ownerSessionId: "session-a",
          ownerEpoch: 1,
          fact: {
            kind: "task_reserved",
            toolCallId: "dispatch-a",
            itemCount: 1,
            requests: [
              {
                itemIndex: 0,
                requestedName: "criterion-a",
                agentType: "omp-lazy-worker-medium",
              },
            ],
          },
        },
        {
          sequence: 2,
          ownerSessionId: "session-a",
          ownerEpoch: 1,
          fact: {
            kind: "task_identities_bound",
            toolCallId: "dispatch-a",
            bindings: [{ itemIndex: 0, actualAgentId: "worker-a", actualJobId: null }],
          },
        },
      ],
    })

    // Then
    expect(identities).toEqual([
      {
        runId,
        taskId: "criterion-a",
        role: "omp-lazy-worker-medium",
        agentId: "worker-a",
      },
    ])
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
      [
        {
          runId: "11111111-1111-4111-8111-111111111111",
          taskId: "criterion-a",
          role: "omp-lazy-worker-medium",
          agentId: "worker-a",
        },
      ],
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

  test("Given the same worker identity in two runs When a legacy event migrates Then run identity selects only its run", () => {
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
      [
        {
          runId: "11111111-1111-4111-8111-111111111111",
          taskId: "criterion-a",
          role: "omp-lazy-worker-medium",
          agentId: "worker-a",
        },
        {
          runId: "22222222-2222-4222-8222-222222222222",
          taskId: "criterion-a",
          role: "omp-lazy-worker-medium",
          agentId: "worker-a",
        },
      ],
    )

    // Then
    expect(result).toMatchObject({ kind: "migrated" })
  })

  test("Given a legacy plan event maps a later task When migrated Then ordered-plan matching blocks it", () => {
    // Given
    const bytes = JSON.stringify({
      schemaVersion: 1,
      eventId: "44444444-4444-4444-8444-444444444444",
      sequence: 2,
      runId: "11111111-1111-4111-8111-111111111111",
      workflow: "start_work",
      kind: "plan_reconciled",
      expected: { indexRevision: 1, runRevision: 1, ownerSessionId: "session-a", ownerEpoch: 1 },
      mutation: {
        kind: "plan_reconciled",
        taskIds: ["TASK-ALPHA", "TASK-BETA"],
        taskFingerprint: "a".repeat(64),
      },
      at: "2026-07-13T00:02:00.000Z",
    })

    // When
    const result = migrateLifecycleRecord(
      "events/0000000000000002-44444444-4444-4444-8444-444444444444.json",
      bytes,
      [
        {
          runId: "11111111-1111-4111-8111-111111111111",
          taskId: "TASK-BETA",
          role: "omp-lazy-worker-medium",
          agentId: "worker-b",
        },
      ],
    )

    // Then
    expect(result).toEqual({ kind: "invalid" })
  })

  // === BASELINE CHARACTERIZATION: existing record kinds ===

  test("BASELINE: Given a v1 state containing ONLY existing kinds When migrated Then the resulting file set and journal are pinned exactly", async () => {
    // Given - a v1 root with the exact existing record kinds (same fixture as the first test)
    const root = await migrationRoot("baseline-existing-kinds")
    const { run } = await initializedStore(root)
    const paths = statePaths(root)
    await mkdir(join(paths.root, "teams"), { recursive: true })
    await writeFile(
      join(paths.root, "teams", "baseline.json"),
      JSON.stringify({
        schemaVersion: 1,
        teamName: "baseline",
        runId: run.runId,
        attempt: 0,
        revision: 1,
        status: "active",
        members: [
          {
            requestedName: "b-one",
            agentType: "omp-lazy-worker-low",
            focus: "first",
            ownership: ["src/a"],
            deliverable: "first result",
            isolated: false,
            actualAgentId: "baseline-agent-one",
            actualJobId: "baseline-job-one",
            worktreePath: null,
            acceptanceKey: null,
          },
          {
            requestedName: "b-two",
            agentType: "omp-lazy-worker-high",
            focus: "second",
            ownership: ["src/b"],
            deliverable: "second result",
            isolated: false,
            actualAgentId: "baseline-agent-two",
            actualJobId: "baseline-job-two",
            worktreePath: null,
            acceptanceKey: null,
          },
        ],
      }),
    )

    // When
    const result = await migrateLifecycleState({ root })

    // Then - pin exact file set
    expect(result).toEqual({ ok: true, status: "migrated" })
    const allFiles = await collectRelativePaths(paths.root)
    const lifecycleFiles = allFiles.filter((f) => !f.startsWith("migration/") && f !== "state.lock")
    expect(lifecycleFiles.sort()).toEqual(
      [
        "active.json",
        `runs/${run.runId}/run.json`,
        "events/0000000000000001-55555555-5555-4555-8555-555555555555.json",
        "teams/baseline.json",
      ].sort(),
    )
    // Verify every file is v2
    for (const file of lifecycleFiles) {
      const content = JSON.parse(await readFile(join(paths.root, file), "utf8"))
      expect(content.schemaVersion).toBe(2)
    }
    // Verify the journal has a committed phase
    const journalPath = join(paths.root, "migration", "journal.json")
    const journal = JSON.parse(await readFile(journalPath, "utf8"))
    expect(journal.phase).toBe("committed")
    expect(journal.schemaVersion).toBe(1)
    expect(journal.items.length).toBe(lifecycleFiles.length)
  })

  // === NEW PARITY RECORD KINDS ===

  test("Given a v1 root containing all three new parity kinds When migrated Then all become v2 in ONE journaled transaction", async () => {
    // Given
    const root = await migrationRoot("parity-kinds-v1-to-v2")
    await initializedStore(root)
    const paths = statePaths(root)
    await mkdir(join(paths.root, "directive-activations"), { recursive: true })
    await mkdir(join(paths.root, "continuation-counters"), { recursive: true })
    await mkdir(join(paths.root, "model-chain-provenance"), { recursive: true })
    await writeFile(
      join(paths.root, "directive-activations", "session01.json"),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "session01",
        workflow: "ultrawork",
        activatedAt: "2026-07-30T00:00:00Z",
      }),
    )
    await writeFile(
      join(paths.root, "continuation-counters", "session02.json"),
      JSON.stringify({ schemaVersion: 1, sessionId: "session02", count: 3, maxContinuations: 8 }),
    )
    await writeFile(
      join(paths.root, "model-chain-provenance", "run03.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId: "run03",
        attempts: [{ alias: "@smol", outcome: "ok" }],
      }),
    )

    // When
    const result = await migrateLifecycleState({ root })

    // Then
    expect(result).toEqual({ ok: true, status: "migrated" })
    const da = JSON.parse(
      await readFile(join(paths.root, "directive-activations", "session01.json"), "utf8"),
    )
    const cc = JSON.parse(
      await readFile(join(paths.root, "continuation-counters", "session02.json"), "utf8"),
    )
    const mcp = JSON.parse(
      await readFile(join(paths.root, "model-chain-provenance", "run03.json"), "utf8"),
    )
    expect(da.schemaVersion).toBe(2)
    expect(cc.schemaVersion).toBe(2)
    expect(mcp.schemaVersion).toBe(2)
    // Verify ONE journal transaction
    const journal = JSON.parse(
      await readFile(join(paths.root, "migration", "journal.json"), "utf8"),
    )
    expect(journal.phase).toBe("committed")
  })

  test("Given a filename violating the id pattern When migration encounters it Then it is refused with migration_recovery_required", async () => {
    // The id pattern is: ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$
    // Invalid ids: starts with dot, has slashes, too long
    const root = await migrationRoot("parity-invalid-filename")
    await initializedStore(root)
    const paths = statePaths(root)
    await mkdir(join(paths.root, "directive-activations"), { recursive: true })
    // Write a file with an invalid id (starts with dot)
    await writeFile(
      join(paths.root, "directive-activations", ".hidden.json"),
      JSON.stringify({ schemaVersion: 1, sessionId: ".hidden" }),
    )

    // When
    const result = await migrateLifecycleState({ root })

    // Then - the isLifecyclePath regex rejects the invalid filename
    expect(result).toEqual({ ok: false, code: "migration_recovery_required" })
  })

  test("Given a nested path like directive-activations/a/b.json When migration encounters it Then isLifecyclePath refuses it", async () => {
    // nested path must be refused - the regex doesn't match nested directories
    const root = await migrationRoot("parity-nested-path")
    await initializedStore(root)
    const paths = statePaths(root)
    await mkdir(join(paths.root, "directive-activations", "a"), { recursive: true })
    await writeFile(
      join(paths.root, "directive-activations", "a", "b.json"),
      JSON.stringify({ schemaVersion: 1, data: "test" }),
    )

    // When
    const result = await migrateLifecycleState({ root })

    // Then
    expect(result).toEqual({ ok: false, code: "migration_recovery_required" })
  })

  test("Given a forced crash at the publish step for new parity kinds When recovery runs Then it restores the COMPLETE v1 set", async () => {
    // Given
    const root = await migrationRoot("parity-crash-publish")
    await initializedStore(root)
    const paths = statePaths(root)
    await mkdir(join(paths.root, "directive-activations"), { recursive: true })
    await mkdir(join(paths.root, "continuation-counters"), { recursive: true })
    await mkdir(join(paths.root, "model-chain-provenance"), { recursive: true })
    await writeFile(
      join(paths.root, "directive-activations", "s1.json"),
      JSON.stringify({ schemaVersion: 1, sessionId: "s1" }),
    )
    await writeFile(
      join(paths.root, "continuation-counters", "s2.json"),
      JSON.stringify({ schemaVersion: 1, sessionId: "s2", count: 0 }),
    )
    await writeFile(
      join(paths.root, "model-chain-provenance", "r1.json"),
      JSON.stringify({ schemaVersion: 1, runId: "r1" }),
    )

    // When - crash at publishing
    const failed = await migrateLifecycleState({
      root,
      crash: (boundary) => {
        if (boundary === "publishing") throw new Error("injected crash")
      },
    })
    const recovered = await recoverLifecycleMigration(root)

    // Then
    expect(failed).toEqual({ ok: false, code: "migration_interrupted" })
    expect(recovered).toEqual({ ok: true, status: "restored" })
    // All files must still be v1
    const da = JSON.parse(
      await readFile(join(paths.root, "directive-activations", "s1.json"), "utf8"),
    )
    const cc = JSON.parse(
      await readFile(join(paths.root, "continuation-counters", "s2.json"), "utf8"),
    )
    const mcp = JSON.parse(
      await readFile(join(paths.root, "model-chain-provenance", "r1.json"), "utf8"),
    )
    expect(da.schemaVersion).toBe(1)
    expect(cc.schemaVersion).toBe(1)
    expect(mcp.schemaVersion).toBe(1)
  })

  test("Given an unknown schemaVersion in a new parity record When migrated Then it fails with unknown_schema_version", async () => {
    // Given
    const root = await migrationRoot("parity-unknown-version")
    await initializedStore(root)
    const paths = statePaths(root)
    await mkdir(join(paths.root, "directive-activations"), { recursive: true })
    await writeFile(
      join(paths.root, "directive-activations", "s1.json"),
      JSON.stringify({ schemaVersion: 99, sessionId: "s1" }),
    )

    // When
    const result = await migrateLifecycleState({ root })

    // Then
    expect(result).toEqual({ ok: false, code: "unknown_schema_version" })
  })

  test("Given a damaged backup of a new parity kind When recovery runs Then it yields migration_recovery_required with no partial mix", async () => {
    // Given
    const root = await migrationRoot("parity-damaged-backup")
    await initializedStore(root)
    const paths = statePaths(root)
    await mkdir(join(paths.root, "directive-activations"), { recursive: true })
    await writeFile(
      join(paths.root, "directive-activations", "s1.json"),
      JSON.stringify({ schemaVersion: 1, sessionId: "s1" }),
    )

    // Crash at backed_up to ensure backups exist
    await migrateLifecycleState({
      root,
      crash: (boundary) => {
        if (boundary === "backed_up") throw new Error("injected crash")
      },
    })
    // Damage the backup
    const backupDir = join(paths.root, "migration", "backup")
    await writeFile(join(backupDir, "directive-activations", "s1.json"), "corrupt_bytes")

    // When
    const result = await recoverLifecycleMigration(root)

    // Then
    expect(result).toEqual({ ok: false, code: "migration_recovery_required" })
  })

  test("Given valid lifecycle ids Then isValidLifecycleId accepts them", () => {
    expect(isValidLifecycleId("abc")).toBe(true)
    expect(isValidLifecycleId("A1")).toBe(true)
    expect(isValidLifecycleId("session.with_dots-and-dashes")).toBe(true)
    expect(isValidLifecycleId("0")).toBe(true)
    expect(isValidLifecycleId("a".repeat(64))).toBe(true)
  })

  test("Given invalid lifecycle ids Then isValidLifecycleId rejects them", () => {
    expect(isValidLifecycleId("")).toBe(false)
    expect(isValidLifecycleId(".starts-dot")).toBe(false)
    expect(isValidLifecycleId("-starts-dash")).toBe(false)
    expect(isValidLifecycleId("_starts-underscore")).toBe(false)
    expect(isValidLifecycleId("has space")).toBe(false)
    expect(isValidLifecycleId("has/slash")).toBe(false)
    expect(isValidLifecycleId("a".repeat(65))).toBe(false)
    expect(isValidLifecycleId("has\ttab")).toBe(false)
  })

  test("Given path helpers When called with invalid ids Then they throw StateRootContainmentError", () => {
    const root = { canonicalPath: "/test", displayPath: "/test" } as unknown as Parameters<
      typeof directiveActivationPath
    >[0]
    expect(() => directiveActivationPath(root, ".bad")).toThrow("state_root_escaped")
    expect(() => continuationCounterPath(root, "/nested")).toThrow("state_root_escaped")
    expect(() => modelChainProvenancePath(root, "")).toThrow("state_root_escaped")
  })
})
