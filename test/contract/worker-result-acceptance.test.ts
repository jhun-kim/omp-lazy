import { afterEach, describe, expect, test } from "bun:test"
import { copyFile, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { migrateLifecycleState } from "../../src/state/migration"
import {
  ARTIFACT_FILE_CASES,
  OUTPUT_BINDING_CASES,
  RECEIPT_BINDING_CASES,
} from "../fixtures/worker-acceptance-cases"
import {
  type AcceptanceRuntime,
  acceptanceBytes,
  acceptanceRuntime,
  removeRuntime,
  writeEvidence,
} from "../fixtures/worker-acceptance-fixtures"

const runtimes: AcceptanceRuntime[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(removeRuntime))
})

async function runtime(label: string): Promise<AcceptanceRuntime> {
  const value = await acceptanceRuntime(label)
  runtimes.push(value)
  return value
}

async function rejectWithoutAcceptance(
  value: AcceptanceRuntime,
  receiptPath: string,
  expectedCode: string,
): Promise<void> {
  const beforeBytes = await acceptanceBytes(value)
  const beforeRun = await value.store.readRun(value.run.runId)

  const result = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    { agentId: value.agentId, receiptPath },
  )

  expect(result).toMatchObject({ code: expectedCode })
  expect(await acceptanceBytes(value)).toBe(beforeBytes)
  expect((await value.store.readRun(value.run.runId))?.revision).toBe(beforeRun?.revision)
}

test("Given current parent-bound evidence When accepted Then one durable receipt is recorded", async () => {
  const value = await runtime("valid")
  const evidence = await writeEvidence(value)
  const before = await value.store.readRun(value.run.runId)

  const result = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    { agentId: value.agentId, receiptPath: evidence.receiptPath },
  )

  expect(result.kind).toBe("accepted")
  expect(await value.acceptance.acceptanceLedger.entries(value.run.runId)).toHaveLength(1)
  expect((await value.store.readRun(value.run.runId))?.revision).toBe(before?.revision)
})

describe("artifact containment", () => {
  test.each(
    ARTIFACT_FILE_CASES,
  )("Given a %s evidence file When submitted Then acceptance bytes stay unchanged", async (_name, mutate, code) => {
    const value = await runtime(`path-${_name.replaceAll(" ", "-")}`)
    const files = await writeEvidence(value)
    const receiptPath = await mutate(value, files)

    await rejectWithoutAcceptance(value, receiptPath, code)
  })

  test.each([
    "traversal",
    "sibling-prefix",
  ])("Given a %s artifact claim When submitted Then lexical containment rejects it", async (kind) => {
    const value = await runtime(`path-${kind}`)
    const initial = await writeEvidence(value)
    const evidenceRoot = dirname(initial.artifactPath)
    const outside =
      kind === "traversal"
        ? join(evidenceRoot, "..", "outside.txt")
        : join(`${evidenceRoot}-sibling`, "outside.txt")
    await mkdir(dirname(outside), { recursive: true })
    await writeFile(outside, "escape\n")
    const files = await writeEvidence(value, {
      artifactClaimPath: relative(value.displayPath, outside),
    })

    await rejectWithoutAcceptance(value, files.receiptPath, "invalid_artifact")
  })

  test("Given a symlink escape When submitted Then realpath containment rejects it", async () => {
    const value = await runtime("path-symlink")
    const files = await writeEvidence(value)
    const outside = join(value.displayPath, ".omo", "outside.txt")
    await writeFile(outside, "escape\n")
    await rm(files.artifactPath)
    try {
      await symlink(outside, files.artifactPath, "file")
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") {
        expect(await acceptanceBytes(value)).toBeNull()
        return
      }
      throw error
    }

    await rejectWithoutAcceptance(value, files.receiptPath, "invalid_artifact")
  })

  test("Given the attempt evidence root escapes by symlink When submitted Then repository containment rejects it", async () => {
    const value = await runtime("root-symlink")
    const files = await writeEvidence(value)
    const evidenceRoot = dirname(files.artifactPath)
    const outside = join(dirname(value.displayPath), `${basename(value.displayPath)}-evidence`)
    await rename(evidenceRoot, outside)
    try {
      await symlink(outside, evidenceRoot, "junction")
    } catch (error) {
      await rm(outside, { recursive: true, force: true })
      if (error instanceof Error && "code" in error && error.code === "EPERM") return
      throw error
    }
    try {
      await rejectWithoutAcceptance(value, files.receiptPath, "invalid_receipt_file")
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe("authoritative receipt bindings", () => {
  test.each(
    RECEIPT_BINDING_CASES,
  )("Given a wrong %s binding When submitted Then it cannot accept", async (_name, overrides, code) => {
    const value = await runtime(`binding-${_name.replaceAll(" ", "-")}`)
    const files = await writeEvidence(value, overrides(value))

    await rejectWithoutAcceptance(value, files.receiptPath, code)
  })

  test.each(
    OUTPUT_BINDING_CASES,
  )("Given %s worker output When submitted Then it cannot accept", async (_name, output, code) => {
    const value = await runtime(`output-${_name.replaceAll(" ", "-")}`)
    const files = await writeEvidence(value, { output })

    await rejectWithoutAcceptance(value, files.receiptPath, code)
  })

  test("Given a cleanup claim without its receipt When submitted Then it cannot accept", async () => {
    const value = await runtime("cleanup-missing")
    const files = await writeEvidence(value)
    await rm(files.cleanupPath)

    await rejectWithoutAcceptance(value, files.receiptPath, "invalid_cleanup_receipt")
  })
})

test.each([
  "dirty-worktree",
  "changed-head",
])("Given a %s after capture When submitted Then Git binding rejects without acceptance", async (kind) => {
  const value = await runtime(`git-${kind}`)
  const files = await writeEvidence(value)
  await writeFile(join(value.displayPath, "tracked.txt"), `${kind}\n`)
  if (kind === "changed-head") {
    const committed = Bun.spawnSync(
      ["git", "-C", value.displayPath, "commit", "--quiet", "-am", "advance head"],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(committed.exitCode).toBe(0)
  }

  await rejectWithoutAcceptance(
    value,
    files.receiptPath,
    kind === "changed-head" ? "wrong_capture_commit" : "dirty_worktree",
  )
})

test("Given malformed tool input or a declining parent decision When submitted Then neither can accept", async () => {
  const value = await runtime("malformed-tool")
  const files = await writeEvidence(value)

  const malformed = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    { agentId: value.agentId, receiptPath: files.receiptPath, unknown: true },
  )
  const declined = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    { agentId: value.agentId, receiptPath: files.receiptPath, parentDecision: "cancel_dispatch" },
  )

  expect(malformed).toMatchObject({ kind: "rejected", code: "malformed_payload" })
  expect(declined).toMatchObject({ kind: "rejected", code: "parent_declined_acceptance" })
  expect(await acceptanceBytes(value)).toBeNull()
})

test("Given three rejected submissions When a valid result arrives Then parent review is mandatory", async () => {
  const value = await runtime("retry-cap")
  const files = await writeEvidence(value)
  await writeFile(files.artifactPath, "")

  const attempts = []
  for (let index = 0; index < 3; index += 1) {
    attempts.push(
      await value.acceptance.accept(
        { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
        { agentId: value.agentId, receiptPath: files.receiptPath },
      ),
    )
  }
  await writeFile(files.artifactPath, "verified after review\n")
  const capped = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    { agentId: value.agentId, receiptPath: files.receiptPath },
  )
  const decided = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    {
      agentId: value.agentId,
      receiptPath: files.receiptPath,
      parentDecision: "accept_after_review",
    },
  )

  expect(attempts.map((attempt) => attempt.kind)).toEqual([
    "rejected",
    "rejected",
    "needs_parent_decision",
  ])
  expect(capped).toMatchObject({ kind: "needs_parent_decision", rejectionCount: 3 })
  expect(decided.kind).toBe("accepted")
})

test("Given exact and conflicting receipt replays When submitted Then acceptance never churns", async () => {
  const value = await runtime("replay")
  const files = await writeEvidence(value)
  const input = { agentId: value.agentId, receiptPath: files.receiptPath }
  await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    input,
  )
  const firstBytes = await acceptanceBytes(value)
  const replay = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    input,
  )
  const copiedPath = join(dirname(files.artifactPath), "receipt-copy.json")
  await copyFile(join(dirname(files.artifactPath), "receipt.json"), copiedPath)
  const duplicate = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    { agentId: value.agentId, receiptPath: relative(value.displayPath, copiedPath) },
  )

  expect(replay.kind).toBe("replayed")
  expect(duplicate).toMatchObject({ kind: "rejected", code: "duplicate_receipt" })
  expect(await acceptanceBytes(value)).toBe(firstBytes)
  expect(JSON.parse(firstBytes ?? "").entries).toHaveLength(1)
})

