import { createHash } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { atomicReplace } from "./atomic-file"
import type { CanonicalRoot } from "./domain"
import { ensureStatePathContained, statePaths } from "./paths"
import { type Deadline, deadlineAfter, RepoLock } from "./repo-lock"

type JsonValue =
  | boolean
  | null
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }
type JsonRecord = {
  readonly schemaVersion?: JsonValue
  readonly status?: JsonValue
  readonly expected?: JsonValue
  readonly entries?: JsonValue
  readonly items?: JsonValue
  readonly published?: JsonValue
  readonly phase?: JsonValue
  readonly path?: JsonValue
  readonly hash?: JsonValue
  readonly [key: string]: JsonValue
}
type MigrationPhase = "prepared" | "backed_up" | "staged" | "publishing" | "committed"

type MigrationItem = {
  readonly path: string
  readonly hash: string
}

type MigrationJournal = {
  readonly schemaVersion: 1
  readonly phase: MigrationPhase
  readonly items: readonly MigrationItem[]
  readonly published: readonly string[]
}

export type MigrationBoundary =
  | "prepared"
  | "backed_up"
  | "staged"
  | "publishing"
  | "commit_marker"
  | "committed"
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

function isRecord(value: JsonValue): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isSchemaVersion(value: JsonRecord): number | null {
  const candidate = value.schemaVersion
  return typeof candidate === "number" && Number.isInteger(candidate) ? candidate : null
}

function parseJson(bytes: string): JsonValue | null {
  try {
    const value: unknown = JSON.parse(bytes)
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "string"
    ) {
      return value
    }
    if (Array.isArray(value)) return value as readonly JsonValue[]
    if (typeof value === "object") return value as JsonRecord
    return null
  } catch {
    return null
  }
}

function v2Record(path: string, value: JsonRecord): JsonRecord | null {
  const version = isSchemaVersion(value)
  if (version === 2) return value
  if (version !== 1) return null
  if (path === "active.json") return { ...value, schemaVersion: 2, migrationRevision: 1 }
  if (path.startsWith("teams/") && value.status === "active") {
    return { ...value, schemaVersion: 2, status: "bound" }
  }
  if (path.startsWith("events/")) {
    const currentExpected = value.expected
    const expected =
      currentExpected !== undefined && isRecord(currentExpected)
        ? { ...currentExpected, expectedHead: null, taskGeneration: null }
        : (currentExpected ?? null)
    return { ...value, schemaVersion: 2, expected, legacyAuditOnly: true }
  }
  if (path.startsWith("runs/")) {
    return {
      ...value,
      schemaVersion: 2,
      packetHash: null,
      expectedHead: null,
      taskGeneration: null,
    }
  }
  if (path.startsWith("task-facts/")) {
    return { ...value, schemaVersion: 2, packetHash: null, tier: null, reservationId: null }
  }
  if (path.startsWith("worker-acceptance/") || path.startsWith("worker-rejections/")) {
    const entries = value.entries
    if (Array.isArray(entries) && entries.length > 0) return null
    return { ...value, schemaVersion: 2 }
  }
  return { ...value, schemaVersion: 2 }
}

function migrateBytes(path: string, bytes: string): string | null {
  if (path.endsWith(".jsonl")) {
    const lines = bytes.split("\n").filter((line) => line.length > 0)
    if (lines.length > 0) return null
    return bytes
  }
  const parsed = parseJson(bytes)
  if (parsed === null || !isRecord(parsed)) return null
  const migrated = v2Record(path, parsed)
  return migrated === null ? null : JSON.stringify(migrated)
}

async function files(root: string, directory = root): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.name === "migration" || entry.name === "state.lock" || entry.name.includes(".tmp-"))
      continue
    if (entry.isDirectory()) result.push(...(await files(root, path)))
    if (entry.isFile()) result.push(relative(root, path).replaceAll("\\", "/"))
  }
  return result
}

