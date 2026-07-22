import { createHash } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { z } from "zod"
import { atomicReplace } from "./atomic-file"
import type { CanonicalRoot } from "./domain"
import {
  identitiesFromTaskFacts,
  isFutureLifecycleRecord,
  migrateLifecycleRecord,
} from "./migration-records"
import { ensureStatePathContained, statePaths } from "./paths"
import { type Deadline, deadlineAfter, RepoLock } from "./repo-lock"

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/)
const ItemSchema = z.strictObject({
  path: z.string().min(1),
  sourceHash: HashSchema,
  targetHash: HashSchema,
})
const PhaseSchema = z.enum([
  "prepared",
  "backing_up",
  "backed_up",
  "staged",
  "publishing",
  "committed",
])
const JournalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  phase: PhaseSchema,
  items: z.array(ItemSchema).min(1).readonly(),
  published: z.array(z.string().min(1)).readonly(),
})
const CommitMarkerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  complete: z.literal(true),
  items: z
    .array(z.strictObject({ path: z.string().min(1), hash: HashSchema }))
    .min(1)
    .readonly(),
})

type MigrationJournal = z.infer<typeof JournalSchema>

export type MigrationBoundary =
  | "prepared"
  | "backing_up"
  | "backed_up"
  | "staged"
  | "publishing"
  | "commit_marker"
  | "committed"
  | `backup:${string}`
  | `staged:${string}`
  | `published:${string}`
export type MigrationResult =
  | { readonly ok: true; readonly status: "migrated" | "already_current" }
  | {
      readonly ok: false
      readonly code:
        | "migration_interrupted"
        | "migration_recovery_required"
        | "unknown_schema_version"
    }
export type RecoveryResult =
  | { readonly ok: true; readonly status: "restored" | "finalized" | "not_needed" }
  | { readonly ok: false; readonly code: "migration_recovery_required" }

function hash(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function crash(
  callback: ((boundary: MigrationBoundary) => void) | undefined,
  boundary: MigrationBoundary,
): void {
  callback?.(boundary)
}

function rank(path: string): number {
  if (path === "active.json") return 5
  if (path.startsWith("teams/")) return 3
  if (path.startsWith("runs/") || path.startsWith("events/")) return 2
  return 1
}

function ordered<T extends { readonly path: string }>(items: readonly T[]): readonly T[] {
  return [...items].sort(
    (left, right) => rank(left.path) - rank(right.path) || left.path.localeCompare(right.path),
  )
}

function isLifecyclePath(path: string): boolean {
  return (
    path === "active.json" ||
    /^runs\/[0-9a-f-]+\/run\.json$/.test(path) ||
    /^events\/\d{16}-[0-9a-f-]+\.json$/.test(path) ||
    /^task-facts\/[0-9a-f-]+\.json$/.test(path) ||
    /^worker-acceptance\/[0-9a-f-]+(?:\.wal\.jsonl|\.json)$/.test(path) ||
    /^worker-rejections\/[0-9a-f-]+\.json$/.test(path) ||
    /^teams\/[a-z0-9-]+\.json$/.test(path)
  )
}

function migrationPaths(root: CanonicalRoot): {
  readonly journal: string
  readonly backup: string
  readonly staged: string
} {
  const directory = join(statePaths(root).root, "migration")
  return {
    journal: join(directory, "journal.json"),
    backup: join(directory, "backup"),
    staged: join(directory, "staged"),
  }
}

async function sourceFiles(root: string, directory = root): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    if (entry.name === "migration" || entry.name === "state.lock" || entry.name.includes(".tmp-"))
      continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await sourceFiles(root, path)))
    if (entry.isFile()) result.push(relative(root, path).replaceAll("\\", "/"))
  }
  return result
}

async function writeJournal(
  root: CanonicalRoot,
  journal: MigrationJournal,
  deadline: Deadline,
): Promise<void> {
  await atomicReplace(migrationPaths(root).journal, JSON.stringify(journal), {
    deadline,
    guard: (path) => ensureStatePathContained(root, path),
  })
}

async function readJournal(root: CanonicalRoot): Promise<"absent" | "invalid" | MigrationJournal> {
  try {
    const parsed = JournalSchema.safeParse(
      JSON.parse(await readFile(migrationPaths(root).journal, "utf8")),
    )
    if (
      !parsed.success ||
      new Set(parsed.data.items.map((item) => item.path)).size !== parsed.data.items.length
    )
      return "invalid"
    const known = new Set(parsed.data.items.map((item) => item.path))
    return parsed.data.published.every((path) => known.has(path)) ? parsed.data : "invalid"
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "absent"
    if (error instanceof SyntaxError) return "invalid"
    throw error
  }
}