test("Given migrated state When runtime rejects a worker Then the full semantic identity is persisted", async () => {
  // Given
  const value = await runtime("migrated-rejection-identity")
  expect(await migrateLifecycleState({ root: value.store.root })).toEqual({
    ok: true,
    status: "migrated",
  })
  const files = await writeEvidence(value)
  await writeFile(files.artifactPath, "")

  // When
  const result = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    { agentId: value.agentId, receiptPath: files.receiptPath },
  )
  const ledger = JSON.parse(
    await readFile(value.acceptance.acceptanceLedger.rejectionPath(value.run.runId), "utf8"),
  )

  // Then
  expect(result).toMatchObject({ kind: "rejected", rejectionCount: 1 })
  expect(ledger).toMatchObject({
    schemaVersion: 2,
    entries: [
      {
        runId: value.run.runId,
        taskId: "worker",
        taskGeneration: 2,
        role: value.role,
        semanticAttempt: value.run.progressRevision,
      },
    ],
  })
})

test("Given migrated state When runtime accepts a worker Then snapshot and WAL remain v2", async () => {
  // Given
  const value = await runtime("migrated-acceptance-envelope")
  expect(await migrateLifecycleState({ root: value.store.root })).toEqual({
    ok: true,
    status: "migrated",
  })
  const files = await writeEvidence(value)

  // When
  const result = await value.acceptance.accept(
    { sessionId: value.run.owner.sessionId, cwd: value.displayPath },
    { agentId: value.agentId, receiptPath: files.receiptPath },
  )
  const snapshot = JSON.parse(
    await readFile(value.acceptance.acceptanceLedger.acceptancePath(value.run.runId), "utf8"),
  )
  const wal = JSON.parse(
    (
      await readFile(value.acceptance.acceptanceLedger.acceptanceWalPath(value.run.runId), "utf8")
    ).trim(),
  )

  // Then
  expect(result.kind).toBe("accepted")
  expect(snapshot).toMatchObject({
    schemaVersion: 2,
    entries: [{ taskId: "worker", role: value.role, semanticAttempt: value.run.progressRevision }],
  })
  expect(wal).toMatchObject({
    schemaVersion: 2,
    taskId: "worker",
    role: value.role,
    semanticAttempt: value.run.progressRevision,
  })
})