function ordered(items: readonly string[]): readonly string[] {
  return [...items].sort((left, right) => {
    const rank = (path: string): number => {
      if (path === "active.json") return 4
      if (path.startsWith("runs/") || path.startsWith("events/")) return 2
      if (path.startsWith("teams/")) return 3
      return 1
    }
    return rank(left) - rank(right) || left.localeCompare(right)
  })
}

function paths(root: CanonicalRoot): {
  readonly journal: string
  readonly backup: string
  readonly staged: string
} {
  const migration = join(statePaths(root).root, "migration")
  return {
    journal: join(migration, "journal.json"),
    backup: join(migration, "backup"),
    staged: join(migration, "staged"),
  }
}

async function writeJournal(
  root: CanonicalRoot,
  journal: MigrationJournal,
  deadline: Deadline,
): Promise<void> {
  const destination = paths(root).journal
  await atomicReplace(destination, JSON.stringify(journal), {
    deadline,
    guard: (path) => ensureStatePathContained(root, path),
  })
}

async function readJournal(root: CanonicalRoot): Promise<MigrationJournal | null> {
  try {
    const parsed = parseJson(await readFile(paths(root).journal, "utf8"))
    if (!isRecord(parsed)) return null
    const schemaVersion = parsed.schemaVersion
    const rawItems = parsed.items
    const rawPublished = parsed.published
    if (schemaVersion !== 1 || !Array.isArray(rawItems) || !Array.isArray(rawPublished)) return null
    const phase = parsed.phase
    if (
      phase !== "prepared" &&
      phase !== "backed_up" &&
      phase !== "staged" &&
      phase !== "publishing" &&
      phase !== "committed"
    )
      return null
    const items = rawItems.flatMap((item) => {
      if (!isRecord(item)) return []
      const path = item.path
      const itemHash = item.hash
      return typeof path === "string" && typeof itemHash === "string"
        ? [{ path, hash: itemHash }]
        : []
    })
    if (items.length !== rawItems.length) return null
    const published = rawPublished.filter((item): item is string => typeof item === "string")
    if (published.length !== rawPublished.length) return null
    return { schemaVersion: 1, phase, items, published }
  } catch {
    return null
  }
}

async function copyBackup(root: CanonicalRoot, item: MigrationItem): Promise<boolean> {
  const source = join(statePaths(root).root, item.path)
  const destination = join(paths(root).backup, item.path)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
  return hash(await readFile(destination, "utf8")) === item.hash
}

async function restore(
  root: CanonicalRoot,
  journal: MigrationJournal,
  deadline: Deadline,
): Promise<RecoveryResult> {
  for (const item of journal.items) {
    const backup = join(paths(root).backup, item.path)
    try {
      if (hash(await readFile(backup, "utf8")) !== item.hash)
        return { ok: false, code: "migration_recovery_required" }
    } catch {
      return { ok: false, code: "migration_recovery_required" }
    }
  }
  for (const item of ordered(journal.items.map((item) => item.path))) {
    const backup = join(paths(root).backup, item)
    await atomicReplace(join(statePaths(root).root, item), await readFile(backup, "utf8"), {
      deadline,
      guard: (path) => ensureStatePathContained(root, path),
    })
  }
  return { ok: true, status: "restored" }
}