async function verified(path: string, expected: string): Promise<boolean> {
  try {
    return hash(await readFile(path, "utf8")) === expected
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function restore(
  root: CanonicalRoot,
  journal: MigrationJournal,
  deadline: Deadline,
): Promise<RecoveryResult> {
  const paths = migrationPaths(root)
  if (
    !(
      await Promise.all(
        journal.items.map((item) => verified(join(paths.backup, item.path), item.sourceHash)),
      )
    ).every(Boolean)
  )
    return { ok: false, code: "migration_recovery_required" }
  for (const item of ordered(journal.items)) {
    await atomicReplace(
      join(statePaths(root).root, item.path),
      await readFile(join(paths.backup, item.path), "utf8"),
      {
        deadline,
        guard: (path) => ensureStatePathContained(root, path),
      },
    )
  }
  const history = join(
    dirname(paths.journal),
    "history",
    `${Date.now()}-${crypto.randomUUID()}.json`,
  )
  await mkdir(dirname(history), { recursive: true })
  await copyFile(paths.journal, history)
  await rm(paths.journal)
  return { ok: true, status: "restored" }
}

async function discardUnpublishedJournal(
  root: CanonicalRoot,
  journal: MigrationJournal,
): Promise<RecoveryResult> {
  const paths = migrationPaths(root)
  const history = join(
    dirname(paths.journal),
    "history",
    `${Date.now()}-${crypto.randomUUID()}.json`,
  )
  await mkdir(dirname(history), { recursive: true })
  await atomicReplace(history, JSON.stringify(journal), {
    deadline: deadlineAfter(2_000),
    guard: (path) => ensureStatePathContained(root, path),
  })
  await rm(paths.journal)
  return { ok: true, status: "restored" }
}

async function finalize(
  root: CanonicalRoot,
  journal: MigrationJournal,
  deadline: Deadline,
): Promise<RecoveryResult> {
  const paths = migrationPaths(root)
  let rawMarker: unknown
  try {
    rawMarker = JSON.parse(await readFile(join(paths.staged, "commit.json"), "utf8"))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return restore(root, journal, deadline)
    if (error instanceof SyntaxError) return restore(root, journal, deadline)
    throw error
  }
  const marker = CommitMarkerSchema.safeParse(rawMarker)
  if (!marker.success || marker.data.items.length !== journal.items.length)
    return restore(root, journal, deadline)
  const marked = new Map(marker.data.items.map((item) => [item.path, item.hash]))
  const complete = await Promise.all(
    journal.items.map(
      async (item) =>
        (await verified(join(statePaths(root).root, item.path), item.targetHash)) &&
        marked.get(item.path) === item.targetHash,
    ),
  )
  if (!complete.every(Boolean)) return restore(root, journal, deadline)
  await writeJournal(root, { ...journal, phase: "committed" }, deadline)
  return { ok: true, status: "finalized" }
}

export async function recoverLifecycleMigration(root: CanonicalRoot): Promise<RecoveryResult> {
  const deadline = deadlineAfter(2_000)
  const state = statePaths(root)
  const handle = await new RepoLock(state.lock, (path) =>
    ensureStatePathContained(root, path),
  ).tryAcquire({
    deadline,
    purpose: "command",
    sessionId: "migration-recovery",
    maxWaitMs: deadline.remainingMs(),
  })
  if (handle === null) return { ok: false, code: "migration_recovery_required" }
  try {
    const journal = await readJournal(root)
    if (journal === "absent") return { ok: true, status: "not_needed" }
    if (journal === "invalid") return { ok: false, code: "migration_recovery_required" }
    if (journal.phase === "backing_up") return discardUnpublishedJournal(root, journal)
    if (journal.phase === "committed") return finalize(root, journal, deadline)
    return await finalize(root, journal, deadline)
  } finally {
    await handle.release()
  }
}

export async function migrateLifecycleState(request: {
  readonly root: CanonicalRoot
  readonly deadline?: Deadline
  readonly crash?: (boundary: MigrationBoundary) => void
}): Promise<MigrationResult> {
  const deadline = request.deadline ?? deadlineAfter(2_000)
  const state = statePaths(request.root)
  const handle = await new RepoLock(state.lock, (path) =>
    ensureStatePathContained(request.root, path),
  ).tryAcquire({
    deadline,
    purpose: "command",
    sessionId: "migration",
    maxWaitMs: deadline.remainingMs(),
  })
  if (handle === null) return { ok: false, code: "migration_recovery_required" }
  try {
    const prior = await readJournal(request.root)
    if (prior === "invalid") return { ok: false, code: "migration_recovery_required" }
    if (prior !== "absent") {
      if (prior.phase !== "committed") return { ok: false, code: "migration_recovery_required" }
      const finalized = await finalize(request.root, prior, deadline)
      return finalized.ok
        ? { ok: true, status: "already_current" }
        : { ok: false, code: "migration_recovery_required" }
    }
    const names = await sourceFiles(state.root)
    if (names.length === 0 || names.some((path) => !isLifecyclePath(path)))
      return { ok: false, code: "migration_recovery_required" }
    const source = await Promise.all(
      names.map(async (path) => ({ path, bytes: await readFile(join(state.root, path), "utf8") })),
    )
    if (source.some((item) => isFutureLifecycleRecord(item.bytes)))
      return { ok: false, code: "unknown_schema_version" }
    const identities = identitiesFromTaskFacts(source)
    if (identities === null) return { ok: false, code: "migration_recovery_required" }
    const converted = source.map((item) => ({
      path: item.path,
      source: item.bytes,
      result: migrateLifecycleRecord(item.path, item.bytes, identities),
    }))
    if (converted.some((item) => item.result.kind === "invalid"))
      return { ok: false, code: "migration_recovery_required" }
    if (converted.every((item) => item.result.kind === "current"))
      return { ok: true, status: "already_current" }
    if (converted.some((item) => item.result.kind === "current"))
      return { ok: false, code: "migration_recovery_required" }
    const targets = converted.flatMap((item) =>
      item.result.kind === "migrated"
        ? [{ path: item.path, source: item.source, bytes: item.result.bytes }]
        : [],
    )
    if (targets.length !== converted.length)
      return { ok: false, code: "migration_recovery_required" }
    const journal = JournalSchema.parse({
      schemaVersion: 1,
      phase: "prepared",
      items: targets.map((item) => ({
        path: item.path,
        sourceHash: hash(item.source),
        targetHash: hash(item.bytes),
      })),
      published: [],
    })
    await writeJournal(request.root, journal, deadline)
    crash(request.crash, "prepared")
    const paths = migrationPaths(request.root)
    await writeJournal(request.root, { ...journal, phase: "backing_up" }, deadline)
    crash(request.crash, "backing_up")
    for (const item of journal.items) {
      const destination = join(paths.backup, item.path)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(join(state.root, item.path), destination)
      if (!(await verified(destination, item.sourceHash)))
        return { ok: false, code: "migration_recovery_required" }
      crash(request.crash, `backup:${item.path}`)
    }
    await writeJournal(request.root, { ...journal, phase: "backed_up" }, deadline)
    crash(request.crash, "backed_up")
    for (const item of targets) {
      const destination = join(paths.staged, item.path)
      await atomicReplace(destination, item.bytes, {
        deadline,
        guard: (path) => ensureStatePathContained(request.root, path),
      })
      if (!(await verified(destination, hash(item.bytes))))
        return { ok: false, code: "migration_recovery_required" }
      crash(request.crash, `staged:${item.path}`)
    }
    await writeJournal(request.root, { ...journal, phase: "staged" }, deadline)
    crash(request.crash, "staged")
    let publishing = { ...journal, phase: "publishing" as const }
    await writeJournal(request.root, publishing, deadline)
    crash(request.crash, "publishing")
    for (const item of ordered(targets)) {
      await atomicReplace(join(state.root, item.path), item.bytes, {
        deadline,
        guard: (path) => ensureStatePathContained(request.root, path),
      })
      publishing = { ...publishing, published: [...publishing.published, item.path] }
      await writeJournal(request.root, publishing, deadline)
      crash(request.crash, `published:${item.path}`)
    }
    await atomicReplace(
      join(paths.staged, "commit.json"),
      JSON.stringify({
        schemaVersion: 1,
        complete: true,
        items: journal.items.map((item) => ({ path: item.path, hash: item.targetHash })),
      }),
      { deadline, guard: (path) => ensureStatePathContained(request.root, path) },
    )
    crash(request.crash, "commit_marker")
    await writeJournal(request.root, { ...publishing, phase: "committed" }, deadline)
    crash(request.crash, "committed")
    return { ok: true, status: "migrated" }
  } catch {
    return { ok: false, code: "migration_interrupted" }
  } finally {
    await handle.release()
  }
}

export async function removeLifecycleMigrationArtifacts(root: CanonicalRoot): Promise<void> {
  await rm(dirname(migrationPaths(root).journal), { recursive: true, force: true })
}