export async function recoverLifecycleMigration(root: CanonicalRoot): Promise<RecoveryResult> {
  const deadline = deadlineAfter(2_000)
  const state = statePaths(root)
  const lock = new RepoLock(state.lock, (path) => ensureStatePathContained(root, path))
  const handle = await lock.tryAcquire({
    deadline,
    purpose: "command",
    sessionId: "migration-recovery",
    maxWaitMs: deadline.remainingMs(),
  })
  if (handle === null) return { ok: false, code: "migration_recovery_required" }
  try {
    const journal = await readJournal(root)
    if (journal === null) return { ok: true, status: "not_needed" }
    if (journal.phase === "committed") return { ok: true, status: "finalized" }
    return restore(root, journal, deadline)
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
  const lock = new RepoLock(state.lock, (path) => ensureStatePathContained(request.root, path))
  const handle = await lock.tryAcquire({
    deadline,
    purpose: "command",
    sessionId: "migration",
    maxWaitMs: deadline.remainingMs(),
  })
  if (handle === null) return { ok: false, code: "migration_recovery_required" }
  try {
    const existing = await readJournal(request.root)
    if (existing !== null && existing.phase !== "committed")
      return { ok: false, code: "migration_recovery_required" }
    const source = ordered(await files(state.root))
    const originals = await Promise.all(
      source.map(async (path) => ({ path, bytes: await readFile(join(state.root, path), "utf8") })),
    )
    const versioned = originals.filter(
      ({ path }) => path.endsWith(".json") || path.endsWith(".jsonl"),
    )
    const migrated = versioned.map(({ path, bytes }) => ({
      path,
      bytes: migrateBytes(path, bytes),
    }))
    if (migrated.some((item) => item.bytes === null)) {
      const future = originals.some(({ bytes }) => {
        const value = parseJson(bytes)
        return isRecord(value) && (isSchemaVersion(value) ?? 0) > 2
      })
      return { ok: false, code: future ? "unknown_schema_version" : "migration_recovery_required" }
    }
    if (
      migrated.every(
        (item) =>
          item.bytes === originals.find((sourceItem) => sourceItem.path === item.path)?.bytes,
      )
    ) {
      return { ok: true, status: "already_current" }
    }
    const journal: MigrationJournal = {
      schemaVersion: 1,
      phase: "prepared",
      items: originals.map(({ path, bytes }) => ({ path, hash: hash(bytes) })),
      published: [],
    }
    await writeJournal(request.root, journal, deadline)
    request.crash?.("prepared")
    if (
      !(await Promise.all(journal.items.map((item) => copyBackup(request.root, item)))).every(
        Boolean,
      )
    )
      return { ok: false, code: "migration_recovery_required" }
    await writeJournal(request.root, { ...journal, phase: "backed_up" }, deadline)
    request.crash?.("backed_up")
    for (const item of migrated) {
      const bytes = item.bytes
      if (bytes === null) return { ok: false, code: "migration_recovery_required" }
      const stage = join(paths(request.root).staged, item.path)
      await atomicReplace(stage, bytes, {
        deadline,
        guard: (path) => ensureStatePathContained(request.root, path),
      })
      if (hash(await readFile(stage, "utf8")) !== hash(bytes))
        return { ok: false, code: "migration_recovery_required" }
    }
    await writeJournal(request.root, { ...journal, phase: "staged" }, deadline)
    request.crash?.("staged")
    let publishing: MigrationJournal = { ...journal, phase: "publishing" }
    await writeJournal(request.root, publishing, deadline)
    request.crash?.("publishing")
    for (const item of migrated) {
      await atomicReplace(
        join(state.root, item.path),
        await readFile(join(paths(request.root).staged, item.path), "utf8"),
        { deadline, guard: (path) => ensureStatePathContained(request.root, path) },
      )
      publishing = { ...publishing, published: [...publishing.published, item.path] }
      await writeJournal(request.root, publishing, deadline)
      request.crash?.(`published:${item.path}`)
    }
    await atomicReplace(
      join(paths(request.root).staged, "commit.json"),
      JSON.stringify({ schemaVersion: 1, complete: true }),
      { deadline, guard: (path) => ensureStatePathContained(request.root, path) },
    )
    request.crash?.("commit_marker")
    await writeJournal(request.root, { ...publishing, phase: "committed" }, deadline)
    request.crash?.("committed")
    return { ok: true, status: "migrated" }
  } catch {
    return { ok: false, code: "migration_interrupted" }
  } finally {
    await handle.release()
  }
}

export async function removeLifecycleMigrationArtifacts(root: CanonicalRoot): Promise<void> {
  const migration = dirname(paths(root).journal)
  await rm(migration, { recursive: true, force: true })
}
